"""Decode historical component schemas into current documents."""
from __future__ import annotations
import msgspec
from f8studio_core.graph.models import GraphNode, GraphEdge, NodeLayout, StudioDocument
from f8studio_core.graph.migrations import upgrade_document
from f8studio_core.graph.runtime_hosts import normalize_studio_hosts

class _LegacyComponent(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    schema_version: str
    nodes: tuple[GraphNode, ...] = ()
    edges: tuple[GraphEdge, ...] = ()
    layout: tuple[NodeLayout, ...] = ()


def upgrade_legacy_component(payload: bytes | str) -> StudioDocument:
    legacy = msgspec.json.decode(payload, type=_LegacyComponent)
    if legacy.schema_version not in ("f8studio-component/1", "f8studio-component/2"):
        raise ValueError(f"unsupported legacy component: {legacy.schema_version}")
    document = StudioDocument(
        schema_version="f8studio-document/2" if legacy.schema_version.endswith("/1") else "f8studio-document/3",
        project_id="component", graph_id="component", graph_revision=0, layout_revision=0,
        nodes=legacy.nodes, edges=legacy.edges, layout=legacy.layout,
    )
    return normalize_studio_hosts(upgrade_document(document))
