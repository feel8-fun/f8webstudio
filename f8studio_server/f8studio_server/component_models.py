from __future__ import annotations

import msgspec

from f8studio_core.graph import PatchResult, StudioDocument
from f8studio_core.publication import ComponentEndpoint, PortableComponent


class InsertComponentRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    request_id: str
    expected_graph_revision: int
    expected_layout_revision: int
    asset_id: str
    version: int
    host_bindings: dict[str, str] = msgspec.field(default_factory=dict)
    x: float = 40
    y: float = 40


class ComponentSource(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    asset_id: str
    version: int
    node_map: dict[str, str]
    edge_map: dict[str, str]
    host_bindings: dict[str, str]
    endpoints: tuple[ComponentEndpoint, ...] = ()


class InsertComponentResult(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    patch: PatchResult
    source: ComponentSource


class ComponentPreviewIssue(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    code: str
    node_id: str
    message: str


class ComponentPreview(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    asset_id: str
    version: int
    component: PortableComponent
    document: StudioDocument
    issues: tuple[ComponentPreviewIssue, ...]
