from __future__ import annotations

import msgspec
from f8pysdk.specs import F8StateAccess, state_is_persistent

from f8studio_core.graph.exchange import (
    EXCHANGE_VERSION, ExchangeMetadata, ExchangeService, GraphExchange, export_shared_graph, import_graph,
)
from f8studio_core.graph.models import GraphEdge, GraphEdgeKind, GraphNode, NodeLayout, OperatorNode, ServiceNode, StudioDocument
from f8studio_core.graph.state_policy import ExcludedState, upgrade_document
from f8studio_core.graph.validation import validate_document
from f8studio_core.graph.runtime_hosts import normalize_studio_hosts

from .models import ComponentEndpoint, HostBinding, PortableComponent


class _ComponentHeader(msgspec.Struct, kw_only=True, rename="camel"):
    schema_version: str | None = None


class _LegacyComponent(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    schema_version: str
    nodes: tuple[GraphNode, ...] = ()
    edges: tuple[GraphEdge, ...] = ()
    layout: tuple[NodeLayout, ...] = ()


def component_document(component: PortableComponent) -> StudioDocument:
    """Validate and produce a preview document with explicit synthetic host nodes.

Synthetic hosts are placeholders for validation/preview, never insertion targets.
No installed extension or runtime is required.
"""
    services = dict(component.services)
    bindings: set[str] = set()
    for binding in component.host_bindings:
        if not binding.binding_id.strip() or binding.binding_id in bindings or binding.binding_id in services or binding.binding_id in component.operators:
            raise ValueError(f"duplicate/invalid component host binding: {binding.binding_id}")
        spec = component.definitions.services.get(binding.definition_ref)
        if spec is None or spec.serviceClass != binding.service_class:
            raise ValueError(f"missing or mismatched definition for host binding: {binding.binding_id}")
        bindings.add(binding.binding_id)
        services[binding.binding_id] = ExchangeService(node_id=binding.binding_id,
            name=f"Host: {binding.service_class}", definition_ref=binding.definition_ref)
    node_ids = set(component.services) | set(component.operators)
    for edge in component.connections:
        if edge.from_node_id not in node_ids or edge.to_node_id not in node_ids:
            raise ValueError("component connections must reference template nodes, not external hosts")
    if any(item.node_id not in node_ids for item in component.presentation.layout):
        raise ValueError("component layout must reference template nodes")
    if len(component.presentation.node_order) != len(node_ids) or set(component.presentation.node_order) != node_ids:
        raise ValueError("component nodeOrder must list every template node once")
    used_bindings = {operator.service_id for operator in component.operators.values()} & bindings
    if used_bindings != bindings:
        raise ValueError("component contains unused host bindings")
    exchange = GraphExchange(format="f8graph", format_version=EXCHANGE_VERSION,
        metadata=ExchangeMetadata(graph_id="component", project_id="component"), definitions=component.definitions,
        services=services, operators=component.operators, connections=component.connections,
        presentation=msgspec.structs.replace(component.presentation, node_order=(*sorted(bindings), *component.presentation.node_order)))
    document = import_graph(msgspec.json.encode(exchange), component_preview=True)
    endpoints: set[str] = set()
    nodes = {node.node_id: node for node in document.nodes}
    for endpoint in component.endpoints:
        if not endpoint.endpoint_id.strip() or endpoint.endpoint_id in endpoints or endpoint.node_id not in node_ids:
            raise ValueError(f"duplicate/invalid component endpoint: {endpoint.endpoint_id}")
        endpoints.add(endpoint.endpoint_id)
        if not any(port.port_id == endpoint.port_id and port.direction is endpoint.direction for port in nodes[endpoint.node_id].ports):
            raise ValueError(f"component endpoint port not found: {endpoint.node_id}/{endpoint.port_id}")
    # Current contracts cannot carry private instance values, even in a forged import.
    cleaned = import_graph(export_shared_graph(document), component_preview=True)
    if cleaned.nodes != document.nodes:
        raise ValueError("component contains nonpublishable or upstream-bound instance values")
    return document


def capture_component(document: StudioDocument, *, node_ids: tuple[str, ...] | None = None,
                      excluded_states: tuple[ExcludedState, ...] = ()) -> PortableComponent:
    validate_document(document)
    selected = {node.node_id for node in document.nodes} if node_ids is None else set(node_ids)
    known = {node.node_id for node in document.nodes}
    if selected - known or (node_ids is not None and (not selected or len(selected) != len(node_ids))):
        raise ValueError("component selection must contain unique existing nodes")
    external_host_ids = {node.service_id for node in document.nodes
                         if isinstance(node, OperatorNode) and node.node_id in selected and node.service_id not in selected}
    # Re-evaluate publication state bindings using only retained edges. A cut upstream
    # connection must not discard the author's saved fallback configuration.
    retained = msgspec.structs.replace(document,
        nodes=tuple(msgspec.structs.replace(node, enabled=True, state_values={}) if node.node_id in external_host_ids else node
                    for node in document.nodes if node.node_id in selected | external_host_ids),
        edges=tuple(edge for edge in document.edges if edge.from_node_id in selected and edge.to_node_id in selected),
        layout=tuple(item for item in document.layout if item.node_id in selected))
    exchange = msgspec.json.decode(export_shared_graph(retained, excluded_states=excluded_states), type=GraphExchange)
    bindings = tuple(HostBinding(binding_id=node.node_id, service_class=node.service_class,
        definition_ref=exchange.services[node.node_id].definition_ref)
        for node in retained.nodes if isinstance(node, ServiceNode) and node.node_id in external_host_ids)
    endpoints: dict[tuple[str, str], ComponentEndpoint] = {}
    nodes = {node.node_id: node for node in retained.nodes}
    for edge in document.edges:
        if (edge.from_node_id in selected) == (edge.to_node_id in selected):
            continue
        node_id, port_id = ((edge.from_node_id, edge.from_port_id) if edge.from_node_id in selected else (edge.to_node_id, edge.to_port_id))
        port = next(port for port in nodes[node_id].ports if port.port_id == port_id)
        if edge.kind is GraphEdgeKind.state and edge.to_node_id == node_id and port.state_spec is not None:
            field = port.state_spec
            instance = exchange.operators[node_id] if node_id in exchange.operators else exchange.services[node_id]
            if (state_is_persistent(field) and field.access is not F8StateAccess.ro and field.valueRequired is True
                    and field.name not in instance.state_values and isinstance(field.valueSchema.default, msgspec.UnsetType)):
                raise ValueError(f"selection cuts required state input {node_id}.{field.name}; save an authored initial configuration or include its upstream node")
        if (node_id, port_id) not in endpoints:
            endpoints[(node_id, port_id)] = ComponentEndpoint(endpoint_id=f"endpoint_{len(endpoints)}",
                node_id=node_id, port_id=port_id, direction=port.direction)
    component = PortableComponent(definitions=exchange.definitions,
        services={key: value for key, value in exchange.services.items() if key in selected},
        operators=exchange.operators, connections=exchange.connections,
        presentation=msgspec.structs.replace(exchange.presentation,
            node_order=tuple(node.node_id for node in document.nodes if node.node_id in selected)),
        host_bindings=bindings, endpoints=tuple(endpoints.values()))
    component_document(component)
    return component


def decode_component(payload: bytes | str) -> PortableComponent:
    try:
        header = msgspec.json.decode(payload, type=_ComponentHeader)
        if header.schema_version is not None:
            legacy = msgspec.json.decode(payload, type=_LegacyComponent)
            if legacy.schema_version not in ("f8studio-component/1", "f8studio-component/2"):
                raise ValueError(f"unsupported legacy component: {legacy.schema_version}")
            document = StudioDocument(schema_version="f8studio-document/2" if legacy.schema_version.endswith("/1") else "f8studio-document/3",
                project_id="component", graph_id="component", graph_revision=0, layout_revision=0,
                nodes=legacy.nodes, edges=legacy.edges, layout=legacy.layout)
            return capture_component(normalize_studio_hosts(upgrade_document(document)))
        component = msgspec.json.decode(payload, type=PortableComponent)
    except msgspec.DecodeError as exc:
        raise ValueError(f"invalid portable component: {exc}") from exc
    component_document(component)
    return component
