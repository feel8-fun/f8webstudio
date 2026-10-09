from __future__ import annotations

import hashlib
import math

import msgspec

from f8studio_core.graph.models import GraphNode, InsertFragmentOp, NodeLayout, ServiceNode, StudioDocument
from f8studio_core.graph.runtime_hosts import STUDIO_SERVICE_CLASS, STUDIO_SERVICE_ID, validate_runtime_document

from .component import component_document
from .models import ComponentEndpoint, PortableComponent


class ComponentInsertion(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    fragment: InsertFragmentOp
    node_map: dict[str, str]
    edge_map: dict[str, str]
    host_bindings: dict[str, str]
    endpoints: tuple[ComponentEndpoint, ...]


def prepare_component_insertion(component: PortableComponent, target: StudioDocument, *, request_id: str,
                                host_bindings: dict[str, str], x: float = 40, y: float = 40) -> ComponentInsertion:
    if not request_id.strip() or not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("component insertion requires a request ID and finite position")
    validate_runtime_document(target)
    preview = component_document(component)
    required = {binding.binding_id: binding.service_class for binding in component.host_bindings}
    if set(host_bindings) != set(required):
        raise ValueError(f"provide exactly these component host bindings: {', '.join(sorted(required)) or '(none)'}")
    services = {node.node_id: node for node in target.nodes if isinstance(node, ServiceNode)}
    for binding_id, service_id in host_bindings.items():
        service = services.get(service_id)
        if service is None or service.service_class != required[binding_id]:
            raise ValueError(f"host binding {binding_id} requires an existing {required[binding_id]} service; got {service_id}")

    def new_id(kind: str, old_id: str) -> str:
        # Deterministic for a retry, distinct for another request/project/identity.
        seed = msgspec.json.encode((target.project_id, request_id, kind, old_id))
        return f"{kind}_{hashlib.sha256(seed).hexdigest()[:32]}"

    original = tuple(node for node in preview.nodes if node.node_id not in required)
    node_map: dict[str, str] = {}
    for node in original:
        if isinstance(node, ServiceNode) and node.service_class == STUDIO_SERVICE_CLASS:
            node_map[node.node_id] = STUDIO_SERVICE_ID
        else:
            node_map[node.node_id] = new_id("service" if isinstance(node, ServiceNode) else "operator", node.node_id)
    edge_map = {edge.edge_id: new_id("edge", edge.edge_id) for edge in component.connections}
    nodes: list[GraphNode] = []
    studio_host = services.get(STUDIO_SERVICE_ID)
    reused_hosts: dict[str, ServiceNode] = {}
    for node in original:
        node_id = node_map[node.node_id]
        if isinstance(node, ServiceNode) and node.service_class == STUDIO_SERVICE_CLASS:
            if studio_host is not None:
                reused_hosts[node.node_id] = studio_host
                continue
            studio_host = msgspec.structs.replace(node, node_id=STUDIO_SERVICE_ID, service_id=STUDIO_SERVICE_ID)
        if isinstance(node, ServiceNode):
            service_id = node_id
        elif node.service_id in required:
            service_id = host_bindings[node.service_id]
        else:
            service_id = node_map[node.service_id]
        nodes.append(msgspec.structs.replace(node, node_id=node_id, service_id=service_id))

    # Existing hosts own their port IDs and configuration. Map template wiring
    # by the runtime field/port identity instead of copying those instance IDs.
    port_map: dict[tuple[str, str], str] = {}
    for node in original:
        host = reused_hosts.get(node.node_id)
        if host is None:
            continue
        ports = {(port.kind, port.direction, port.runtime_name): port.port_id for port in host.ports}
        for port in node.ports:
            target_port = ports.get((port.kind, port.direction, port.runtime_name))
            if target_port is not None:
                port_map[(node.node_id, port.port_id)] = target_port

    def mapped_port(node_id: str, port_id: str) -> str:
        if node_id not in reused_hosts:
            return port_id
        result = port_map.get((node_id, port_id))
        if result is None:
            raise ValueError(f"existing Studio Runtime has no compatible port for {node_id}/{port_id}")
        return result

    edges = tuple(msgspec.structs.replace(edge, edge_id=edge_map[edge.edge_id],
        from_node_id=node_map[edge.from_node_id], to_node_id=node_map[edge.to_node_id],
        from_port_id=mapped_port(edge.from_node_id, edge.from_port_id),
        to_port_id=mapped_port(edge.to_node_id, edge.to_port_id)) for edge in component.connections)
    by_layout = {layout.node_id: layout for layout in component.presentation.layout}
    layout: list[NodeLayout] = []
    for index, node in enumerate(original):
        if node.node_id in reused_hosts:
            continue
        position = by_layout.get(node.node_id, NodeLayout(node_id=node.node_id, x=20 + index * 20, y=80 + index * 20))
        layout.append(msgspec.structs.replace(position, node_id=node_map[node.node_id],
            x=position.x + x, y=position.y + y))
    endpoints = tuple(msgspec.structs.replace(endpoint, node_id=node_map[endpoint.node_id],
        port_id=mapped_port(endpoint.node_id, endpoint.port_id)) for endpoint in component.endpoints)
    return ComponentInsertion(fragment=InsertFragmentOp(nodes=tuple(nodes), edges=edges, layout=tuple(layout)),
        node_map=node_map, edge_map=edge_map, host_bindings=dict(host_bindings), endpoints=endpoints)
