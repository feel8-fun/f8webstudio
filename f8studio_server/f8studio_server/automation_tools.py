from __future__ import annotations

import asyncio
import logging
from typing import cast

import msgspec
from f8pysdk.specs import F8JsonValue, F8StateAccess, state_is_persistent
from f8studio_core.graph import HistoryRequest, PatchRequest, PatchResult, RevisionConflictError, SetNodeStateOp, StudioDocument
from f8studio_core.graph.spec_edit import validate_spec_snapshot
from f8studio_core.graph.models import OperatorNode, ServiceNode
from f8studio_core.graph.runtime_hosts import STUDIO_SERVICE_CLASS, STUDIO_SERVICE_ID
from f8studio_core.publication import capture_component, component_document, decode_component
from f8studio_core.publication.insertion import prepare_component_insertion

from .catalog import CatalogService, CatalogSnapshot
from .jobs import DeployCoordinator
from .models import CreateCatalogNodeRequest, DeployJob, DeployProjectRequest, ProjectRecord, ProjectSummary
from .monitors import RuntimeMonitorStore
from .projects import ProjectService
from .runtime import RuntimeGateway
from .project_commits import ProjectCommits
from .assets import AssetKind, AssetRecord, AssetRepository, CaptureComponentRequest, CreateAssetRequest, UpdateAssetRequest
from .variant_models import CaptureVariantRequest
from .variants import capture_variant, variant_node
from .component_models import ComponentPreview, ComponentPreviewIssue, ComponentSource, InsertComponentRequest, InsertComponentResult
from .errors import InvalidRequestError

logger = logging.getLogger(__name__)


def _json_value(value: object) -> F8JsonValue:
    return cast(F8JsonValue, msgspec.to_builtins(value, str_keys=True))


class StudioAutomationTools:
    """Single application-service boundary used by HTTP, agents, CLI, and MCP."""

    def __init__(
        self,
        *,
        catalog: CatalogService,
        projects: ProjectService,
        jobs: DeployCoordinator,
        monitors: RuntimeMonitorStore,
        commits: ProjectCommits,
        runtime: RuntimeGateway,
        assets: AssetRepository,
    ) -> None:
        self._catalog = catalog
        self._projects = projects
        self._jobs = jobs
        self._monitors = monitors
        self._commits = commits
        self._runtime = runtime
        self._assets = assets

    def capture_component(self, project_id: str, request: CaptureComponentRequest) -> AssetRecord:
        document = self._projects.document(project_id)
        if (document.graph_revision, document.layout_revision) != (request.expected_graph_revision, request.expected_layout_revision):
            raise RevisionConflictError("project changed before component capture; refresh and retry")
        try:
            component = capture_component(document, node_ids=request.node_ids, excluded_states=request.excluded_states)
        except ValueError as exc:
            raise InvalidRequestError(f"cannot capture component: {exc}") from exc
        return self._assets.create(CreateAssetRequest(kind=AssetKind.component, name=request.name,
            description=request.description, tags=request.tags, content=_json_value(component)))

    def capture_variant(self, project_id: str, request: CaptureVariantRequest) -> AssetRecord:
        document = self._projects.document(project_id)
        if (document.graph_revision, document.layout_revision) != (request.expected_graph_revision, request.expected_layout_revision):
            raise RevisionConflictError("project changed before Variant capture; refresh and retry")
        if (request.asset_id is None) != (request.expected_version is None):
            raise InvalidRequestError("updating a Variant requires assetId and expectedVersion together")
        try:
            template = capture_variant(document, request.node_id, request.excluded_states)
        except ValueError as exc:
            raise InvalidRequestError(f"cannot save Variant: {exc}") from exc
        content = _json_value(template)
        source = (project_id, request.node_id)
        if request.asset_id is None:
            return self._assets.create(CreateAssetRequest(kind=AssetKind.variant, name=request.name, description=request.description,
                tags=request.tags, content=content), node_source=source)
        existing = self._assets.get(request.asset_id)
        if existing.kind is not AssetKind.variant:
            raise InvalidRequestError("update target must be a node Variant")
        previous = variant_node(decode_component(msgspec.json.encode(existing.content)))
        captured = variant_node(template)
        previous_operator = previous.operator_class if isinstance(previous, OperatorNode) else None
        captured_operator = captured.operator_class if isinstance(captured, OperatorNode) else None
        if type(previous) is not type(captured) or previous.service_class != captured.service_class or previous_operator != captured_operator:
            raise InvalidRequestError("a Variant's service/operator class cannot change; save a new Variant instead")
        return self._assets.update(existing.asset_id, UpdateAssetRequest(name=request.name, description=request.description,
            tags=request.tags, content=content, expected_version=request.expected_version), node_source=source)

    def component_preview(self, asset_id: str, version: int) -> ComponentPreview:
        if self._assets.kind(asset_id) not in (AssetKind.component, AssetKind.variant):
            raise InvalidRequestError("asset must be a Component or node Variant")
        content = self._assets.version(asset_id, version).content
        try:
            component = decode_component(msgspec.json.encode(content))
        except ValueError as exc:
            raise InvalidRequestError(f"invalid component content: {exc}") from exc
        document = component_document(component)
        issues: list[ComponentPreviewIssue] = []
        for node in document.nodes:
            try:
                installed = self._catalog.spec_for_node(node)
            except KeyError:
                issues.append(ComponentPreviewIssue(code="missing_definition", node_id=node.node_id,
                    message=f"Install the extension defining {node.service_class}/{node.operator_class if isinstance(node, OperatorNode) else 'service'} before insertion; preview uses embedded definitions."))
                continue
            try:
                validate_spec_snapshot(installed, node.spec)
            except ValueError as exc:
                issues.append(ComponentPreviewIssue(code="incompatible_definition", node_id=node.node_id, message=str(exc)))
        return ComponentPreview(asset_id=asset_id, version=version, component=component, document=document, issues=tuple(issues))

    def _prepare_component(self, project_id: str, request: InsertComponentRequest) -> tuple[PatchRequest, ComponentSource]:
        preview = self.component_preview(request.asset_id, request.version)
        if not preview.component.presentation.node_order:
            raise InvalidRequestError("component has no template nodes to insert")
        if preview.issues:
            raise InvalidRequestError("; ".join(issue.message for issue in preview.issues))
        document = self._projects.document(project_id)
        if (document.graph_revision, document.layout_revision) != (request.expected_graph_revision, request.expected_layout_revision):
            raise RevisionConflictError("project changed before component insertion; refresh and retry")
        asset = self._assets.get(request.asset_id)
        builtin_host: ServiceNode | None = None
        if any(binding.service_class == STUDIO_SERVICE_CLASS for binding in preview.component.host_bindings):
            if not any(isinstance(node, ServiceNode) and node.service_id == STUDIO_SERVICE_ID for node in document.nodes):
                host = self._catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id=STUDIO_SERVICE_ID, service_class=STUDIO_SERVICE_CLASS))
                if not isinstance(host, ServiceNode):
                    raise TypeError("builtin Studio descriptor must create a service")
                builtin_host = host
                document = msgspec.structs.replace(document, nodes=(*document.nodes, host))
        try:
            insertion = prepare_component_insertion(preview.component, document, request_id=request.request_id,
                host_bindings=request.host_bindings, x=request.x, y=request.y, host_offsets=request.host_offsets)
        except ValueError as exc:
            raise InvalidRequestError(f"cannot insert component: {exc}") from exc
        if asset.kind is AssetKind.variant:
            variant_nodes = tuple(msgspec.structs.replace(node, name=asset.name) for node in insertion.fragment.nodes)
            insertion = msgspec.structs.replace(insertion, fragment=msgspec.structs.replace(insertion.fragment, nodes=variant_nodes))
        if builtin_host is not None:
            insertion = msgspec.structs.replace(insertion, fragment=msgspec.structs.replace(
                insertion.fragment, nodes=(builtin_host, *insertion.fragment.nodes)))
        source = ComponentSource(asset_id=request.asset_id, version=request.version, node_map=insertion.node_map,
            edge_map=insertion.edge_map, host_bindings=insertion.host_bindings, endpoints=insertion.endpoints)
        patch = PatchRequest(request_id=request.request_id, expected_graph_revision=request.expected_graph_revision,
            expected_layout_revision=request.expected_layout_revision, operations=(insertion.fragment,))
        return patch, source

    def preview_component_insertion(self, project_id: str, request: InsertComponentRequest) -> InsertComponentResult:
        patch, source = self._prepare_component(project_id, request)
        return InsertComponentResult(patch=self._projects.preview_patch(project_id, patch), source=source)

    async def insert_component(self, project_id: str, request: InsertComponentRequest) -> InsertComponentResult:
        async with self._commits.lock(project_id):
            replay = await asyncio.to_thread(self._projects.replay_component_insertion, project_id, request)
            if replay is not None:
                return replay
            patch, source = await asyncio.to_thread(self._prepare_component, project_id, request)
            mutation = await asyncio.to_thread(self._projects.insert_component, project_id, patch, source=source, original=request)
            result = mutation.result if mutation.replayed else await self._commits.publish(project_id, mutation.result)
            return InsertComponentResult(patch=result, source=source)

    def catalog(self) -> CatalogSnapshot:
        return self._catalog.snapshot()

    def project(self, project_id: str) -> ProjectRecord:
        return self._projects.get(project_id)

    def project_summary(self, project_id: str) -> ProjectSummary:
        return self._projects.summary(project_id)

    def document(self, project_id: str) -> StudioDocument:
        return self._projects.document(project_id)

    def preview_patch(self, project_id: str, request: PatchRequest) -> PatchResult:
        return self._projects.preview_patch(project_id, request)

    async def apply_patch(self, project_id: str, request: PatchRequest) -> PatchResult:
        async with self._commits.lock(project_id):
            mutation = await asyncio.to_thread(self._projects.patch, project_id, request)
            result = mutation.result
            if mutation.replayed:
                return result
            changes = [operation for operation in request.operations if isinstance(operation, SetNodeStateOp)]
            if not changes:
                return await self._commits.publish(project_id, result)
            try:
                nodes = {node.node_id: node for node in result.document.nodes}
                errors: list[str] = []
                for change in changes:
                    node = nodes.get(change.node_id)
                    if node is None:
                        continue
                    fields = () if isinstance(node.spec.stateFields, msgspec.UnsetType) else node.spec.stateFields
                    field = next((field for field in fields if field.name == change.field), None)
                    if field is None or field.access == F8StateAccess.ro:
                        continue
                    try:
                        if state_is_persistent(field) and not await self._jobs.state_is_deployed(
                            project_id, service_id=node.service_id, node_id=node.node_id, field=change.field,
                        ):
                            continue
                        response = await self._runtime.set_state(
                            node.service_id, node_id=node.node_id, field=change.field, value=change.value,
                        )
                        if not response.success:
                            errors.append(f"{node.node_id}.{change.field}: {response.error_message or 'runtime rejected state'}")
                    except (TimeoutError, OSError, RuntimeError, ValueError) as exc:
                        logger.exception("runtime state sync failed project_id=%s node_id=%s field=%s", project_id, node.node_id, change.field)
                        errors.append(f"{node.node_id}.{change.field}: {type(exc).__name__}: {exc}")
                result = msgspec.structs.replace(result, runtime_errors=tuple(errors)) if errors else result
            except asyncio.CancelledError:
                result = msgspec.structs.replace(result, runtime_errors=("Runtime state synchronization cancelled",))
                raise
            finally:
                if result.graph_changed or result.layout_changed:
                    await self._commits.publish(project_id, result)
            return result

    async def undo(self, project_id: str, request: HistoryRequest) -> PatchResult:
        async with self._commits.lock(project_id):
            mutation = await asyncio.to_thread(self._projects.undo, project_id, request)
            return mutation.result if mutation.replayed else await self._commits.publish(project_id, mutation.result)

    async def redo(self, project_id: str, request: HistoryRequest) -> PatchResult:
        async with self._commits.lock(project_id):
            mutation = await asyncio.to_thread(self._projects.redo, project_id, request)
            return mutation.result if mutation.replayed else await self._commits.publish(project_id, mutation.result)

    def validate_document(self, document: StudioDocument) -> None:
        self._projects.validate(document)

    async def deploy(self, project_id: str, request: DeployProjectRequest) -> DeployJob:
        return await self._jobs.submit(project_id, request)

    async def deployment(self, job_id: str) -> DeployJob:
        return await self._jobs.get(job_id)

    async def monitor_snapshot(self, project_id: str | None = None) -> F8JsonValue:
        snapshots = await self._monitors.snapshot()
        if project_id is not None:
            document = await asyncio.to_thread(self._projects.document, project_id)
            service_ids = {node.service_id for node in document.nodes}
            snapshots = tuple(snapshot for snapshot in snapshots if str(snapshot.serviceId) in service_ids)
        return _json_value(snapshots)



__all__ = ["StudioAutomationTools"]
