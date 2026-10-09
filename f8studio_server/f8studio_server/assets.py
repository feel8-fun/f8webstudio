from __future__ import annotations

from f8studio_server.errors import InvalidRequestError, NotFoundError

import enum
import logging
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from contextlib import AbstractContextManager

from .database import database_text as _text
from .database import database_integer as _integer
from .database import database_bytes as _bytes
from .database import StudioDatabase
from typing import cast
from collections.abc import Callable
from uuid import uuid4

import msgspec

from f8pysdk.f8_naming import ensure_token
from f8pysdk.specs import F8JsonValue, F8ServiceSpec, F8OperatorSpec, state_is_publishable
from f8studio_core.graph import GraphEdge, NodeLayout, OperatorNode, ServiceNode, StudioDocument, validate_document
from f8studio_core.graph.models import DOCUMENT_SCHEMA_VERSION, GraphNode
from f8studio_core.graph.state_policy import ExcludedState, apply_installed_state_policy, project_document_for_sharing, upgrade_document
from f8studio_core.graph.codec import decode_document
from f8studio_core.graph.codec import canonical_json_bytes
from f8studio_core.graph.spec_edit import validate_spec_snapshot
from f8studio_core.graph.validation import validate_state_value
from f8studio_core.publication import capture_component, component_document, decode_component
from .variant_models import VariantSummary
from .variants import variant_node
from f8studio_core.graph import RevisionConflictError


ASSET_SCHEMA_VERSION = "f8studio-asset/1"
COMPONENT_SCHEMA_VERSION = "f8studio-component/2"
VARIANT_SCHEMA_VERSION = "f8studio-variant/1"

logger = logging.getLogger(__name__)


class AssetKind(str, enum.Enum):
    component = "component"
    variant = "variant"
    preset = "preset"
    modding_recipe = "modding_recipe"


class ApplicationContent(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    schema_version: str = COMPONENT_SCHEMA_VERSION
    nodes: tuple[GraphNode, ...] = ()
    edges: tuple[GraphEdge, ...] = ()
    layout: tuple[NodeLayout, ...] = ()


class VariantContent(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    schema_version: str = VARIANT_SCHEMA_VERSION
    service_class: str
    operator_class: str | None = None
    state_values: dict[str, F8JsonValue] = msgspec.field(default_factory=dict)


class AssetSummary(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    asset_id: str
    kind: AssetKind
    name: str
    description: str
    tags: tuple[str, ...]
    current_version: int
    created_at: str
    updated_at: str


class AssetRecord(AssetSummary, frozen=True, kw_only=True, rename="camel"):
    content: F8JsonValue


class AssetVersion(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    asset_id: str
    version: int
    created_at: str
    content: F8JsonValue


class CreateAssetRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    kind: AssetKind
    name: str
    content: F8JsonValue
    description: str = ""
    tags: tuple[str, ...] = ()
    asset_id: str | None = None


class UpdateAssetRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    name: str
    content: F8JsonValue
    description: str = ""
    tags: tuple[str, ...] = ()
    expected_version: int | None = None


class AssetExport(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    schema_version: str
    asset: AssetRecord
    versions: tuple[AssetVersion, ...]


class ProjectVersion(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    version_id: str
    project_id: str
    name: str
    created_at: str
    document: StudioDocument


class CreateProjectVersionRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    name: str = "Snapshot"


class ShareGraphRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    expected_graph_revision: int
    expected_layout_revision: int
    excluded_states: tuple[ExcludedState, ...] = ()


class CaptureComponentRequest(ShareGraphRequest, frozen=True, kw_only=True):
    name: str = "Component"
    node_ids: tuple[str, ...] | None = None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")





def _json(value: object) -> F8JsonValue:
    return cast(F8JsonValue, msgspec.to_builtins(value, str_keys=True))


def _normalize_tags(tags: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(tag.strip() for tag in tags if tag.strip()))


SpecResolver = Callable[[str, str | None], F8ServiceSpec | F8OperatorSpec]


def _validate_content(kind: AssetKind, content: F8JsonValue, *,
                      spec_resolver: SpecResolver | None = None) -> F8JsonValue:
    encoded = msgspec.json.encode(content)
    if kind is AssetKind.component or (kind is AssetKind.variant and isinstance(content, dict) and content.get("format") == "f8component"):
        if isinstance(content, dict) and content.get("format") == "f8component":
            try:
                portable = decode_component(encoded)
            except ValueError as exc:
                raise InvalidRequestError(f"invalid portable component: {exc}") from exc
            document = component_document(portable)
            if spec_resolver is not None:
                updated: list[GraphNode] = []
                for node in document.nodes:
                    try:
                        installed = spec_resolver(node.service_class, node.operator_class if isinstance(node, OperatorNode) else None)
                    except KeyError:
                        logger.warning("Component implementation unavailable for node=%s service=%s; retaining embedded definition",
                                       node.node_id, node.service_class, exc_info=True)
                        updated.append(node)
                        continue
                    node = apply_installed_state_policy(node, installed)
                    try:
                        validate_spec_snapshot(installed, node.spec)
                    except ValueError:
                        logger.warning("Component definition incompatible for node=%s service=%s; preserving sanitized snapshot for preview",
                                       node.node_id, node.service_class, exc_info=True)
                    updated.append(node)
                document = msgspec.structs.replace(document, nodes=tuple(updated))
            try:
                cleaned = capture_component(document, node_ids=tuple(portable.presentation.node_order) or None)
            except ValueError as exc:
                raise InvalidRequestError(f"cannot normalize portable component: {exc}") from exc
            cleaned = msgspec.structs.replace(cleaned, endpoints=portable.endpoints)
            if kind is AssetKind.variant:
                try:
                    variant_node(cleaned)
                except ValueError as exc:
                    raise InvalidRequestError(str(exc)) from exc
            return _json(cleaned)
        component = msgspec.json.decode(encoded, type=ApplicationContent)
        if component.schema_version not in ("f8studio-component/1", COMPONENT_SCHEMA_VERSION):
            raise InvalidRequestError(f"unsupported component schema: {component.schema_version}")
        node_ids = {node.node_id for node in component.nodes}
        if len(node_ids) != len(component.nodes):
            raise InvalidRequestError("component node ids must be unique")
        if any(edge.from_node_id not in node_ids or edge.to_node_id not in node_ids for edge in component.edges):
            raise InvalidRequestError("component edges must reference component nodes")
        layout_ids = [layout.node_id for layout in component.layout]
        if len(set(layout_ids)) != len(layout_ids):
            raise InvalidRequestError("component layout node ids must be unique")
        if any(node_id not in node_ids for node_id in layout_ids):
            raise InvalidRequestError("component layout must reference component nodes")
        service_classes = {
            node.service_id: node.service_class
            for node in component.nodes
            if isinstance(node, ServiceNode)
        }
        if len(service_classes) != sum(isinstance(node, ServiceNode) for node in component.nodes):
            raise InvalidRequestError("component service ids must be unique")
        for node in component.nodes:
            if not isinstance(node, OperatorNode):
                continue
            service_class = service_classes.get(node.service_id)
            if service_class is None:
                raise InvalidRequestError("component operators must reference component services")
            if service_class != node.service_class:
                raise InvalidRequestError("component operator and service classes must match")
        document = StudioDocument(
            schema_version="f8studio-document/2" if component.schema_version == "f8studio-component/1" else DOCUMENT_SCHEMA_VERSION,
            project_id="component", graph_id="component", graph_revision=0, layout_revision=0, nodes=component.nodes,
            edges=component.edges, layout=component.layout,
        )
        document = upgrade_document(document)
        if spec_resolver is not None:
            normalized: list[GraphNode] = []
            for node in document.nodes:
                try:
                    installed = spec_resolver(node.service_class, node.operator_class if isinstance(node, OperatorNode) else None)
                except KeyError:
                    logger.warning("Component definition unavailable for node=%s service_class=%s; using embedded publication policy",
                                   node.node_id, node.service_class, exc_info=True)
                    normalized.append(node)
                    continue
                node = apply_installed_state_policy(node, installed)
                validate_spec_snapshot(installed, node.spec)
                normalized.append(node)
            document = msgspec.structs.replace(document, nodes=tuple(normalized))
        shared = project_document_for_sharing(document)
        return _json(ApplicationContent(nodes=shared.nodes, edges=shared.edges, layout=shared.layout))
    if kind in (AssetKind.variant, AssetKind.preset):
        variant = msgspec.json.decode(encoded, type=VariantContent)
        if variant.schema_version != VARIANT_SCHEMA_VERSION:
            raise InvalidRequestError(f"unsupported variant schema: {variant.schema_version}")
        if not variant.service_class.strip():
            raise InvalidRequestError("variant serviceClass must be non-empty")
        if variant.state_values:
            if spec_resolver is None:
                raise InvalidRequestError("variant state values require an installed definition to check publication policy")
            try:
                spec = spec_resolver(variant.service_class, variant.operator_class)
            except KeyError as exc:
                raise InvalidRequestError(
                    f"cannot check variant publication policy: install the extension defining {variant.service_class}/{variant.operator_class or 'service'}",
                ) from exc
            fields = () if isinstance(spec.stateFields, msgspec.UnsetType) else spec.stateFields
            indexed = {field.name: field for field in fields}
            unknown = set(variant.state_values) - set(indexed)
            if unknown:
                raise InvalidRequestError(f"unknown variant state fields: {', '.join(sorted(unknown))}")
            variant = msgspec.structs.replace(variant, state_values={
                name: value for name, value in variant.state_values.items() if state_is_publishable(indexed[name])
            })
            for name, value in variant.state_values.items():
                validate_state_value(indexed[name], value, path=f"variant.{name}")
        return _json(variant)
    if not isinstance(content, dict):
        raise InvalidRequestError("modding recipe content must be an object")
    schema = content.get("schemaVersion")
    if not isinstance(schema, str) or not schema.strip():
        raise InvalidRequestError("modding recipe content requires schemaVersion")
    return content


class AssetRepository:
    def __init__(self, database_path: Path | StudioDatabase, *, spec_resolver: SpecResolver | None = None) -> None:
        self._spec_resolver = spec_resolver
        self._database = database_path if isinstance(database_path, StudioDatabase) else StudioDatabase(database_path)
        self._database_path = self._database.path
        self._initialize()

    def _connect(self) -> AbstractContextManager[sqlite3.Connection]:
        return self._database.connection()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS local_assets (
                    asset_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    tags BLOB NOT NULL,
                    current_version INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS local_asset_versions (
                    asset_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    content BLOB NOT NULL,
                    PRIMARY KEY(asset_id, version),
                    FOREIGN KEY(asset_id) REFERENCES local_assets(asset_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS project_versions (
                    version_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    document BLOB NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS project_versions_project
                    ON project_versions(project_id, created_at DESC);
                """
            )
            # Existing parameter-only variants remain readable as Presets, with all versions intact.
            rows = connection.execute("""SELECT a.asset_id, v.content FROM local_assets a JOIN local_asset_versions v
                ON v.asset_id = a.asset_id AND v.version = a.current_version WHERE a.kind = 'variant'""").fetchall()
            for asset_id, payload in rows:
                content: F8JsonValue = msgspec.json.decode(_bytes(payload), type=F8JsonValue)
                if isinstance(content, dict) and content.get("schemaVersion") == VARIANT_SCHEMA_VERSION:
                    connection.execute("UPDATE local_assets SET kind = 'preset' WHERE asset_id = ?", (_text(asset_id),))

    def list_assets(self, kind: AssetKind | None = None) -> tuple[AssetSummary, ...]:
        query = """SELECT asset_id, kind, name, description, tags, current_version, created_at, updated_at
                   FROM local_assets"""
        params: tuple[str, ...] = ()
        if kind is not None:
            query += " WHERE kind = ?"
            params = (kind.value,)
        query += " ORDER BY lower(name), asset_id"
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return tuple(self._summary(row) for row in rows)

    def create(self, request: CreateAssetRequest, *, node_source: tuple[str, str] | None = None) -> AssetRecord:
        asset_id = ensure_token(request.asset_id or uuid4().hex, label="asset_id")
        name = request.name.strip()
        if not name:
            raise InvalidRequestError("asset name must be non-empty")
        content = _validate_content(request.kind, request.content, spec_resolver=self._spec_resolver)
        kind = AssetKind.preset if request.kind is AssetKind.variant and isinstance(content, dict) and content.get("schemaVersion") == VARIANT_SCHEMA_VERSION else request.kind
        timestamp = _now()
        tags = _normalize_tags(request.tags)
        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """INSERT INTO local_assets(
                           asset_id, kind, name, description, tags, current_version, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)""",
                    (asset_id, kind.value, name, request.description, msgspec.json.encode(tags), timestamp, timestamp),
                )
                connection.execute(
                    "INSERT INTO local_asset_versions(asset_id, version, created_at, content) VALUES (?, 1, ?, ?)",
                    (asset_id, timestamp, msgspec.json.encode(content)),
                )
                if node_source is not None:
                    self._save_node_source(connection, node_source, asset_id, 1)
        except sqlite3.IntegrityError as exc:
            if exc.sqlite_errorcode not in (sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY, sqlite3.SQLITE_CONSTRAINT_UNIQUE):
                raise
            raise FileExistsError(f"asset already exists: {asset_id}") from exc
        return self.get(asset_id)

    def get(self, asset_id: str) -> AssetRecord:
        asset_id = ensure_token(asset_id, label="asset_id")
        with self._connect() as connection:
            row = connection.execute(
                """SELECT a.asset_id, a.kind, a.name, a.description, a.tags, a.current_version,
                          a.created_at, a.updated_at, v.content
                   FROM local_assets a JOIN local_asset_versions v
                     ON v.asset_id = a.asset_id AND v.version = a.current_version
                   WHERE a.asset_id = ?""",
                (asset_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"asset not found: {asset_id}")
        summary = self._summary(row[:8])
        return AssetRecord(
            asset_id=summary.asset_id,
            kind=summary.kind,
            name=summary.name,
            description=summary.description,
            tags=summary.tags,
            current_version=summary.current_version,
            created_at=summary.created_at,
            updated_at=summary.updated_at,
            content=_validate_content(summary.kind, msgspec.json.decode(_bytes(row[8]), type=F8JsonValue), spec_resolver=self._spec_resolver),
        )

    def kind(self, asset_id: str) -> AssetKind:
        asset_id = ensure_token(asset_id, label="asset_id")
        with self._connect() as connection:
            row = connection.execute("SELECT kind FROM local_assets WHERE asset_id = ?", (asset_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"asset not found: {asset_id}")
        return AssetKind(_text(row[0]))

    def update(self, asset_id: str, request: UpdateAssetRequest, *, node_source: tuple[str, str] | None = None) -> AssetRecord:
        asset_id = ensure_token(asset_id, label="asset_id")
        name = request.name.strip()
        if not name:
            raise InvalidRequestError("asset name must be non-empty")
        timestamp = _now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                """SELECT a.kind, a.current_version, v.content FROM local_assets a JOIN local_asset_versions v
                   ON v.asset_id = a.asset_id AND v.version = a.current_version WHERE a.asset_id = ?""",
                (asset_id,),
            ).fetchone()
            if current is None:
                raise NotFoundError(f"asset not found: {asset_id}")
            if request.expected_version is not None and request.expected_version != _integer(current[1]):
                raise RevisionConflictError("asset changed before save; reload its latest version and retry")
            if AssetKind(_text(current[0])) is AssetKind.variant and request.expected_version is None:
                raise InvalidRequestError("saving a Variant requires expectedVersion")
            content = _validate_content(AssetKind(_text(current[0])), request.content, spec_resolver=self._spec_resolver)
            previous = _validate_content(AssetKind(_text(current[0])), msgspec.json.decode(_bytes(current[2]), type=F8JsonValue), spec_resolver=self._spec_resolver)
            if AssetKind(_text(current[0])) is AssetKind.variant:
                old_node = variant_node(decode_component(msgspec.json.encode(previous)))
                new_node = variant_node(decode_component(msgspec.json.encode(content)))
                old_operator = old_node.operator_class if isinstance(old_node, OperatorNode) else None
                new_operator = new_node.operator_class if isinstance(new_node, OperatorNode) else None
                if type(old_node) is not type(new_node) or old_node.service_class != new_node.service_class or old_operator != new_operator:
                    raise InvalidRequestError("a Variant's service/operator class cannot change; save a new Variant instead")
            changed = canonical_json_bytes(content) != canonical_json_bytes(previous)
            version = _integer(current[1]) + int(changed)
            connection.execute(
                """UPDATE local_assets SET name = ?, description = ?, tags = ?,
                       current_version = ?, updated_at = ? WHERE asset_id = ?""",
                (name, request.description, msgspec.json.encode(_normalize_tags(request.tags)), version, timestamp, asset_id),
            )
            if changed:
                connection.execute(
                    "INSERT INTO local_asset_versions(asset_id, version, created_at, content) VALUES (?, ?, ?, ?)",
                    (asset_id, version, timestamp, msgspec.json.encode(content)),
                )
            if node_source is not None:
                self._save_node_source(connection, node_source, asset_id, version)
        return self.get(asset_id)

    @staticmethod
    def _save_node_source(connection: sqlite3.Connection, source: tuple[str, str], asset_id: str, version: int) -> None:
        connection.execute("""INSERT INTO node_variants(project_id, node_id, asset_id, version) VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, node_id) DO UPDATE SET asset_id = excluded.asset_id, version = excluded.version""",
            (*source, asset_id, version))

    def variant_catalog(self) -> tuple[VariantSummary, ...]:
        summaries: list[VariantSummary] = []
        for asset in self.list_assets(AssetKind.variant):
            record = self.get(asset.asset_id)
            node = variant_node(decode_component(msgspec.json.encode(record.content)))
            summaries.append(VariantSummary(asset_id=asset.asset_id, name=asset.name, description=asset.description,
                tags=asset.tags, current_version=asset.current_version,
                node_kind="operator" if isinstance(node, OperatorNode) else "service", service_class=node.service_class,
                operator_class=node.operator_class if isinstance(node, OperatorNode) else None))
        return tuple(summaries)

    def delete(self, asset_id: str) -> None:
        asset_id = ensure_token(asset_id, label="asset_id")
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM local_assets WHERE asset_id = ?", (asset_id,))
            if cursor.rowcount != 1:
                raise NotFoundError(f"asset not found: {asset_id}")

    def versions(self, asset_id: str) -> tuple[AssetVersion, ...]:
        asset = self.get(asset_id)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT version, created_at, content FROM local_asset_versions WHERE asset_id = ? ORDER BY version DESC",
                (asset_id,),
            ).fetchall()
        return tuple(
            AssetVersion(
                asset_id=asset_id,
                version=_integer(row[0]),
                created_at=_text(row[1]),
                content=_validate_content(asset.kind, msgspec.json.decode(_bytes(row[2]), type=F8JsonValue), spec_resolver=self._spec_resolver),
            )
            for row in rows
        )

    def version(self, asset_id: str, version: int) -> AssetVersion:
        asset_id = ensure_token(asset_id, label="asset_id")
        with self._connect() as connection:
            row = connection.execute("""SELECT a.kind, v.created_at, v.content FROM local_asset_versions v
                JOIN local_assets a ON a.asset_id = v.asset_id WHERE v.asset_id = ? AND v.version = ?""",
                (asset_id, version)).fetchone()
        if row is None:
            raise NotFoundError(f"asset version not found: {asset_id}/v{version}")
        return AssetVersion(asset_id=asset_id, version=version, created_at=_text(row[1]),
            content=_validate_content(AssetKind(_text(row[0])), msgspec.json.decode(_bytes(row[2]), type=F8JsonValue),
                                      spec_resolver=self._spec_resolver))

    def export(self, asset_id: str) -> AssetExport:
        return AssetExport(schema_version=ASSET_SCHEMA_VERSION, asset=self.get(asset_id), versions=self.versions(asset_id))

    def import_asset(self, payload: AssetExport) -> AssetRecord:
        if payload.schema_version != ASSET_SCHEMA_VERSION:
            raise InvalidRequestError(f"unsupported asset export schema: {payload.schema_version}")
        asset = payload.asset
        if asset.kind is AssetKind.variant and isinstance(asset.content, dict) and asset.content.get("schemaVersion") == VARIANT_SCHEMA_VERSION:
            asset = msgspec.structs.replace(asset, kind=AssetKind.preset)
        asset_id = ensure_token(asset.asset_id, label="asset_id")
        if not asset.name.strip():
            raise InvalidRequestError("asset name must be non-empty")
        versions = tuple(sorted(payload.versions, key=lambda item: item.version))
        if not versions or versions[-1].version != asset.current_version:
            raise InvalidRequestError("asset export does not contain its current version")
        if len({version.version for version in versions}) != len(versions):
            raise InvalidRequestError("asset export contains duplicate versions")
        for version in versions:
            if version.asset_id != asset_id or version.version < 1:
                raise InvalidRequestError("asset export version identity is invalid")
        normalized = tuple(
            (version, _validate_content(asset.kind, version.content, spec_resolver=self._spec_resolver)) for version in versions
        )
        if normalized[-1][1] != _validate_content(asset.kind, asset.content, spec_resolver=self._spec_resolver):
            raise InvalidRequestError("asset current content does not match current version")
        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """INSERT INTO local_assets(
                           asset_id, kind, name, description, tags, current_version, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        asset_id,
                        asset.kind.value,
                        asset.name.strip(),
                        asset.description,
                        msgspec.json.encode(_normalize_tags(asset.tags)),
                        asset.current_version,
                        asset.created_at,
                        asset.updated_at,
                    ),
                )
                connection.executemany(
                    "INSERT INTO local_asset_versions(asset_id, version, created_at, content) VALUES (?, ?, ?, ?)",
                    tuple(
                        (asset_id, version.version, version.created_at, msgspec.json.encode(content))
                        for version, content in normalized
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise FileExistsError(f"asset already exists or export is invalid: {asset_id}") from exc
        return self.get(asset_id)

    def create_project_version(self, project_id: str, name: str, document: StudioDocument) -> ProjectVersion:
        validate_document(document)
        if document.project_id != project_id:
            raise InvalidRequestError("version document projectId does not match route project id")
        clean_name = name.strip() or "Snapshot"
        version = ProjectVersion(
            version_id=uuid4().hex,
            project_id=project_id,
            name=clean_name,
            created_at=_now(),
            document=document,
        )
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO project_versions(version_id, project_id, name, created_at, document) VALUES (?, ?, ?, ?, ?)",
                (version.version_id, project_id, version.name, version.created_at, msgspec.json.encode(document)),
            )
        return version

    def list_project_versions(self, project_id: str) -> tuple[ProjectVersion, ...]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT version_id, name, created_at, document FROM project_versions WHERE project_id = ? ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
        return tuple(
            ProjectVersion(
                version_id=_text(row[0]),
                project_id=project_id,
                name=_text(row[1]),
                created_at=_text(row[2]),
                document=decode_document(_bytes(row[3])),
            )
            for row in rows
        )

    def get_project_version(self, project_id: str, version_id: str) -> ProjectVersion:
        versions = self.list_project_versions(project_id)
        found = next((version for version in versions if version.version_id == version_id), None)
        if found is None:
            raise NotFoundError(f"project version not found: {version_id}")
        return found

    @staticmethod
    def _summary(row: tuple[object, ...]) -> AssetSummary:
        tags = msgspec.json.decode(_bytes(row[4]), type=tuple[str, ...])
        return AssetSummary(
            asset_id=_text(row[0]),
            kind=AssetKind(_text(row[1])),
            name=_text(row[2]),
            description=_text(row[3]),
            tags=tags,
            current_version=_integer(row[5]),
            created_at=_text(row[6]),
            updated_at=_text(row[7]),
        )


__all__ = [
    "ASSET_SCHEMA_VERSION",
    "AssetExport",
    "AssetKind",
    "AssetRecord",
    "AssetRepository",
    "AssetSummary",
    "AssetVersion",
    "ApplicationContent",
    "CreateAssetRequest",
    "CreateProjectVersionRequest",
    "ProjectVersion",
    "UpdateAssetRequest",
    "VariantContent",
]
