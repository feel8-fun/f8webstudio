from __future__ import annotations

import hashlib

import msgspec
import pytest

from f8pysdk.specs import (
    F8OperatorSpec, F8ServiceSpec, F8StateAccess, F8StateSpec,
    integer_schema, number_schema, string_schema,
)
from f8studio_core import compile_document, semantic_graph_revision
from f8studio_core.graph import (
    GraphEdge, GraphEdgeKind, GraphStore, NodeCatalog, PatchRequest,
    SetNodeStateOp, decode_document, encode_document, import_graph, new_document,
)
from f8studio_core.graph.spec_edit import validate_spec_snapshot
from f8studio_core.graph.state_policy import ExcludedState, project_document_for_sharing
from f8studio_core.graph.exchange import export_shared_graph
from f8studio_core.graph.models import StudioDocument
from f8studio_core.graph.models import NodeLayout
from f8studio_core.graph.migrations import upgrade_document


def document_with_policies() -> StudioDocument:
    spec = F8OperatorSpec(serviceClass="test.engine", operatorClass="test.policy", label="Policy", stateFields=[
        F8StateSpec(name="gain", access=F8StateAccess.rw, valueSchema=number_schema(default=1), persistent=True, publishable=True),
        F8StateSpec(name="path", access=F8StateAccess.rw, valueSchema=msgspec.structs.replace(string_schema(default="example.mp4"), examples=["demo.mp4"]), persistent=True, publishable=False),
        F8StateSpec(name="secret", access=F8StateAccess.rw, valueSchema=string_schema(default=""), redactOnPublish=True),
        F8StateSpec(name="trigger", access=F8StateAccess.rw, valueSchema=integer_schema(default=0, minimum=0), persistent=False, publishable=False),
        F8StateSpec(name="observed", access=F8StateAccess.ro, valueSchema=number_schema()),
    ])
    catalog = NodeCatalog(services=[F8ServiceSpec(serviceClass="test.engine", label="Engine")], operators=[spec])
    service = catalog.create_service_node(node_id="engine", service_class="test.engine")
    node = catalog.create_operator_node(node_id="control", service_id="engine", service_class="test.engine", operator_class="test.policy", state_values={"gain": 2, "path": "/home/private/real.mp4", "secret": "secret-value"})
    return msgspec.structs.replace(new_document(project_id="policy"), nodes=(service, node))


def test_default_width_migration_applies_only_to_old_service_layouts() -> None:
    document = msgspec.structs.replace(document_with_policies(), layout=(
        NodeLayout(node_id="engine", x=0, y=0, width=620),
        NodeLayout(node_id="control", x=0, y=0, width=620),
    ))
    assert upgrade_document(document) == document
    migrated = upgrade_document(msgspec.structs.replace(document, schema_version="f8studio-document/2"))
    assert migrated.layout[0].width is None
    assert migrated.layout[1].width == 620


def test_local_roundtrip_keeps_private_configuration_and_runtime_updates_do_not_change_revision() -> None:
    document = document_with_policies()
    assert decode_document(encode_document(document)) == document
    store = GraphStore(document)
    before = semantic_graph_revision(document)
    for index in range(1, 4):
        result = store.apply(PatchRequest(request_id=str(index), expected_graph_revision=0, expected_layout_revision=0,
                                         operations=(SetNodeStateOp(node_id="control", field="trigger", value=index),)))
        assert not result.graph_changed
        assert result.document == document
    assert semantic_graph_revision(store.snapshot()) == before
    with pytest.raises(ValueError, match="at least"):
        store.apply(PatchRequest(request_id="invalid", expected_graph_revision=0, expected_layout_revision=0,
                                 operations=(SetNodeStateOp(node_id="control", field="trigger", value=-1),)))
    assert store.snapshot() == document
    compiled = compile_document(document).global_graph
    for node in compiled.nodes:
        for field in node.stateFields:
            assert isinstance(field.persistent, msgspec.UnsetType)
            assert isinstance(field.publishable, msgspec.UnsetType)


def test_shared_projection_cleans_only_instance_values_and_preserves_definitions_and_local_copy() -> None:
    document = document_with_policies()
    local_bytes = encode_document(document)
    shared = project_document_for_sharing(document)
    node = shared.nodes[1]
    assert node.state_values == {"gain": 2}
    assert node.spec == document.nodes[1].spec
    assert node.ports == document.nodes[1].ports
    assert encode_document(document) == local_bytes
    assert b"/home/private/real.mp4" not in export_shared_graph(document)
    assert b"secret-value" not in export_shared_graph(document)
    assert b"example.mp4" in export_shared_graph(document)
    restored = import_graph(export_shared_graph(document))
    assert restored.nodes == shared.nodes
    validate_spec_snapshot(document.nodes[1].spec, restored.nodes[1].spec)
    excluded = project_document_for_sharing(document, excluded_states=(ExcludedState(node_id="control", field="gain"),))
    assert excluded.nodes[1].state_values == {}
    assert excluded.nodes[1].spec == document.nodes[1].spec
    with pytest.raises(ValueError, match="excluded state not found"):
        project_document_for_sharing(document, excluded_states=(ExcludedState(node_id="control", field="missing"),))


def test_private_instance_changes_do_not_change_shared_content_hash_but_parameters_do() -> None:
    document = document_with_policies()
    private_edit = msgspec.structs.replace(document.nodes[1], state_values={"gain": 2, "path": "other.mp4", "secret": "other-token"})
    changed = msgspec.structs.replace(document, nodes=(document.nodes[0], private_edit), graph_revision=100)
    original_hash = hashlib.sha256(export_shared_graph(document)).hexdigest()
    assert hashlib.sha256(export_shared_graph(changed)).hexdigest() == original_hash
    parameter_edit = msgspec.structs.replace(private_edit, state_values={"gain": 3})
    assert hashlib.sha256(export_shared_graph(msgspec.structs.replace(document, nodes=(document.nodes[0], parameter_edit)))).hexdigest() != original_hash


def test_only_effective_upstream_connections_remove_saved_initial_values() -> None:
    document = document_with_policies()
    target = msgspec.structs.replace(document.nodes[1], node_id="target")
    edge = GraphEdge(edge_id="state", kind=GraphEdgeKind.state, from_node_id="control", from_port_id="state:output:gain", to_node_id="target", to_port_id="state:input:gain")
    connected = msgspec.structs.replace(document, nodes=(*document.nodes, target), edges=(edge,))
    assert project_document_for_sharing(connected).nodes[2].state_values == {}
    disabled = msgspec.structs.replace(connected, nodes=(connected.nodes[0], msgspec.structs.replace(connected.nodes[1], enabled=False), target))
    assert project_document_for_sharing(disabled).nodes[2].state_values == {"gain": 2}
    detached = msgspec.structs.replace(connected, edges=())
    assert project_document_for_sharing(detached).nodes[2].state_values == {"gain": 2}


def test_document_v2_migrates_without_losing_revision_port_ids_or_private_configuration() -> None:
    document = document_with_policies()
    legacy = msgspec.structs.replace(document, schema_version="f8studio-document/2", graph_revision=19,
        nodes=(document.nodes[0], msgspec.structs.replace(document.nodes[1], state_values={"gain": 2, "path": "local.mp4", "trigger": 42})))
    migrated = decode_document(encode_document(legacy))
    assert migrated.schema_version == "f8studio-document/3"
    assert migrated.graph_revision == 19
    assert migrated.nodes[1].state_values == {"gain": 2, "path": "local.mp4"}
    assert migrated.nodes[1].ports == document.nodes[1].ports
    # Current documents must fail instead of silently dropping invalid saved state.
    with pytest.raises(ValueError, match="nonpersistent|runtime"):
        decode_document(encode_document(msgspec.structs.replace(legacy, schema_version="f8studio-document/3")))


def test_legacy_exchange_hash_is_checked_before_policy_migration() -> None:
    from pathlib import Path
    payload = (Path(__file__).parent / "fixtures" / "legacy-graph-v3.json").read_bytes()
    restored = import_graph(payload)
    assert restored.schema_version == "f8studio-document/3"
    assert restored.nodes[0].state_values == {"path": "local.mp4"}
    assert restored.nodes[0].spec.stateFields[0].persistent is True
    assert restored.nodes[0].spec.stateFields[0].publishable is False
    raw = msgspec.json.decode(payload)
    ref = next(iter(raw["definitions"]["services"]))
    raw["definitions"]["services"][ref]["stateFields"][0]["description"] = "tampered"
    with pytest.raises(ValueError, match="hash mismatch"):
        import_graph(msgspec.json.encode(raw))
