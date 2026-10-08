from __future__ import annotations

from typing import Literal

import msgspec

from f8studio_core.graph.exchange import ExchangeDefinitions, ExchangeOperator, ExchangePresentation, ExchangeService, GraphExchange
from f8studio_core.graph.models import GraphEdge, PortDirection


class PublicationSource(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    repository_url: str | None = None
    asset_id: str | None = None
    asset_version: int | None = None


class OperatorRequirement(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    service_class: str
    operator_class: str


class ExtensionRequirement(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    extension_id: str
    # Explicit finite compatibility set; () means any version. No guessed SemVer ranges.
    compatible_versions: tuple[str, ...] = ()
    service_classes: tuple[str, ...] = ()
    operators: tuple[OperatorRequirement, ...] = ()
    protocol_versions: tuple[str, ...] = ()
    capabilities: tuple[str, ...] = ()


class PublicationManifest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    schema_version: Literal["f8publication-manifest/1"] = "f8publication-manifest/1"
    kind: Literal["graph", "component"]
    content_format: Literal["f8graph", "f8component"]
    content_version: int
    license: str
    source: PublicationSource
    dependencies: tuple[ExtensionRequirement, ...]


class HostBinding(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    binding_id: str
    service_class: str
    definition_ref: str


class ComponentEndpoint(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    endpoint_id: str
    node_id: str
    port_id: str
    direction: PortDirection


class PortableComponent(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    format: Literal["f8component"] = "f8component"
    format_version: Literal[1] = 1
    definitions: ExchangeDefinitions
    services: dict[str, ExchangeService]
    operators: dict[str, ExchangeOperator]
    connections: tuple[GraphEdge, ...] = ()
    presentation: ExchangePresentation = msgspec.field(default_factory=ExchangePresentation)
    host_bindings: tuple[HostBinding, ...] = ()
    endpoints: tuple[ComponentEndpoint, ...] = ()


class GraphPublication(msgspec.Struct, frozen=True, kw_only=True, tag="graph", tag_field="kind", rename="camel", forbid_unknown_fields=True):
    schema_version: Literal["f8publication/1"] = "f8publication/1"
    manifest: PublicationManifest
    content: GraphExchange
    content_hash: str


class ComponentPublication(msgspec.Struct, frozen=True, kw_only=True, tag="component", tag_field="kind", rename="camel", forbid_unknown_fields=True):
    schema_version: Literal["f8publication/1"] = "f8publication/1"
    manifest: PublicationManifest
    content: PortableComponent
    content_hash: str


Publication = GraphPublication | ComponentPublication


class PublicationCapabilities(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    publication_versions: tuple[str, ...] = ("f8publication/1",)
    graph_versions: tuple[int, ...] = (3, 4)
    component_versions: tuple[int, ...] = (1,)
    legacy_component_versions: tuple[str, ...] = ("f8studio-component/1", "f8studio-component/2")
    hash_profiles: tuple[str, ...] = ("f8publication-hash/1",)
