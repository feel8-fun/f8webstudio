from __future__ import annotations

from typing import cast

import msgspec

from f8pysdk.specs import F8JsonValue
from f8studio_core.graph.exchange import ExchangeMetadata, GraphExchange, export_shared_graph, import_graph
from f8studio_core.graph.models import StudioDocument
from f8studio_core.graph.state_policy import ExcludedState

from .canonical import HASH_PROFILE, hash_publication_value, publication_json_value
from .component import component_document
from .dependencies import validate_dependency_coverage
from .definitions import portable_definition_numbers
from .models import ComponentPublication, GraphPublication, PortableComponent, Publication, PublicationManifest


def _normalize_collections(value: dict[str, F8JsonValue]) -> None:
    """Sort only declared sets; arrays in schemas/config/code remain ordered."""
    connections = value.get("connections")
    if isinstance(connections, list):
        connections.sort(key=lambda item: str(cast(dict[str, F8JsonValue], item)["edgeId"]) if isinstance(item, dict) else "")
    presentation = value.get("presentation")
    if isinstance(presentation, dict) and isinstance(presentation.get("layout"), list):
        layout = cast(list[F8JsonValue], presentation["layout"])
        layout.sort(key=lambda item: str(item["nodeId"]) if isinstance(item, dict) else "")
    for key, id_field in (("hostBindings", "bindingId"), ("endpoints", "endpointId")):
        items = value.get(key)
        if isinstance(items, list):
            items.sort(key=lambda item: str(cast(dict[str, F8JsonValue], item)[id_field]) if isinstance(item, dict) else "")


def publication_hash(manifest: PublicationManifest, content: GraphExchange | PortableComponent) -> str:
    # Typed conversion expands model defaults before hashing. Local IDs never
    # participate, but node/port IDs and ordered presentation.nodeOrder do.
    normalized = cast(dict[str, F8JsonValue], publication_json_value(content))
    if isinstance(content, GraphExchange):
        normalized.pop("metadata")
    _normalize_collections(normalized)
    metadata = cast(dict[str, F8JsonValue], publication_json_value(manifest))
    dependencies = cast(list[dict[str, F8JsonValue]], metadata["dependencies"])
    dependencies.sort(key=lambda item: str(item["extensionId"]))
    for dependency in dependencies:
        for key in ("compatibleVersions", "serviceClasses", "protocolVersions", "capabilities"):
            items = dependency[key]
            if isinstance(items, list):
                items.sort(key=str)
        operators = cast(list[dict[str, F8JsonValue]], dependency["operators"])
        operators.sort(key=lambda item: (str(item["serviceClass"]), str(item["operatorClass"])))
    return hash_publication_value({"hashProfile": HASH_PROFILE, "manifest": metadata, "content": normalized})


def _validate_manifest(manifest: PublicationManifest, content: GraphExchange | PortableComponent) -> None:
    expected_kind = "graph" if isinstance(content, GraphExchange) else "component"
    if (manifest.kind, manifest.content_format, manifest.content_version) != (expected_kind, content.format, content.format_version):
        raise ValueError("manifest kind/content format/version do not match publication content")
    if not manifest.license.strip():
        raise ValueError("publication license must be explicit (use UNLICENSED when no reuse license is granted)")
    source = manifest.source
    if (source.asset_id is None) != (source.asset_version is None) or (source.asset_version is not None and source.asset_version < 1):
        raise ValueError("source asset ID and positive fixed version must be supplied together")
    if source.asset_id is not None and not source.asset_id.strip():
        raise ValueError("source asset ID must be nonempty")
    if source.repository_url is not None and not source.repository_url.startswith("https://"):
        raise ValueError("source repository URL must use HTTPS")
    validate_dependency_coverage(manifest.dependencies,
        {spec.serviceClass for spec in content.definitions.services.values()},
        {(spec.serviceClass, spec.operatorClass) for spec in content.definitions.operators.values()})


def create_graph_publication(document: StudioDocument, manifest: PublicationManifest, *,
                             excluded_states: tuple[ExcludedState, ...] = ()) -> GraphPublication:
    content = msgspec.json.decode(export_shared_graph(document, excluded_states=excluded_states), type=GraphExchange)
    content = portable_definition_numbers(content)
    # Published graph metadata is intentionally portable; import supplies local IDs.
    content = msgspec.structs.replace(content, metadata=ExchangeMetadata(project_id="published", graph_id="published"))
    _validate_manifest(manifest, content)
    return GraphPublication(manifest=manifest, content=content, content_hash=publication_hash(manifest, content))


def create_component_publication(content: PortableComponent, manifest: PublicationManifest) -> ComponentPublication:
    component_document(content)
    content = portable_definition_numbers(content)
    _validate_manifest(manifest, content)
    return ComponentPublication(manifest=manifest, content=content, content_hash=publication_hash(manifest, content))


def decode_publication(payload: bytes | str) -> Publication:
    try:
        publication = msgspec.json.decode(payload, type=Publication)
    except msgspec.DecodeError as exc:
        raise ValueError(f"invalid publication: {exc}") from exc
    _validate_manifest(publication.manifest, publication.content)
    if publication_hash(publication.manifest, publication.content) != publication.content_hash:
        raise ValueError("publication content hash mismatch")
    if isinstance(publication, GraphPublication):
        document = import_graph(msgspec.json.encode(publication.content))
        cleaned = import_graph(export_shared_graph(document))
        if cleaned.nodes != document.nodes:
            raise ValueError("graph publication contains nonpublishable or upstream-bound instance values")
    else:
        component_document(publication.content)
    return publication
