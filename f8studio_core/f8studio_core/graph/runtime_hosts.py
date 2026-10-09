"""Builtin runtime identity rules for executable graphs, not component host aliases."""
from __future__ import annotations

import msgspec

from .models import GraphEdge, GraphNode, NodeLayout, OperatorNode, ServiceNode, StudioDocument
from .validation import GraphValidationError, validate_document

STUDIO_SERVICE_CLASS = "f8.pystudio"
STUDIO_SERVICE_ID = "studio"


def validate_runtime_document(document: StudioDocument) -> None:
    validate_document(document)
    for node in document.nodes:
        if node.node_id == STUDIO_SERVICE_ID and (
            not isinstance(node, ServiceNode) or node.service_class != STUDIO_SERVICE_CLASS
        ):
            raise GraphValidationError("reserved_studio_id", "node ID 'studio' is reserved for Web Studio Runtime")
        if isinstance(node, ServiceNode) and node.service_class == STUDIO_SERVICE_CLASS and node.node_id != STUDIO_SERVICE_ID:
            raise GraphValidationError("invalid_studio_host", "Web Studio Runtime must use the singleton service ID 'studio'")


def normalize_studio_hosts(document: StudioDocument) -> StudioDocument:
    """Repair historical cloned hosts without changing operator IDs or revisions.

    The canonical host owns configuration/layout; if absent, the first host wins.
    Ports on removed hosts are mapped by semantic identity, not instance port ID.
    Conflicting bindings still fail validation rather than silently losing wiring.
    """
    validate_document(document)
    hosts = [node for node in document.nodes if isinstance(node, ServiceNode) and node.service_class == STUDIO_SERVICE_CLASS]
    occupied = next((node for node in document.nodes if node.node_id == STUDIO_SERVICE_ID), None)
    if occupied is not None and (not isinstance(occupied, ServiceNode) or occupied.service_class != STUDIO_SERVICE_CLASS):
        raise GraphValidationError("reserved_studio_id", "node ID 'studio' is reserved for Web Studio Runtime")
    if not hosts or (len(hosts) == 1 and hosts[0].node_id == STUDIO_SERVICE_ID):
        return document
    chosen = next((host for host in hosts if host.node_id == STUDIO_SERVICE_ID), hosts[0])
    host_ids = {host.node_id for host in hosts}
    canonical = msgspec.structs.replace(chosen, node_id=STUDIO_SERVICE_ID, service_id=STUDIO_SERVICE_ID)
    canonical_ports = {(port.kind, port.direction, port.runtime_name): port.port_id for port in canonical.ports}
    port_map: dict[tuple[str, str], str] = {}
    for host in hosts:
        for port in host.ports:
            target = canonical_ports.get((port.kind, port.direction, port.runtime_name))
            if target is not None:
                port_map[(host.node_id, port.port_id)] = target

    def endpoint(node_id: str, port_id: str) -> tuple[str, str]:
        if node_id not in host_ids:
            return node_id, port_id
        mapped_port = port_map.get((node_id, port_id))
        if mapped_port is None:
            raise GraphValidationError("incompatible_studio_port", f"cannot merge Studio host port {node_id}/{port_id}")
        return STUDIO_SERVICE_ID, mapped_port

    edges: list[GraphEdge] = []
    seen: set[tuple[str, str, str, str]] = set()
    for edge in document.edges:
        source, source_port = endpoint(edge.from_node_id, edge.from_port_id)
        target, target_port = endpoint(edge.to_node_id, edge.to_port_id)
        identity = (source, source_port, target, target_port)
        if identity in seen:
            raise GraphValidationError("conflicting_studio_edges", "merging Studio hosts would duplicate a connection")
        seen.add(identity)
        edges.append(msgspec.structs.replace(edge, from_node_id=source, from_port_id=source_port,
            to_node_id=target, to_port_id=target_port))
    nodes: list[GraphNode] = []
    for node in document.nodes:
        if node.node_id == chosen.node_id:
            nodes.append(canonical)
        elif node.node_id in host_ids:
            continue
        elif isinstance(node, OperatorNode) and node.service_id in host_ids:
            nodes.append(msgspec.structs.replace(node, service_id=STUDIO_SERVICE_ID))
        else:
            nodes.append(node)
    layout: list[NodeLayout] = []
    for item in document.layout:
        if item.node_id == chosen.node_id:
            layout.append(msgspec.structs.replace(item, node_id=STUDIO_SERVICE_ID))
        elif item.node_id not in host_ids:
            layout.append(item)
    result = msgspec.structs.replace(document, nodes=tuple(nodes), edges=tuple(edges), layout=tuple(layout))
    validate_runtime_document(result)
    return result
