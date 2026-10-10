from __future__ import annotations

import json
import subprocess
from pathlib import Path

import msgspec
import pytest

from f8pysdk.specs import F8OperatorSpec, F8ServiceSpec, F8StateAccess, F8StateSpec, any_schema, number_schema, string_schema
from f8studio_core.graph import GraphEdge, GraphEdgeKind, NodeCatalog, NodeLayout, OperatorNode, export_shared_graph, import_graph, new_document, replace_node_spec
from f8studio_core.graph.models import StudioDocument
from f8studio_core.publication import (
    ExtensionRequirement, InstalledExtension, OperatorRequirement, PublicationManifest, PublicationSource,
    canonical_publication_bytes, capture_component, component_document, create_component_publication,
    create_graph_publication, decode_component, decode_publication, diagnose_dependencies, hash_publication_value,
)
from f8studio_core.publication.contract import publication_hash

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"


def sample() -> StudioDocument:
    catalog = NodeCatalog(services=[F8ServiceSpec(serviceClass="test.engine", label="Engine")], operators=[
        F8OperatorSpec(serviceClass="test.engine", operatorClass="test.script", label="Script", stateFields=[
            F8StateSpec(name="code", access=F8StateAccess.rw, valueSchema=string_schema(default="pass")),
            F8StateSpec(name="gain", access=F8StateAccess.rw, valueSchema=number_schema(default=1)),
            F8StateSpec(name="path", access=F8StateAccess.rw, valueSchema=string_schema(default="example.txt"), publishable=False),
        ])])
    host = catalog.create_service_node(node_id="engine", service_class="test.engine")
    node = catalog.create_operator_node(node_id="script", service_id="engine", service_class="test.engine",
        operator_class="test.script", state_values={"code": "value * gain", "gain": 2, "path": "/private/file"})
    return msgspec.structs.replace(new_document(project_id="author", graph_id="graph"), nodes=(host, node),
        layout=(NodeLayout(node_id="script", x=1.5, y=-0.0),))


def manifest(kind: str = "graph") -> PublicationManifest:
    return PublicationManifest(kind="graph" if kind == "graph" else "component",
        content_format="f8graph" if kind == "graph" else "f8component", content_version=4 if kind == "graph" else 1,
        license="MIT", source=PublicationSource(repository_url="https://example.com/source"), dependencies=(
            ExtensionRequirement(extension_id="test.extension", compatible_versions=("1.0", "1.1"),
                service_classes=("test.engine",), operators=(OperatorRequirement(service_class="test.engine", operator_class="test.script"),),
                protocol_versions=("f8service/2", "f8operator/2"), capabilities=("scripting",)),))


def test_publication_hash_tracks_publishable_behavior_and_layout_not_local_identity() -> None:
    document = sample()
    original = create_graph_publication(document, manifest())
    node = msgspec.structs.replace(document.nodes[1], state_values={**document.nodes[1].state_values, "path": "other"})
    private = msgspec.structs.replace(document, nodes=(document.nodes[0], node), project_id="copy", graph_id="new",
        graph_revision=1000, layout_revision=2000)
    assert create_graph_publication(private, manifest()) == original
    assert "/private/file" not in msgspec.json.encode(original).decode()
    assert "example.txt" in msgspec.json.encode(original).decode()
    changed = msgspec.structs.replace(document, layout=(NodeLayout(node_id="script", x=2, y=0),))
    assert create_graph_publication(changed, manifest()).content_hash != original.content_hash
    changed = msgspec.structs.replace(document, nodes=(document.nodes[0], msgspec.structs.replace(node, state_values={"gain": 3})))
    assert create_graph_publication(changed, manifest()).content_hash != original.content_hash
    assert create_graph_publication(document, msgspec.structs.replace(manifest(), license="UNLICENSED")).content_hash != original.content_hash
    assert decode_publication(msgspec.json.encode(original)) == original
    tampered = msgspec.structs.replace(original, manifest=msgspec.structs.replace(original.manifest, license="GPL-3.0"))
    with pytest.raises(ValueError, match="hash mismatch"):
        decode_publication(msgspec.json.encode(tampered))


def test_component_preserves_complete_definition_and_explicit_external_host() -> None:
    component = capture_component(sample(), node_ids=("script",))
    assert component.services == {}
    assert len(component.host_bindings) == 1
    assert component.operators["script"].state_values == {"code": "value * gain", "gain": 2}
    restored = component_document(decode_component(msgspec.json.encode(component)))
    assert isinstance(restored.nodes[1], OperatorNode)
    assert restored.nodes[1].spec == sample().nodes[1].spec
    assert restored.nodes[1].ports == sample().nodes[1].ports
    publication = create_component_publication(component, manifest("component"))
    assert decode_publication(msgspec.json.encode(publication)) == publication
    invalid = msgspec.structs.replace(component, host_bindings=())
    with pytest.raises(ValueError, match="service"):
        component_document(invalid)


def test_cut_state_edge_retains_authored_fallback_and_exposes_endpoint() -> None:
    document = sample()
    source = msgspec.structs.replace(document.nodes[1], node_id="source")
    edge = GraphEdge(edge_id="binding", kind=GraphEdgeKind.state, from_node_id="source",
        from_port_id="state:output:gain", to_node_id="script", to_port_id="state:input:gain")
    document = msgspec.structs.replace(document, nodes=(*document.nodes, source), edges=(edge,))
    single = capture_component(document, node_ids=("script",))
    assert single.operators["script"].state_values["gain"] == 2
    assert single.endpoints[0].port_id == "state:input:gain"
    connected = capture_component(document, node_ids=("script", "source"))
    assert "gain" not in connected.operators["script"].state_values
    assert connected.endpoints == ()


def test_external_host_disabled_status_is_not_captured_into_component_semantics() -> None:
    document = sample()
    source = msgspec.structs.replace(document.nodes[1], node_id="source")
    edge = GraphEdge(edge_id="binding", kind=GraphEdgeKind.state, from_node_id="source",
        from_port_id="state:output:gain", to_node_id="script", to_port_id="state:input:gain")
    document = msgspec.structs.replace(document, nodes=(msgspec.structs.replace(document.nodes[0], enabled=False), document.nodes[1], source), edges=(edge,))
    component = capture_component(document, node_ids=("script", "source"))
    assert "gain" not in component.operators["script"].state_values
    assert component_document(component).nodes[0].enabled


def test_selection_cut_with_required_state_and_no_authored_fallback_fails_explicitly() -> None:
    document = sample()
    target = document.nodes[1]
    fields = [msgspec.structs.replace(field, valueRequired=True, valueSchema=number_schema())
              if field.name == "gain" else field for field in target.spec.stateFields]
    from f8studio_core.graph import replace_node_spec
    target = replace_node_spec(target, msgspec.structs.replace(target.spec, stateFields=fields))
    source = msgspec.structs.replace(document.nodes[1], node_id="source")
    target = msgspec.structs.replace(target, state_values={"code": "pass"})
    edge = GraphEdge(edge_id="binding", kind=GraphEdgeKind.state, from_node_id="source",
        from_port_id="state:output:gain", to_node_id="script", to_port_id="state:input:gain")
    document = msgspec.structs.replace(document, nodes=(document.nodes[0], target, source), edges=(edge,))
    with pytest.raises(ValueError, match="cuts required state input script.gain"):
        capture_component(document, node_ids=("script",))


def test_dependency_diagnostics_and_coverage_are_explicit_and_preview_is_available() -> None:
    publication = create_component_publication(capture_component(sample(), node_ids=("script",)), manifest("component"))
    issues = diagnose_dependencies(publication.manifest, ())
    assert issues[0].code == "missing_extension"
    assert component_document(publication.content).nodes
    issues = diagnose_dependencies(publication.manifest, (InstalledExtension(extension_id="test.extension", version="0.1"),))
    assert {issue.code for issue in issues} == {"incompatible_extension_version", "missing_service", "missing_operator", "missing_protocol", "missing_capability"}
    with pytest.raises(ValueError, match="ownership"):
        create_graph_publication(sample(), msgspec.structs.replace(manifest(), dependencies=()))
    with pytest.raises(ValueError, match="format"):
        create_graph_publication(sample(), manifest("component"))


def test_shared_hash_golden_vectors_and_numeric_rejections() -> None:
    fixtures = json.loads((FIXTURES / "hash-v1.json").read_text(encoding="utf-8"))
    for fixture in fixtures:
        assert canonical_publication_bytes(fixture["value"]).decode() == fixture["canonical"]
        assert hash_publication_value(fixture["value"]) == fixture["sha256"]
    assert hash_publication_value(1) == hash_publication_value(1.0)
    assert hash_publication_value(-0.0) == hash_publication_value(0)
    assert hash_publication_value([1, 2]) != hash_publication_value([2, 1])
    for value in (float("nan"), float("inf"), 2**53, "\ud800"):
        with pytest.raises((ValueError, UnicodeError)):
            hash_publication_value(value)


def test_published_history_fixtures_are_decodable() -> None:
    for name in ("graph-v1.json", "component-v1.json"):
        publication = decode_publication((FIXTURES / name).read_bytes())
        assert publication.content_hash


@pytest.mark.parametrize("kind", ["graph", "component"])
def test_definition_defaults_and_examples_survive_javascript_without_changing_local_content(kind: str) -> None:
    document = sample()
    host = replace_node_spec(document.nodes[0], msgspec.structs.replace(document.nodes[0].spec,
        stateFields=[F8StateSpec(name="refresh", access=F8StateAccess.rw,
            valueSchema=number_schema(default=100.0, minimum=1.0, maximum=5000.0))]))
    node = document.nodes[1]
    nested = msgspec.structs.replace(any_schema(), default={"values": [0.0, -0.0, 1.0, 1e-8, True, None]},
        examples=[{"values": [2.0, 1e-8]}])
    node = replace_node_spec(node, msgspec.structs.replace(node.spec, stateFields=[*node.spec.stateFields,
        F8StateSpec(name="nested", access=F8StateAccess.rw, valueSchema=nested)]))
    document = msgspec.structs.replace(document, nodes=(host, node))
    local_graph = export_shared_graph(document)
    local_component = capture_component(document, node_ids=("script",))
    local_component_bytes = msgspec.json.encode(local_component)
    original = (create_graph_publication(document, manifest()) if kind == "graph"
                else create_component_publication(local_component, manifest("component")))
    returned = subprocess.run(["node", "--input-type=module", "-e",
        "let raw = ''; for await (const chunk of process.stdin) raw += chunk; process.stdout.write(JSON.stringify(JSON.parse(raw)));"],
        input=msgspec.json.encode(original), capture_output=True, check=True).stdout
    decoded = decode_publication(returned)
    assert decoded == original
    assert export_shared_graph(document) == local_graph
    assert msgspec.json.encode(local_component) == local_component_bytes
    assert export_shared_graph(import_graph(local_graph)) == local_graph  # Historical references remain valid.
    assert decoded.content.definitions == original.content.definitions
    assert set(decoded.content.definitions.services) != set(local_component.definitions.services)
    assert set(decoded.content.definitions.operators) != set(local_component.definitions.operators)
    # A valid outer publication hash never excuses a tampered inner definition.
    ref, spec = next(iter(decoded.content.definitions.operators.items()))
    definitions = msgspec.structs.replace(decoded.content.definitions,
        operators={ref: msgspec.structs.replace(spec, label="Tampered definition")})
    content = msgspec.structs.replace(decoded.content, definitions=definitions)
    tampered = msgspec.structs.replace(decoded, content=content, content_hash=publication_hash(decoded.manifest, content))
    with pytest.raises(ValueError, match="operator definition hash mismatch"):
        decode_publication(msgspec.json.encode(tampered))


def test_declared_sets_and_omitted_model_defaults_have_stable_hashes() -> None:
    document = msgspec.structs.replace(sample(), layout=(NodeLayout(node_id="engine", x=0, y=0), *sample().layout))
    original = create_graph_publication(document, manifest())
    reordered = msgspec.structs.replace(document, layout=tuple(reversed(document.layout)))
    dependency = msgspec.structs.replace(manifest().dependencies[0], compatible_versions=("1.1", "1.0"),
        protocol_versions=("f8operator/2", "f8service/2"))
    assert create_graph_publication(reordered, msgspec.structs.replace(manifest(), dependencies=(dependency,))).content_hash == original.content_hash
    raw = json.loads(msgspec.json.encode(original))
    raw["content"]["presentation"]["layout"][0].pop("width")
    raw["content"]["services"]["engine"].pop("enabled")
    assert decode_publication(json.dumps(raw)) == original


@pytest.mark.parametrize("version", ["f8studio-component/1", "f8studio-component/2"])
def test_legacy_components_convert_explicitly_preserving_definitions_and_ids(version: str) -> None:
    document = sample()
    legacy = {"schemaVersion": version, "nodes": msgspec.to_builtins(document.nodes),
        "edges": [], "layout": msgspec.to_builtins(document.layout)}
    component = decode_component(msgspec.json.encode(legacy))
    restored = component_document(component)
    assert restored.nodes[1].node_id == "script"
    assert restored.nodes[1].spec == document.nodes[1].spec
    assert restored.nodes[1].state_values == {"code": "value * gain", "gain": 2}
