from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import msgspec
import pytest

from f8pyengine.operators.python_script import PythonScriptRuntimeNode
from f8pysdk.specs import (
    F8DataPayloadSpec, F8DataPortPayloadKind, F8DataPortSpec, F8ServiceSpec, F8StateAccess,
    F8StateSpec, number_schema, normalize_spec_policy,
)
from f8studio_core.graph import (
    CreateNodeOp, GraphEdge, GraphEdgeKind, NodeCatalog, NodeLayout, OperatorNode,
    PatchRequest, RevisionConflictError,
)
from f8studio_core.graph.store import IdempotencyConflictError
from f8studio_core.publication import capture_component
from f8studio_server.application import StudioApplication
from f8studio_server.assets import AssetKind, CaptureComponentRequest, CreateAssetRequest, UpdateAssetRequest
from f8studio_server.component_models import InsertComponentRequest
from f8studio_server.errors import InvalidRequestError
from f8studio_server.models import CreateProjectRequest


SOURCE_CODE = 'def onMsg(ctx, inputs):\n    ctx.emit("smoothed", inputs.value * ctx.states.alpha)\n'


def studio_with_template(tmp_path: Path) -> tuple[StudioApplication, str]:
    studio = StudioApplication(data_dir=tmp_path / "studio", service_roots=())
    service = normalize_spec_policy(F8ServiceSpec(serviceClass="f8.pyengine", label="Engine"))
    installed = PythonScriptRuntimeNode.SPEC
    studio.catalog.sdk_catalog.register_service(service)
    studio.catalog.sdk_catalog.register_operators([installed])
    custom = msgspec.structs.replace(installed,
        stateFields=[*installed.stateFields, F8StateSpec(name="alpha", access=F8StateAccess.rw,
            valueSchema=number_schema(default=0.5), persistent=True, publishable=True)],
        dataInPorts=[F8DataPortSpec(name="value", payload=F8DataPayloadSpec(kind=F8DataPortPayloadKind.json,
            valueSchema=number_schema()), definitionProtected=False)],
        dataOutPorts=[F8DataPortSpec(name="smoothed", payload=F8DataPayloadSpec(kind=F8DataPortPayloadKind.json,
            valueSchema=number_schema()), definitionProtected=False)])
    catalog = NodeCatalog(services=[service], operators=[custom])
    host = catalog.create_service_node(node_id="source_engine", service_class="f8.pyengine")
    script = catalog.create_operator_node(node_id="script", service_id=host.node_id, service_class="f8.pyengine",
        operator_class=installed.operatorClass, state_values={"code": SOURCE_CODE, "alpha": 0.25})
    document = studio.projects.create(CreateProjectRequest(project_id="source", name="Source")).document
    studio.projects.patch("source", PatchRequest(request_id="create", expected_graph_revision=0, expected_layout_revision=0,
        operations=(CreateNodeOp(node=host), CreateNodeOp(node=script, layout=NodeLayout(node_id="script", x=100, y=200)))))
    asset = studio.tools.capture_component("source", CaptureComponentRequest(expected_graph_revision=1,
        expected_layout_revision=1, name="Smooth", node_ids=("script",)))
    target = studio.projects.create(CreateProjectRequest(project_id="target", name="Target"))
    existing_host = catalog.create_service_node(node_id="existing_engine", service_class="f8.pyengine")
    studio.projects.patch("target", PatchRequest(request_id="host", expected_graph_revision=target.document.graph_revision,
        expected_layout_revision=0, operations=(CreateNodeOp(node=existing_host),)))
    assert document.nodes == ()
    return studio, asset.asset_id


def request(asset_id: str, *, request_id: str = "insert", revision: int = 1, layout_revision: int = 0) -> InsertComponentRequest:
    return InsertComponentRequest(request_id=request_id, asset_id=asset_id, version=1,
        expected_graph_revision=revision, expected_layout_revision=layout_revision,
        host_bindings={"source_engine": "existing_engine"})


def test_complete_pyscript_roundtrip_reuses_host_and_repeated_inserts_are_distinct(tmp_path: Path) -> None:
    studio, asset_id = studio_with_template(tmp_path)
    original = studio.projects.document("source").nodes[1]
    preview = studio.tools.component_preview(asset_id, 1)
    assert not preview.issues
    assert preview.component.host_bindings[0].binding_id == "source_engine"
    assert preview.document.nodes[1].spec == original.spec
    target_before = studio.projects.document("target")
    proposal = studio.tools.preview_component_insertion("target", request(asset_id))
    assert studio.projects.document("target") == target_before
    result = asyncio.run(studio.tools.insert_component("target", request(asset_id)))
    assert result.source.node_map == proposal.source.node_map
    assert result.patch.document.graph_revision == 2
    inserted = result.patch.document.nodes[-1]
    assert isinstance(inserted, OperatorNode)
    assert inserted.service_id == "existing_engine"
    assert inserted.spec == original.spec
    assert inserted.ports == original.ports
    assert inserted.state_values["code"] == SOURCE_CODE
    assert inserted.state_values["alpha"] == 0.25
    assert len([node for node in result.patch.document.nodes if not isinstance(node, OperatorNode)]) == 1
    second = asyncio.run(studio.tools.insert_component("target", request(asset_id, request_id="second", revision=2, layout_revision=1)))
    assert set(second.source.node_map.values()).isdisjoint(result.source.node_map.values())
    assert len(second.patch.document.nodes) == 3
    with studio.database.connection() as connection:
        saved = connection.execute("SELECT source FROM component_insertions WHERE project_id = ? AND request_id = ?", ("target", "insert")).fetchone()
    assert saved is not None
    assert msgspec.json.decode(saved[0])["version"] == 1
    assert msgspec.json.decode(saved[0])["nodeMap"] == result.source.node_map


def test_retries_replay_fixed_result_after_restart_and_asset_deletion(tmp_path: Path) -> None:
    studio, asset_id = studio_with_template(tmp_path)
    inserted = asyncio.run(studio.tools.insert_component("target", request(asset_id)))
    studio.assets.delete(asset_id)
    restarted = StudioApplication(data_dir=tmp_path / "studio", service_roots=())
    replayed = asyncio.run(restarted.tools.insert_component("target", request(asset_id)))
    assert replayed == inserted
    assert len(restarted.projects.document("target").nodes) == 2
    with pytest.raises(IdempotencyConflictError):
        asyncio.run(restarted.tools.insert_component("target", msgspec.structs.replace(request(asset_id), x=80)))


def test_missing_extension_remains_previewable_but_insertion_does_not_modify_project(tmp_path: Path) -> None:
    studio, asset_id = studio_with_template(tmp_path)
    restarted = StudioApplication(data_dir=tmp_path / "studio", service_roots=())
    preview = restarted.tools.component_preview(asset_id, 1)
    assert {issue.code for issue in preview.issues} == {"missing_definition"}
    assert preview.document.nodes[1].state_values["code"] == SOURCE_CODE
    before = restarted.projects.document("target")
    with pytest.raises(InvalidRequestError, match="Install the extension"):
        asyncio.run(restarted.tools.insert_component("target", request(asset_id)))
    assert restarted.projects.document("target") == before
    with restarted.database.connection() as connection:
        assert connection.execute("SELECT count(*) FROM component_insertions").fetchone()[0] == 0


def test_invalid_host_stale_revision_and_database_failure_leave_project_unchanged(tmp_path: Path) -> None:
    studio, asset_id = studio_with_template(tmp_path)
    before = studio.projects.document("target")
    with pytest.raises(InvalidRequestError, match="requires an existing"):
        asyncio.run(studio.tools.insert_component("target", msgspec.structs.replace(request(asset_id), host_bindings={"source_engine": "missing"})))
    with pytest.raises(RevisionConflictError):
        asyncio.run(studio.tools.insert_component("target", msgspec.structs.replace(request(asset_id), expected_graph_revision=0)))
    with studio.database.connection() as connection:
        connection.execute("""CREATE TRIGGER reject_component_source BEFORE INSERT ON component_insertions
            BEGIN SELECT RAISE(ABORT, 'simulated source write failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="simulated source write failure"):
        asyncio.run(studio.tools.insert_component("target", request(asset_id)))
    assert studio.projects.document("target") == before
    with studio.database.connection() as connection:
        assert connection.execute("SELECT graph_revision FROM projects WHERE project_id = 'target'").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM processed_requests WHERE project_id = 'target' AND request_id = 'insert'").fetchone()[0] == 0


def test_internal_edges_remap_and_component_versions_do_not_replace_inserted_nodes(tmp_path: Path) -> None:
    studio, asset_id = studio_with_template(tmp_path)
    source = studio.projects.document("source")
    node = msgspec.structs.replace(source.nodes[1], node_id="second_script")
    edge = GraphEdge(edge_id="data", from_node_id="script", from_port_id="data:output:smoothed",
        to_node_id="second_script", to_port_id="data:input:value", kind=GraphEdgeKind.data)
    expanded = msgspec.structs.replace(source, nodes=(*source.nodes, node), edges=(edge,))
    component = capture_component(expanded, node_ids=("script", "second_script"))
    multi = studio.assets.create(CreateAssetRequest(kind=AssetKind.component, name="Pair", content=msgspec.to_builtins(component)))
    result = asyncio.run(studio.tools.insert_component("target", request(multi.asset_id)))
    inserted_edge = result.patch.document.edges[0]
    assert inserted_edge.from_node_id == result.source.node_map["script"]
    assert inserted_edge.to_node_id == result.source.node_map["second_script"]
    assert inserted_edge.edge_id == result.source.edge_map["data"]
    studio.assets.update(asset_id, UpdateAssetRequest(name="Changed", content=studio.assets.get(asset_id).content))
    assert studio.projects.document("target") == result.patch.document


def test_concurrent_insertions_from_same_revision_commit_only_one(tmp_path: Path) -> None:
    studio, asset_id = studio_with_template(tmp_path)
    async def insert_both() -> list[object]:
        return await asyncio.gather(studio.tools.insert_component("target", request(asset_id, request_id="first")),
            studio.tools.insert_component("target", request(asset_id, request_id="second")), return_exceptions=True)
    results = asyncio.run(insert_both())
    assert sum(isinstance(item, RevisionConflictError) for item in results) == 1
    assert len(studio.projects.document("target").nodes) == 2


def test_incompatible_installed_definition_is_previewable_and_explicitly_blocks_insertion(tmp_path: Path) -> None:
    studio, asset_id = studio_with_template(tmp_path)
    studio.catalog.sdk_catalog.register_operators([msgspec.structs.replace(PythonScriptRuntimeNode.SPEC, version="2.0.0")])
    preview = studio.tools.component_preview(asset_id, 1)
    assert {issue.code for issue in preview.issues} == {"incompatible_definition"}
    before = studio.projects.document("target")
    with pytest.raises(InvalidRequestError, match="installed descriptor"):
        asyncio.run(studio.tools.insert_component("target", request(asset_id)))
    assert studio.projects.document("target") == before


def test_agent_component_insertion_requires_exact_preview_and_existing_approval_flow(tmp_path: Path) -> None:
    from f8studio_server.agents.models import AgentRunStatus, AgentSessionRecord, ResolveAgentApprovalRequest
    studio, asset_id = studio_with_template(tmp_path)
    record = AgentSessionRecord(session_id="component_agent", project_id="target", title="Component agent", provider_id="deterministic",
        model_id="graph-builder-v1", status=AgentRunStatus.running, created_at="2026-10-08T00:00:00Z", updated_at="2026-10-08T00:00:00Z")
    studio.agents._sessions.repository.save(record)
    functions = {function.__name__: function for function in studio.agents._model_tools(record)}
    payload = msgspec.json.encode(request(asset_id)).decode()
    async def scenario() -> None:
        with pytest.raises(InvalidRequestError, match="must be previewed"):
            await functions["component_insert"](payload)
        await functions["component_preview_insertion"](payload)
        assert len(studio.projects.document("target").nodes) == 1
        task = asyncio.create_task(functions["component_insert"](payload))
        for _ in range(200):
            latest = studio.agents.get(record.session_id)
            if latest.approval is not None:
                break
            await asyncio.sleep(0.01)
        approval = latest.approval
        assert approval is not None
        await studio.agents._execution.resolve_approval(record.session_id, approval.approval_id,
            ResolveAgentApprovalRequest(approved=True, arguments_hash=approval.arguments_hash))
        result = msgspec.json.decode(await task)
        assert result["source"]["assetId"] == asset_id
        assert len(studio.projects.document("target").nodes) == 2
    asyncio.run(scenario())
