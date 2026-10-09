from __future__ import annotations

import msgspec

from f8studio_core.graph import GraphNode, NodeLayout, ServiceNode, StudioDocument
from f8studio_core.graph.runtime_hosts import STUDIO_SERVICE_CLASS
from f8studio_core.graph.state_policy import ExcludedState
from f8studio_core.publication import PortableComponent, capture_component, component_document


def variant_node(component: PortableComponent) -> GraphNode:
    ids = component.presentation.node_order
    if len(ids) != 1 or len(component.services) + len(component.operators) != 1 or component.connections:
        raise ValueError("a Variant must contain exactly one template node and no connections")
    document = component_document(component)
    node = next(node for node in document.nodes if node.node_id == ids[0])
    if isinstance(node, ServiceNode) and node.service_class == STUDIO_SERVICE_CLASS:
        raise ValueError("the builtin Studio host is a singleton; save its operators as Variants instead")
    return node


def capture_variant(document: StudioDocument, node_id: str, excluded_states: tuple[ExcludedState, ...]) -> PortableComponent:
    original = next((node for node in document.nodes if node.node_id == node_id), None)
    if original is None:
        raise ValueError(f"node not found: {node_id}")
    if any(item.node_id != node_id for item in excluded_states):
        raise ValueError("Variant exclusions must refer to the captured node")
    if isinstance(original, ServiceNode):
        node = msgspec.structs.replace(original, node_id="template", service_id="template")
        nodes: tuple[GraphNode, ...] = (node,)
    else:
        host = next(node for node in document.nodes if isinstance(node, ServiceNode) and node.service_id == original.service_id)
        node = msgspec.structs.replace(original, node_id="template", service_id="host")
        nodes = (msgspec.structs.replace(host, node_id="host", service_id="host", state_values={}), node)
    layout = next((item for item in document.layout if item.node_id == node_id), None)
    # Stable template IDs and a relative origin keep graph movement out of asset versions.
    snapshot = msgspec.structs.replace(document, nodes=nodes, edges=(), layout=(NodeLayout(
        node_id="template", x=0, y=0, width=layout.width if layout else None, height=layout.height if layout else None),))
    excluded = tuple(ExcludedState(node_id="template", field=item.field) for item in excluded_states)
    component = capture_component(snapshot, node_ids=("template",), excluded_states=excluded)
    variant_node(component)
    return component
