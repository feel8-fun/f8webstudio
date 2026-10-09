from __future__ import annotations

from typing import Literal
import msgspec

from f8studio_core.graph.state_policy import ExcludedState


class CaptureVariantRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    node_id: str
    expected_graph_revision: int
    expected_layout_revision: int
    name: str
    description: str = ""
    tags: tuple[str, ...] = ()
    excluded_states: tuple[ExcludedState, ...] = ()
    asset_id: str | None = None
    expected_version: int | None = None


class VariantSource(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    node_id: str
    asset_id: str
    version: int


class VariantSummary(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    asset_id: str
    name: str
    description: str
    tags: tuple[str, ...]
    current_version: int
    node_kind: Literal["service", "operator"]
    service_class: str
    operator_class: str | None = None
