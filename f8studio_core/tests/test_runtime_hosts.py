from __future__ import annotations

import msgspec
import pytest

from f8pysdk.specs import F8OperatorSpec, F8ServiceSpec, F8StateAccess, F8StateSpec, json_data_port, number_schema
from f8studio_core import compile_document
from f8studio_core.graph import (
    CreateNodeOp, GraphEdge, GraphEdgeKind, GraphStore, GraphValidationError, InsertFragmentOp,
    NodeCatalog, NodeLayout, OperatorNode, PatchRequest, ServiceNode, StudioDocument,
    decode_document, encode_document, export_graph, import_graph, new_document,
    replace_node_spec,
)
from f8studio_core.graph.catalog import ports_for_spec
from f8studio_core.graph.runtime_hosts import validate_runtime_document
from f8studio_core.publication import capture_component, component_document
from f8studio_core.publication.insertion import prepare_component_insertion


def sample() -> StudioDocument:
    state = F8StateSpec(name="tickMs", access=F8StateAccess.rw, valueSchema=number_schema(default=100))
    catalog = NodeCatalog(services=[F8ServiceSpec(serviceClass="f8.pyengine", label="Engine"),
        F8ServiceSpec(serviceClass="f8.pystudio", label="Web Studio Runtime", stateFields=[state])], operators=[
        F8OperatorSpec(serviceClass="f8.pyengine", operatorClass="test.tick", label="Tick",
            dataOutPorts=[json_data_port(name="value", value_schema=number_schema())]),
        F8OperatorSpec(serviceClass="f8.pystudio", operatorClass="f8.viz.text", label="Text",
            dataInPorts=[json_data_port(name="input", value_schema=number_schema())], stateFields=[state]),
    ])
    engine = catalog.create_service_node(node_id="engine", service_class="f8.pyengine")
    tick = catalog.create_operator_node(node_id="tick", service_id="engine", service_class="f8.pyengine", operator_class="test.tick")
    studio = catalog.create_service_node(node_id="studio", service_class="f8.pystudio", state_values={"tickMs": 40})
    viz = catalog.create_operator_node(node_id="viz", service_id="studio", service_class="f8.pystudio", operator_class="f8.viz.text")
    return msgspec.structs.replace(new_document(project_id="source"), nodes=(engine, tick, studio, viz),
        edges=(GraphEdge(edge_id="to_viz", from_node_id="tick", from_port_id="data:output:value",
                        to_node_id="viz", to_port_id="data:input:input", kind=GraphEdgeKind.data),),
        layout=(NodeLayout(node_id="studio", x=700, y=100), NodeLayout(node_id="viz", x=900, y=500)))


@pytest.mark.parametrize("fragment", [False, True])
def test_cloned_runtime_rejected_atomically_at_authoring_boundary(fragment: bool) -> None:
    document = sample()
    duplicate = msgspec.structs.replace(document.nodes[2], node_id="studio_copy", service_id="studio_copy")
    store = GraphStore(document)
    operation = InsertFragmentOp(nodes=(duplicate,)) if fragment else CreateNodeOp(node=duplicate)
    with pytest.raises(GraphValidationError, match="singleton"):
        store.apply(PatchRequest(request_id="bad", expected_graph_revision=0, expected_layout_revision=0, operations=(operation,)))
    assert store.snapshot() == document
    with pytest.raises(GraphValidationError, match="singleton"):
        compile_document(msgspec.structs.replace(document, nodes=(*document.nodes, duplicate)))


def test_reserved_studio_identity_cannot_be_used_by_another_node() -> None:
    document = sample()
    imposter = msgspec.structs.replace(document.nodes[0], node_id="studio", service_id="studio")
    invalid = msgspec.structs.replace(document, nodes=(imposter,), edges=(), layout=())
    with pytest.raises(GraphValidationError, match="reserved"):
        GraphStore(invalid)
    with pytest.raises(GraphValidationError, match="reserved"):
        decode_document(encode_document(invalid))


@pytest.mark.parametrize("canonical_exists", [False, True])
def test_historical_hosts_merge_preserving_operators_edges_layout_and_revision(canonical_exists: bool) -> None:
    document = sample()
    host = document.nodes[2]
    viz = document.nodes[3]
    assert isinstance(host, ServiceNode) and isinstance(viz, OperatorNode)
    # Deliberately use custom IDs on the cloned host to verify semantic port mapping.
    port_ids = {port.port_id: f"copied_{index}" for index, port in enumerate(host.ports)}
    duplicate = msgspec.structs.replace(host, node_id="studio_copy", service_id="studio_copy", state_values={"tickMs": 200},
        port_ids=port_ids, ports=ports_for_spec(host.spec, port_ids))
    copied_viz = msgspec.structs.replace(viz, node_id="viz_copy", service_id="studio_copy")
    copies = (duplicate, copied_viz)
    nodes = (*document.nodes, *copies) if canonical_exists else (*document.nodes[:2], *copies)
    edges = document.edges if canonical_exists else ()
    binding = GraphEdge(edge_id="clock", from_node_id="studio_copy", from_port_id=port_ids["state:output:tickMs"],
        to_node_id="viz_copy", to_port_id="state:input:tickMs", kind=GraphEdgeKind.state)
    corrupted = msgspec.structs.replace(document, nodes=nodes,
        edges=(*edges, msgspec.structs.replace(document.edges[0], edge_id="to_copy", to_node_id="viz_copy"), binding),
        graph_revision=8, layout_revision=7,
        layout=(*(document.layout if canonical_exists else ()), NodeLayout(node_id="studio_copy", x=1000, y=200),
                NodeLayout(node_id="viz_copy", x=1200, y=600)))
    repaired = decode_document(encode_document(corrupted))
    validate_runtime_document(repaired)
    assert (repaired.graph_revision, repaired.layout_revision) == (8, 7)
    assert {node.node_id for node in repaired.nodes} == ({"engine", "tick", "studio", "viz", "viz_copy"} if canonical_exists
                                                      else {"engine", "tick", "studio", "viz_copy"})
    assert next(node for node in repaired.nodes if node.node_id == "viz_copy").service_id == "studio"
    canonical = next(node for node in repaired.nodes if node.node_id == "studio")
    assert canonical.state_values["tickMs"] == (40 if canonical_exists else 200)
    assert next(edge for edge in repaired.edges if edge.edge_id == "clock").from_port_id == (
        "state:output:tickMs" if canonical_exists else port_ids["state:output:tickMs"])
    assert next(item for item in repaired.layout if item.node_id == "studio").x == (700 if canonical_exists else 1000)
    assert next(item for item in repaired.layout if item.node_id == "viz_copy").x == 1200
    compiled = compile_document(repaired)
    assert set(compiled.per_service) == {"engine", "studio"}
    assert {node.nodeId for node in compiled.per_service["studio"].nodes} >= {"studio", "viz_copy"}
    # Graph exchange import applies the same migration, after definition integrity checks.
    assert import_graph(export_graph(corrupted)).nodes == repaired.nodes


@pytest.mark.parametrize("existing_host", [False, True])
def test_full_component_insertion_reuses_or_creates_singleton(existing_host: bool) -> None:
    document = sample()
    component = capture_component(document)
    target = msgspec.structs.replace(new_document(project_id="target"),
        nodes=(document.nodes[2],) if existing_host else (), layout=(document.layout[0],) if existing_host else ())
    insertion = prepare_component_insertion(component, target, request_id="insert", host_bindings={})
    assert insertion.node_map["studio"] == "studio"
    assert sum(isinstance(node, ServiceNode) and node.service_class == "f8.pystudio" for node in insertion.fragment.nodes) == (0 if existing_host else 1)
    assert any(isinstance(node, ServiceNode) and node.service_class == "f8.pyengine" and node.node_id != "engine" for node in insertion.fragment.nodes)
    store = GraphStore(target)
    inserted = store.apply(PatchRequest(request_id="insert", expected_graph_revision=0, expected_layout_revision=0,
        operations=(insertion.fragment,))).document
    again = prepare_component_insertion(component, inserted, request_id="second", host_bindings={})
    result = store.apply(PatchRequest(request_id="second", expected_graph_revision=inserted.graph_revision,
        expected_layout_revision=inserted.layout_revision, operations=(again.fragment,))).document
    assert sum(isinstance(node, ServiceNode) and node.service_class == "f8.pystudio" for node in result.nodes) == 1
    assert sum(isinstance(node, OperatorNode) and node.service_class == "f8.pystudio" for node in result.nodes) == 2
    assert len(compile_document(result).per_service) == 3  # Two cloned engines, one builtin runtime.


def test_external_studio_host_alias_remains_previewable_and_binds_only_to_canonical_runtime() -> None:
    document = sample()
    component = capture_component(document, node_ids=("viz",))
    alias = "display_host"
    component = msgspec.structs.replace(component,
        host_bindings=(msgspec.structs.replace(component.host_bindings[0], binding_id=alias),),
        operators={key: msgspec.structs.replace(value, service_id=alias) for key, value in component.operators.items()})
    preview = component_document(component)
    assert preview.nodes[0].node_id == alias
    with pytest.raises(GraphValidationError, match="singleton"):
        compile_document(preview)
    target = msgspec.structs.replace(new_document(project_id="target"), nodes=(document.nodes[2],))
    insertion = prepare_component_insertion(component, target, request_id="insert", host_bindings={alias: "studio"})
    assert len(insertion.fragment.nodes) == 1
    assert insertion.fragment.nodes[0].service_id == "studio"


@pytest.mark.parametrize("template_id", ["studio", "template_display"])
def test_component_maps_reused_host_ports_and_endpoints_without_overwriting_configuration(template_id: str) -> None:
    document = sample()
    host = document.nodes[2]
    tick = document.nodes[1]
    assert isinstance(host, ServiceNode) and isinstance(tick, OperatorNode)
    tick = replace_node_spec(tick, msgspec.structs.replace(tick.spec, stateFields=host.spec.stateFields))
    internal = GraphEdge(edge_id="internal_clock", from_node_id=template_id, from_port_id="state:output:tickMs",
        to_node_id="viz", to_port_id="state:input:tickMs", kind=GraphEdgeKind.state)
    external = msgspec.structs.replace(internal, edge_id="external_clock", to_node_id="tick")
    document = msgspec.structs.replace(document, nodes=(document.nodes[0], tick,
        msgspec.structs.replace(host, node_id=template_id, service_id=template_id),
        msgspec.structs.replace(document.nodes[3], service_id=template_id)),
        edges=(*document.edges, internal, external), layout=())
    component = capture_component(document, node_ids=(template_id, "viz"))
    port_ids = {"state:output:tickMs": "existing_clock_out", "state:input:tickMs": "existing_clock_in"}
    existing = msgspec.structs.replace(host, port_ids=port_ids, ports=ports_for_spec(host.spec, port_ids), state_values={"tickMs": 16})
    target = msgspec.structs.replace(new_document(project_id="target"), nodes=(existing,),
        layout=(NodeLayout(node_id="studio", x=20, y=30),))
    insertion = prepare_component_insertion(component, target, request_id="insert", host_bindings={})
    assert insertion.node_map[template_id] == "studio"
    assert insertion.fragment.edges[0].from_port_id == "existing_clock_out"
    assert next(endpoint for endpoint in insertion.endpoints if endpoint.node_id == "studio").port_id == "existing_clock_out"
    store = GraphStore(target)
    inserted = store.apply(PatchRequest(request_id="insert", expected_graph_revision=0, expected_layout_revision=0,
        operations=(insertion.fragment,))).document
    assert inserted.nodes[0] == existing
    assert inserted.layout[0] == target.layout[0]
