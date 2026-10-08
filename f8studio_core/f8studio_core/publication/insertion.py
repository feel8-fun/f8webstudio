from __future__ import annotations

import hashlib
import math

import msgspec

from f8studio_core.graph.models import GraphNode, InsertFragmentOp, NodeLayout, ServiceNode, StudioDocument

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
    node_map = {node.node_id: new_id("service" if isinstance(node, ServiceNode) else "operator", node.node_id) for node in original}
    edge_map = {edge.edge_id: new_id("edge", edge.edge_id) for edge in component.connections}
    nodes: list[GraphNode] = []
    for node in original:
        node_id = node_map[node.node_id]
        service_id = node_id if isinstance(node, ServiceNode) else host_bindings[node.service_id] if node.service_id in required else node_map[node.service_id]
        nodes.append(msgspec.structs.replace(node, node_id=node_id, service_id=service_id))
    edges = tuple(msgspec.structs.replace(edge, edge_id=edge_map[edge.edge_id],
        from_node_id=node_map[edge.from_node_id], to_node_id=node_map[edge.to_node_id]) for edge in component.connections)
    by_layout = {layout.node_id: layout for layout in component.presentation.layout}
    layout: list[NodeLayout] = []
    for index, node in enumerate(original):
        position = by_layout.get(node.node_id, NodeLayout(node_id=node.node_id, x=20 + index * 20, y=80 + index * 20))
        layout.append(msgspec.structs.replace(position, node_id=node_map[node.node_id],
            x=position.x + x, y=position.y + y))
    endpoints = tuple(msgspec.structs.replace(endpoint, node_id=node_map[endpoint.node_id]) for endpoint in component.endpoints)
    return ComponentInsertion(fragment=InsertFragmentOp(nodes=tuple(nodes), edges=edges, layout=tuple(layout)),
        node_map=node_map, edge_map=edge_map, host_bindings=dict(host_bindings), endpoints=endpoints)
