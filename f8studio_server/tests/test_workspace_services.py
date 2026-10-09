from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import msgspec
import pytest

from f8pysdk.specs import F8JsonValue, F8RuntimeGraph, F8ServiceSpec, F8StateAccess, F8StateSpec, integer_schema
from f8pysdk.host import ServiceHost, ServiceHostConfig
from f8pysdk.state import StateWriteError
from f8pysdk.testing import ServiceBusHarness
from f8studio_core.graph import CreateNodeOp, NodeCatalog, OperatorNode, PatchRequest, SetNodeStateOp, SetOperatorSpecOp
from f8studio_server.application import StudioApplication
from f8studio_server.assets import (
    ASSET_SCHEMA_VERSION,
    AssetExport,
    AssetKind,
    AssetRepository,
    CreateAssetRequest,
    UpdateAssetRequest,
)
from f8studio_server.editor import (
    CreateEditorSessionRequest,
    EditorPositionRequest,
    EditorSessionService,
    EditorSupportFile,
    UpdateEditorDocumentRequest,
)
from f8studio_server.local_integration import LocalIntegrationService, RegisterHotkeyRequest
from f8studio_server.models import (
    CreateCatalogNodeRequest,
    CreateProjectRequest,
    DeployProjectRequest,
    JobStatus,
    RuntimeActionResult,
    RuntimeStateField,
    ServiceDeployResult,
    ServiceRuntimeStatus,
)
from f8studio_server.project_repository import ProjectRepository
from f8studio_server.editor_context import editor_support_files
from f8studio_server.projects import ProjectService
from f8studio_server.runtime import RuntimeMonitorCallback
from f8studio_server.studio_runtime import SERVICE_CLASS, create_studio_registry
from f8studio_server.studio_runtime.presentation import EventPresentationOutlet
from f8studio_server.events import EventJournal


def test_python_script_editor_uses_injected_api_and_dynamic_bindings(tmp_path: Path) -> None:
    from f8pyengine.operators.python_script import PythonScriptRuntimeNode
    from f8studio_core.graph import OperatorNode

    node = OperatorNode(
        node_id="script", name="Script", service_id="engine", service_class="f8.pyengine",
        operator_class="f8.python_script", spec=PythonScriptRuntimeNode.SPEC,
    )
    support = editor_support_files(node, "code")
    files = {item.path: item.content for item in support}
    assert "class F8PyEngineContext:" in files["f8_script_api.pyi"]
    assert "msg: Any" in files["f8_dynamic_inputs.pyi"]
    assert "inputMode: Literal[" in files["f8_dynamic_states.pyi"]
    assert "def __getitem__(self, key: str) -> Any" in files["f8_dynamic_states.pyi"]

    editor = EditorSessionService(root=tmp_path / "editor")
    source = (
        "from f8_script_api import F8Inputs, F8PyEngineContext, F8States\n"
        "def onStart(ctx: F8PyEngineContext) -> None:\n"
        "    ctx.log(ctx.states['inputMode'])\n"
        "def onMsg(ctx: F8PyEngineContext, inputs: F8Inputs) -> None:\n"
        "    states: F8States = ctx.states\n"
        "    ctx.emit('out', inputs.msg if states.inputMode else None)\n"
    )
    session = editor.create(CreateEditorSessionRequest(
        language="python", filename="state.py", text=source, support_files=support,
    ))
    try:
        diagnostics = editor.analyze(session.session_id).diagnostics
        assert not any(item.severity == "error" for item in diagnostics), diagnostics
        completion = editor.completion(session.session_id, EditorPositionRequest(line=2, column=8))
        result = completion.result
        items = result if isinstance(result, list) else result.get("items") if isinstance(result, dict) else []
        assert any(isinstance(item, dict) and item.get("label") == "log" for item in items)
        signature = editor.signature_help(session.session_id, EditorPositionRequest(line=5, column=13)).result
        assert isinstance(signature, dict)
        signatures = signature.get("signatures")
        assert isinstance(signatures, list)
        assert any(isinstance(item, dict) and "port: str" in str(item.get("label")) for item in signatures), signature
        second_argument = editor.signature_help(session.session_id, EditorPositionRequest(line=5, column=20)).result
        assert isinstance(second_argument, dict)
        assert second_argument.get("activeParameter") == 1
    finally:
        editor.close_session(session.session_id)


class HotkeyRuntimeGateway:
    def __init__(self) -> None:
        self.state_calls: list[tuple[str, str, str, F8JsonValue]] = []
        self.graphs: dict[str, F8RuntimeGraph] = {}

    async def start_monitoring(self, callback: RuntimeMonitorCallback) -> None:
        del callback

    async def deploy(self, *, service_id: str, graph: F8RuntimeGraph, force_apply: bool) -> ServiceDeployResult:
        del force_apply
        self.graphs[service_id] = graph
        return ServiceDeployResult(service_id=service_id, success=True)

    async def status(self, service_id: str) -> ServiceRuntimeStatus:
        graph = self.graphs.get(service_id)
        return ServiceRuntimeStatus(
            service_id=service_id,
            service_class="f8.pystudio",
            runtime_instance_id="runtime1",
            active=True,
            rungraph_graph_id="" if graph is None else str(graph.graphId),
            rungraph_revision="" if graph is None else str(graph.revision),
        )

    async def set_active(self, service_id: str, *, active: bool) -> RuntimeActionResult:
        del service_id, active
        return RuntimeActionResult(success=True)

    async def set_state(
        self,
        service_id: str,
        *,
        node_id: str,
        field: str,
        value: F8JsonValue,
    ) -> RuntimeActionResult:
        self.state_calls.append((service_id, node_id, field, value))
        return RuntimeActionResult(success=True)

    async def read_state(self, service_id: str, *, node_id: str, field: str) -> RuntimeStateField:
        for service, node, name, value in reversed(self.state_calls):
            if (service, node, name) == (service_id, node_id, field):
                return RuntimeStateField(field=field, found=True, value=value)
        return RuntimeStateField(field=field, found=False)

    async def invoke_command(
        self,
        service_id: str,
        *,
        call: str,
        params: dict[str, F8JsonValue],
    ) -> RuntimeActionResult:
        del service_id, call, params
        return RuntimeActionResult(success=True)

    async def terminate(self, service_id: str) -> RuntimeActionResult:
        del service_id
        return RuntimeActionResult(success=True)

    async def close(self) -> None:
        return


def _asset_repository(tmp_path: Path) -> AssetRepository:
    project_repository = ProjectRepository(tmp_path / "studio.sqlite3")
    return AssetRepository(project_repository.database_path)


def test_assets_are_validated_versioned_and_exportable(tmp_path: Path) -> None:
    repository = _asset_repository(tmp_path)
    created = repository.create(
        CreateAssetRequest(
            asset_id="component1",
            kind=AssetKind.component,
            name="Reusable fragment",
            tags=("vision", "vision", " local "),
            content={"schemaVersion": "f8studio-component/1", "nodes": [], "edges": [], "layout": []},
        )
    )
    updated = repository.update(
        created.asset_id,
        UpdateAssetRequest(
            name="Reusable fragment v2",
            description="tested",
            tags=("vision",),
            content={"schemaVersion": "f8studio-component/1", "nodes": [], "edges": [], "layout": []},
        ),
    )

    assert created.current_version == 1
    assert created.tags == ("vision", "local")
    assert updated.current_version == 1
    assert [version.version for version in repository.versions(created.asset_id)] == [1]
    exported = repository.export(created.asset_id)
    assert exported.schema_version == ASSET_SCHEMA_VERSION
    assert exported.asset.name == "Reusable fragment v2"

    other = _asset_repository(tmp_path / "other")
    imported = other.import_asset(
        AssetExport(schema_version=exported.schema_version, asset=exported.asset, versions=exported.versions)
    )
    assert imported.content == updated.content
    assert imported.current_version == 1
    assert [version.version for version in other.versions(imported.asset_id)] == [1]

    with pytest.raises(ValueError, match="layout must reference component nodes"):
        repository.create(
            CreateAssetRequest(
                kind=AssetKind.component,
                name="Invalid fragment",
                content={
                    "schemaVersion": "f8studio-component/1",
                    "nodes": [],
                    "edges": [],
                    "layout": [{"nodeId": "missing", "x": 0, "y": 0}],
                },
            )
        )


def test_project_versions_restore_as_a_new_revision(tmp_path: Path) -> None:
    project_repository = ProjectRepository(tmp_path / "studio.sqlite3")
    projects = ProjectService(project_repository)
    assets = AssetRepository(project_repository.database_path)
    original = projects.create(CreateProjectRequest(project_id="project1", name="Versioned"))
    version = assets.create_project_version("project1", "Empty", original.document)
    catalog = NodeCatalog(services=[F8ServiceSpec(serviceClass="f8.pyengine", label="Engine")])
    engine = catalog.create_service_node(node_id="engine", service_class="f8.pyengine")
    changed = projects.patch(
        "project1",
        PatchRequest(
            request_id="add-engine",
            expected_graph_revision=0,
            expected_layout_revision=0,
            operations=(CreateNodeOp(node=engine),),
        ),
    )

    restored = projects.restore("project1", assets.get_project_version("project1", version.version_id).document)

    assert len(changed.result.document.nodes) == 1
    assert restored.document.nodes == ()
    assert restored.document.graph_revision == 2
    assert restored.document.layout_revision == 1


def test_editor_sessions_enforce_versions_and_return_structured_diagnostics(tmp_path: Path) -> None:
    editor = EditorSessionService(root=tmp_path / "editor")
    json_session = editor.create(CreateEditorSessionRequest(language="json", filename="schema.json", text="{"))
    json_analysis = editor.analyze(json_session.session_id)
    assert json_analysis.engine == "json"
    assert json_analysis.diagnostics[0].severity == "error"

    python_session = editor.create(
        CreateEditorSessionRequest(language="python", filename="node.py", text="value: int = 'wrong'\n")
    )
    python_analysis = editor.analyze(python_session.session_id)
    assert python_analysis.engine == "basedpyright"
    assert any(item.severity == "error" for item in python_analysis.diagnostics)

    completion_session = editor.create(
        CreateEditorSessionRequest(language="python", filename="completion.py", text="from pathlib import Path\nPath.\n")
    )
    completion = editor.completion(
        completion_session.session_id,
        EditorPositionRequest(line=1, column=5),
    )
    assert completion.result is not None

    updated = editor.update(
        python_session.session_id,
        UpdateEditorDocumentRequest(version=2, text="value: int = 1\n"),
    )
    assert updated.version == 2
    assert editor.analyze(python_session.session_id).diagnostics == ()
    hover = editor.hover(python_session.session_id, EditorPositionRequest(line=0, column=2))
    assert hover.result is not None
    with pytest.raises(ValueError, match="signature help is only available for Python"):
        editor.signature_help(json_session.session_id, EditorPositionRequest(line=0, column=1))
    editor.close_session(python_session.session_id)
    editor.close_session(completion_session.session_id)

    with pytest.raises(ValueError, match="duplicate editor file path"):
        editor.create(
            CreateEditorSessionRequest(
                language="json",
                filename="schema.json",
                text="{}",
                support_files=(EditorSupportFile(path="schema.json", content="null"),),
            )
        )
    assert sorted(path.name for path in (tmp_path / "editor").iterdir()) == [json_session.session_id]


def test_hotkey_contract_normalizes_accelerators() -> None:
    service = LocalIntegrationService()
    binding = service.register_hotkey(
        RegisterHotkeyRequest(
            accelerator="ctrl + shift + k",
            project_id="project1",
            node_id="controls",
            field="trigger",
        )
    )
    assert binding.accelerator == "Ctrl+Shift+K"
    assert service.list_hotkeys() == (binding,)
    with pytest.raises(ValueError, match="already registered"):
        service.register_hotkey(
            RegisterHotkeyRequest(
                accelerator="Ctrl+Shift+K",
                project_id="project1",
                node_id="controls",
                field="otherTrigger",
            )
        )
    service.unregister_hotkey(binding.binding_id)
    assert service.list_hotkeys() == ()


def test_hotkey_activation_preserves_graph_revision_and_syncs_runtime(tmp_path: Path) -> None:
    runtime = HotkeyRuntimeGateway()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    project = studio.projects.create(CreateProjectRequest(project_id="project1", name="Hotkeys"))
    service_node = studio.catalog.create_node(
        CreateCatalogNodeRequest(kind="service", node_id="studio", service_class="f8.pystudio")
    )
    stepper = studio.catalog.create_node(
        CreateCatalogNodeRequest(
            kind="operator",
            node_id="stepper",
            service_class="f8.pystudio",
            service_id="studio",
            operator_class="f8.value_stepper",
        )
    )
    studio.projects.patch(
        project.project_id,
        PatchRequest(
            request_id="create-controls",
            expected_graph_revision=0,
            expected_layout_revision=0,
            operations=(CreateNodeOp(node=service_node), CreateNodeOp(node=stepper)),
        ),
    )
    binding = studio.local.register_hotkey(
        RegisterHotkeyRequest(
            accelerator="Ctrl+Alt+P",
            project_id=project.project_id,
            node_id="stepper",
            field="increaseTrigger",
        )
    )

    asyncio.run(studio._activate_hotkey(binding))

    updated = studio.projects.document(project.project_id)
    updated_stepper = next(node for node in updated.nodes if node.node_id == "stepper")
    assert "increaseTrigger" not in updated_stepper.state_values
    assert updated.graph_revision == 1
    assert runtime.state_calls == [("studio", "stepper", "increaseTrigger", 1)]
    asyncio.run(studio._activate_hotkey(binding))
    assert runtime.state_calls[-1] == ("studio", "stepper", "increaseTrigger", 2)
    assert studio.projects.document(project.project_id).graph_revision == 1
    studio.editor.close()


async def deploy_project(studio: StudioApplication, project_id: str, revision: int, request_id: str = "deploy") -> None:
    job = await studio.tools.deploy(project_id, DeployProjectRequest(request_id=request_id, expected_graph_revision=revision))
    for _ in range(200):
        latest = await studio.jobs.get(job.job_id)
        if latest.status not in {JobStatus.queued, JobStatus.running}:
            assert latest.status is JobStatus.succeeded, latest
            return
        await asyncio.sleep(0.01)
    raise AssertionError("deployment did not finish")


class InMemoryStudioGateway(HotkeyRuntimeGateway):
    """Exercise SDK schema validation instead of accepting every state write."""

    def __init__(self) -> None:
        super().__init__()
        self.bus = ServiceBusHarness().create_bus("studio")
        self.outlet = EventPresentationOutlet(EventJournal(server_epoch="state-sync-test"))
        self.host = ServiceHost(self.bus, config=ServiceHostConfig(service_class=SERVICE_CLASS),
            registry=create_studio_registry(presentation=self.outlet))

    async def deploy(self, *, service_id: str, graph: F8RuntimeGraph, force_apply: bool) -> ServiceDeployResult:
        await self.bus.set_rungraph(graph)
        return await super().deploy(service_id=service_id, graph=graph, force_apply=force_apply)

    async def set_state(self, service_id: str, *, node_id: str, field: str, value: F8JsonValue) -> RuntimeActionResult:
        self.state_calls.append((service_id, node_id, field, value))
        try:
            await self.bus.publish_state_external(node_id, field, value)
        except StateWriteError as exc:
            return RuntimeActionResult(success=False, error_message=str(exc))
        return RuntimeActionResult(success=True)

    async def close(self) -> None:
        await self.host.stop()
        await self.outlet.close()


def test_new_copied_visualization_saves_state_until_its_node_is_deployed(tmp_path: Path) -> None:
    runtime = InMemoryStudioGateway()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    studio.projects.create(CreateProjectRequest(project_id="copied", name="Copied"))
    host = studio.catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id="studio", service_class=SERVICE_CLASS))
    viz = studio.catalog.create_node(CreateCatalogNodeRequest(kind="operator", node_id="viz", service_id="studio",
        service_class=SERVICE_CLASS, operator_class="f8.viz.text"))
    created = studio.projects.patch("copied", PatchRequest(request_id="create", expected_graph_revision=0,
        expected_layout_revision=0, operations=(CreateNodeOp(node=host), CreateNodeOp(node=viz)))).result.document

    async def scenario() -> None:
        try:
            await deploy_project(studio, "copied", created.graph_revision)
            copied = msgspec.structs.replace(viz, node_id="viz_copy")
            added = await studio.tools.apply_patch("copied", PatchRequest(request_id="copy",
                expected_graph_revision=created.graph_revision, expected_layout_revision=0,
                operations=(CreateNodeOp(node=copied),)))
            # The service is alive, but its running graph doesn't contain the new node.
            assert runtime.bus.get_node("viz_copy") is None
            rejected = await runtime.set_state("studio", node_id="viz_copy", field="uiUpdate", value=False)
            assert not rejected.success and "unknown state field" in rejected.error_message
            runtime.state_calls.clear()
            saved = await studio.tools.apply_patch("copied", PatchRequest(request_id="pause_copy",
                expected_graph_revision=added.document.graph_revision, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="viz_copy", field="uiUpdate", value=False),)))
            assert not saved.runtime_errors
            assert not runtime.state_calls
            assert next(node for node in saved.document.nodes if node.node_id == "viz_copy").state_values["uiUpdate"] is False
            # An existing node can still synchronize despite unrelated draft edits.
            synced = await studio.tools.apply_patch("copied", PatchRequest(request_id="pause_original",
                expected_graph_revision=saved.document.graph_revision, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="viz", field="uiUpdate", value=False),)))
            assert not synced.runtime_errors
            assert runtime.state_calls == [("studio", "viz", "uiUpdate", False)]
            await deploy_project(studio, "copied", synced.document.graph_revision, request_id="deploy_copy")
            assert runtime.bus.get_node("viz_copy") is not None
            assert (await runtime.bus.state_store.read_state("viz_copy", "uiUpdate")).value is False
            resumed = await studio.tools.apply_patch("copied", PatchRequest(request_id="resume_copy",
                expected_graph_revision=synced.document.graph_revision, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="viz_copy", field="uiUpdate", value=True),)))
            assert not resumed.runtime_errors
            assert runtime.state_calls[-1] == ("studio", "viz_copy", "uiUpdate", True)
            assert (await runtime.bus.state_store.read_state("viz_copy", "uiUpdate")).value is True
        finally:
            await studio.close()
    asyncio.run(scenario())


def test_old_receipt_cannot_sync_after_restart_or_to_another_project_runtime(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime = InMemoryStudioGateway()
        studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
        try:
            for project_id in ("first", "second"):
                studio.projects.create(CreateProjectRequest(project_id=project_id, name=project_id))
                host = studio.catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id="studio", service_class=SERVICE_CLASS))
                viz = studio.catalog.create_node(CreateCatalogNodeRequest(kind="operator", node_id=project_id, service_id="studio",
                    service_class=SERVICE_CLASS, operator_class="f8.viz.wave"))
                studio.projects.patch(project_id, PatchRequest(request_id="create", expected_graph_revision=0,
                    expected_layout_revision=0, operations=(CreateNodeOp(node=host), CreateNodeOp(node=viz))))
                await deploy_project(studio, project_id, 1)
            first = await studio.tools.apply_patch("first", PatchRequest(request_id="edit_old_project",
                expected_graph_revision=1, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="first", field="uiUpdate", value=False),)))
            assert not first.runtime_errors and not runtime.state_calls
            # A reset process no longer has the successfully deployed rungraph.
            await runtime.deploy(service_id="studio", graph=F8RuntimeGraph(graphId="empty", revision="reset", nodes=[], edges=[]),
                force_apply=True)
            assert runtime.bus.get_node("second") is None
            second = await studio.tools.apply_patch("second", PatchRequest(request_id="edit_reset_runtime",
                expected_graph_revision=1, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="second", field="uiUpdate", value=False),)))
            assert not second.runtime_errors and not runtime.state_calls
        finally:
            await studio.close()
        fresh_runtime = InMemoryStudioGateway()
        restarted = StudioApplication(data_dir=tmp_path, runtime=fresh_runtime, service_roots=())
        try:
            assert (await restarted.jobs.latest("second")).status is JobStatus.succeeded
            offline = await restarted.tools.apply_patch("second", PatchRequest(request_id="edit_after_restart",
                expected_graph_revision=second.document.graph_revision, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="second", field="uiUpdate", value=True),)))
            assert not offline.runtime_errors and not fresh_runtime.state_calls
            await deploy_project(restarted, "second", offline.document.graph_revision, request_id="redeploy")
            synced = await restarted.tools.apply_patch("second", PatchRequest(request_id="live_after_restart",
                expected_graph_revision=offline.document.graph_revision, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="second", field="uiUpdate", value=False),)))
            assert not synced.runtime_errors
            assert fresh_runtime.state_calls == [("studio", "second", "uiUpdate", False)]
        finally:
            await restarted.close()
    asyncio.run(scenario())


def test_added_state_field_waits_for_deployment_even_on_an_existing_operator(tmp_path: Path) -> None:
    runtime = InMemoryStudioGateway()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    studio.projects.create(CreateProjectRequest(project_id="fields", name="Fields"))
    host = studio.catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id="studio", service_class=SERVICE_CLASS))
    panel = studio.catalog.create_node(CreateCatalogNodeRequest(kind="operator", node_id="panel", service_id="studio",
        service_class=SERVICE_CLASS, operator_class="f8.control_panel"))
    assert isinstance(panel, OperatorNode)
    studio.projects.patch("fields", PatchRequest(request_id="create", expected_graph_revision=0, expected_layout_revision=0,
        operations=(CreateNodeOp(node=host), CreateNodeOp(node=panel))))

    async def scenario() -> None:
        try:
            await deploy_project(studio, "fields", 1)
            spec = msgspec.structs.replace(panel.spec, stateFields=[*panel.spec.stateFields,
                F8StateSpec(name="gain", valueSchema=integer_schema(default=1), access=F8StateAccess.rw)])
            saved = await studio.tools.apply_patch("fields", PatchRequest(request_id="new_field", expected_graph_revision=1,
                expected_layout_revision=0, operations=(SetOperatorSpecOp(node_id="panel", spec=spec),
                    SetNodeStateOp(node_id="panel", field="gain", value=2))))
            assert runtime.bus.get_node("panel") is not None
            assert runtime.bus.state_store.access_for(node_id="panel", field="gain") is None
            assert not saved.runtime_errors and not runtime.state_calls
            assert next(node for node in saved.document.nodes if node.node_id == "panel").state_values["gain"] == 2
            await deploy_project(studio, "fields", saved.document.graph_revision, request_id="deploy_field")
            assert (await runtime.bus.state_store.read_state("panel", "gain")).value == 2
            updated = await studio.tools.apply_patch("fields", PatchRequest(request_id="edit_field",
                expected_graph_revision=saved.document.graph_revision, expected_layout_revision=0,
                operations=(SetNodeStateOp(node_id="panel", field="gain", value=3),)))
            assert not updated.runtime_errors
            assert runtime.state_calls == [("studio", "panel", "gain", 3)]
        finally:
            await studio.close()
    asyncio.run(scenario())


def test_state_patch_syncs_deployed_runtime_and_reports_rejection(tmp_path: Path) -> None:
    runtime = HotkeyRuntimeGateway()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    project = studio.projects.create(CreateProjectRequest(project_id="project1", name="State"))
    node = studio.catalog.create_node(
        CreateCatalogNodeRequest(kind="service", node_id="studio", service_class="f8.pystudio")
    )
    created = studio.projects.patch(project.project_id, PatchRequest(
        request_id="create", expected_graph_revision=0, expected_layout_revision=0,
        operations=(CreateNodeOp(node=node),),
    )).result.document

    async def run() -> None:
        first = await studio.tools.apply_patch(project.project_id, PatchRequest(
            request_id="offline", expected_graph_revision=created.graph_revision,
            expected_layout_revision=created.layout_revision,
            operations=(SetNodeStateOp(node_id="studio", field="tickMs", value=100),),
        ))
        assert first.runtime_errors == ()
        assert runtime.state_calls == []

        await deploy_project(studio, project.project_id, first.document.graph_revision)
        request = PatchRequest(
            request_id="online", expected_graph_revision=first.document.graph_revision,
            expected_layout_revision=first.document.layout_revision,
            operations=(SetNodeStateOp(node_id="studio", field="tickMs", value=200),),
        )
        second = await studio.tools.apply_patch(project.project_id, request)
        assert second.runtime_errors == ()
        assert runtime.state_calls == [("studio", "studio", "tickMs", 200)]
        await studio.tools.apply_patch(project.project_id, request)
        assert len(runtime.state_calls) == 1
        runtime.set_state = AsyncMock(return_value=RuntimeActionResult(success=False, error_message="rejected"))
        third = await studio.tools.apply_patch(project.project_id, PatchRequest(
            request_id="rejected", expected_graph_revision=second.document.graph_revision,
            expected_layout_revision=second.document.layout_revision,
            operations=(SetNodeStateOp(node_id="studio", field="tickMs", value=300),),
        ))
        assert third.runtime_errors == ("studio.tickMs: rejected",)
        stream = await studio.events.open_stream(client_epoch=studio.server_epoch, after_sequence=0)
        committed = [event for event in stream.replay if event.type == "graph.committed"]
        assert len(committed) == 3  # Idempotent retries never duplicate events.
        wire_payload = msgspec.json.decode(msgspec.json.encode(committed[-1].payload))
        assert wire_payload["runtimeErrors"] == ["studio.tickMs: rejected"]
        await studio.events.close_stream(stream.subscription_id)

    asyncio.run(run())
    studio.editor.close()


def test_editor_preserves_existing_files_and_bounds_idle_sessions(tmp_path: Path) -> None:
    root = tmp_path / "editor"
    root.mkdir()
    sentinel = root / "existing.txt"
    sentinel.write_text("owned by another session")
    editor = EditorSessionService(root=root, max_sessions=1, idle_timeout_s=10)
    request = CreateEditorSessionRequest(language="json", filename="test.json", text="{}")
    try:
        first = editor.create(request)
        assert sentinel.read_text() == "owned by another session"
        with pytest.raises(ValueError, match="session limit"):
            editor.create(request)
        with patch("f8studio_server.editor.monotonic", return_value=float("inf")):
            editor.reap_idle()
        with pytest.raises(FileNotFoundError):
            editor.get(first.session_id)
        assert not (root / first.session_id).exists()
        assert editor.create(request).session_id != first.session_id
    finally:
        editor.close()
    assert sentinel.exists()


def test_state_sync_cancellation_publishes_committed_document(tmp_path: Path) -> None:
    runtime = HotkeyRuntimeGateway()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    project = studio.projects.create(CreateProjectRequest(project_id="cancel-sync", name="Cancel"))
    node = studio.catalog.create_node(
        CreateCatalogNodeRequest(kind="service", node_id="studio", service_class="f8.pystudio")
    )
    document = studio.projects.patch(project.project_id, PatchRequest(
        request_id="seed", expected_graph_revision=0, expected_layout_revision=0,
        operations=(CreateNodeOp(node=node),),
    )).result.document

    async def run() -> None:
        await deploy_project(studio, project.project_id, document.graph_revision)
        entered = asyncio.Event()
        hold = asyncio.Event()

        async def sync_state(*_args: object, **_kwargs: object) -> RuntimeActionResult:
            entered.set()
            await hold.wait()
            return RuntimeActionResult(success=True)

        runtime.set_state = AsyncMock(side_effect=sync_state)
        task = asyncio.create_task(studio.tools.apply_patch(project.project_id, PatchRequest(
            request_id="cancelled-sync", expected_graph_revision=document.graph_revision,
            expected_layout_revision=document.layout_revision,
            operations=(SetNodeStateOp(node_id="studio", field="tickMs", value=300),),
        )))
        await asyncio.wait_for(entered.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        stream = await studio.events.open_stream(client_epoch=studio.server_epoch, after_sequence=0)
        committed = [event for event in stream.replay if event.type == "graph.committed"]
        assert len(committed) == 1
        event = msgspec.json.decode(msgspec.json.encode(committed[0]))
        assert event['payload']['document']['graphRevision'] == document.graph_revision + 1
        assert event['payload']['runtimeErrors'] == ['Runtime state synchronization cancelled']
        assert studio.projects.document(project.project_id).nodes[0].state_values['tickMs'] == 300
        await studio.events.close_stream(stream.subscription_id)

    try:
        asyncio.run(run())
    finally:
        studio.editor.close()


def test_transient_patch_sends_runtime_once_without_saving_or_changing_updated_at(tmp_path: Path) -> None:
    runtime = HotkeyRuntimeGateway()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    project = studio.projects.create(CreateProjectRequest(project_id="transient", name="Transient"))
    service = studio.catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id="studio", service_class="f8.pystudio"))
    stepper = studio.catalog.create_node(CreateCatalogNodeRequest(kind="operator", node_id="stepper", service_id="studio", service_class="f8.pystudio", operator_class="f8.value_stepper"))
    created = studio.projects.patch(project.project_id, PatchRequest(request_id="create", expected_graph_revision=0, expected_layout_revision=0, operations=(CreateNodeOp(node=service), CreateNodeOp(node=stepper)))).result.document
    timestamp = studio.projects.get(project.project_id).updated_at
    request = PatchRequest(request_id="trigger", expected_graph_revision=created.graph_revision, expected_layout_revision=created.layout_revision,
                           operations=(SetNodeStateOp(node_id="stepper", field="increaseTrigger", value=1),))

    async def run() -> None:
        with patch.object(studio.tools._commits, "publish", new_callable=AsyncMock) as publish:
            result = await studio.tools.apply_patch(project.project_id, request)
            assert result.document == created
            assert not result.graph_changed
            assert not result.runtime_errors
            await studio.tools.apply_patch(project.project_id, request)
            publish.assert_not_called()
        assert runtime.state_calls == [("studio", "stepper", "increaseTrigger", 1)]
        assert studio.projects.get(project.project_id).updated_at == timestamp
        reloaded = ProjectService(ProjectRepository(studio.data_dir / "studio.sqlite3"), spec_resolver=studio.catalog.spec_for_node)
        assert reloaded.document(project.project_id) == created
        assert reloaded.patch(project.project_id, request).replayed

    try:
        asyncio.run(run())
    finally:
        studio.editor.close()
        studio.platform.close()


def test_components_and_presets_remove_private_instance_values_including_historical_exports(tmp_path: Path) -> None:
    from f8pysdk.specs import F8StateSpec, F8StateAccess, integer_schema, string_schema
    from f8studio_core.graph import new_document
    from f8studio_server.assets import ApplicationContent, VariantContent
    from f8studio_core.graph.state_policy import project_document_for_sharing

    spec = F8ServiceSpec(serviceClass="test.policy", label="Policy", stateFields=[
        F8StateSpec(name="path", access=F8StateAccess.rw, valueSchema=string_schema(default="demo.mp4"), publishable=False),
        F8StateSpec(name="gain", access=F8StateAccess.rw, valueSchema=integer_schema(default=1)),
        F8StateSpec(name="trigger", access=F8StateAccess.rw, valueSchema=integer_schema(default=0), persistent=False),
    ])
    repository = AssetRepository(tmp_path / "assets.sqlite3", spec_resolver=lambda service_class, operator_class: spec)
    node = NodeCatalog(services=[spec]).create_service_node(node_id="policy", service_class="test.policy", state_values={"path": "private-real.mp4", "gain": 3})
    component = ApplicationContent(nodes=(node,))
    payload = msgspec.to_builtins(component)
    created = repository.create(CreateAssetRequest(kind=AssetKind.component, name="Policy", content=payload))
    exported = msgspec.json.encode(repository.export(created.asset_id))
    assert b"private-real.mp4" not in exported
    assert b"demo.mp4" in exported
    assert created.content["nodes"][0]["stateValues"] == {"gain": 3}

    # Historical stored components are projected again on reads/export; no archive rewrite.
    with repository._connect() as connection:
        connection.execute("UPDATE local_asset_versions SET content = ? WHERE asset_id = ?", (msgspec.json.encode(payload), created.asset_id))
    assert b"private-real.mp4" not in msgspec.json.encode(repository.versions(created.asset_id))
    assert b"private-real.mp4" not in msgspec.json.encode(repository.export(created.asset_id))
    variant = VariantContent(service_class="test.policy", state_values={"path": "private-real.mp4", "gain": 4, "trigger": 10})
    preset = repository.create(CreateAssetRequest(kind=AssetKind.variant, name="Preset", content=msgspec.to_builtins(variant)))
    assert preset.content["stateValues"] == {"gain": 4}
    assert b"private-real.mp4" not in msgspec.json.encode(repository.export(preset.asset_id))
    other = AssetRepository(tmp_path / "imported.sqlite3", spec_resolver=lambda service_class, operator_class: spec)
    assert other.import_asset(repository.export(preset.asset_id)).content == preset.content
    assert project_document_for_sharing(msgspec.structs.replace(new_document(project_id="local"), nodes=(node,))).nodes[0].spec == node.spec


def test_loading_historical_project_applies_new_installed_runtime_policy(tmp_path: Path) -> None:
    from f8pysdk.specs import F8StateSpec, F8StateAccess, integer_schema
    repository = ProjectRepository(tmp_path / "studio.sqlite3")
    service = ProjectService(repository)
    project = service.create(CreateProjectRequest(project_id="legacy", name="Legacy"))
    old = F8ServiceSpec(serviceClass="test.policy", label="Policy", stateFields=[F8StateSpec(name="trigger", access=F8StateAccess.rw, valueSchema=integer_schema(default=0))])
    node = NodeCatalog(services=[old]).create_service_node(node_id="legacy", service_class="test.policy", state_values={"trigger": 100})
    service.patch(project.project_id, PatchRequest(request_id="old", expected_graph_revision=0, expected_layout_revision=0, operations=(CreateNodeOp(node=node),)))
    current = msgspec.structs.replace(old, stateFields=[msgspec.structs.replace(old.stateFields[0], persistent=False, publishable=False)])
    reloaded = ProjectService(repository, spec_resolver=lambda node: current)
    loaded = reloaded.get(project.project_id)
    assert loaded.document.graph_revision == 1
    assert loaded.document.nodes[0].state_values == {}
    assert loaded.document.nodes[0].spec.stateFields[0].persistent is False


def test_concurrent_runtime_hotkeys_use_distinct_values_without_graph_revisions(tmp_path: Path) -> None:
    class ConcurrentRuntime(HotkeyRuntimeGateway):
        async def read_state(self, service_id: str, *, node_id: str, field: str) -> RuntimeStateField:
            observed = await super().read_state(service_id, node_id=node_id, field=field)
            await asyncio.sleep(0)
            return observed

    runtime = ConcurrentRuntime()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    project = studio.projects.create(CreateProjectRequest(project_id="concurrent", name="Concurrent"))
    service = studio.catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id="studio", service_class="f8.pystudio"))
    stepper = studio.catalog.create_node(CreateCatalogNodeRequest(kind="operator", node_id="stepper", service_id="studio", service_class="f8.pystudio", operator_class="f8.value_stepper"))
    studio.projects.patch(project.project_id, PatchRequest(request_id="create", expected_graph_revision=0, expected_layout_revision=0, operations=(CreateNodeOp(node=service), CreateNodeOp(node=stepper))))
    binding = studio.local.register_hotkey(RegisterHotkeyRequest(accelerator="Ctrl+Alt+P", project_id=project.project_id, node_id="stepper", field="increaseTrigger"))

    async def run() -> None:
        await asyncio.gather(studio._activate_hotkey(binding), studio._activate_hotkey(binding))

    try:
        asyncio.run(run())
        assert [call[3] for call in runtime.state_calls] == [1, 2]
        assert studio.projects.document(project.project_id).graph_revision == 1
    finally:
        studio.editor.close()
        studio.platform.close()


def test_component_without_installed_extension_remains_readable_using_embedded_policy(tmp_path: Path) -> None:
    from f8pysdk.specs import F8StateAccess, F8StateSpec, string_schema
    from f8studio_server.assets import ApplicationContent, VariantContent
    from f8studio_server.errors import InvalidRequestError

    def missing_spec(service_class: str, operator_class: str | None) -> F8ServiceSpec:
        raise KeyError((service_class, operator_class))

    spec = F8ServiceSpec(serviceClass="test.missing", label="Missing", stateFields=[
        F8StateSpec(name="path", access=F8StateAccess.rw, valueSchema=string_schema(default="demo.mp4"), publishable=False),
    ])
    node = NodeCatalog(services=[spec]).create_service_node(node_id="missing", service_class="test.missing", state_values={"path": "private-real.mp4"})
    repository = AssetRepository(tmp_path / "assets.sqlite3", spec_resolver=missing_spec)
    asset = repository.create(CreateAssetRequest(kind=AssetKind.component, name="Missing", content=msgspec.to_builtins(ApplicationContent(nodes=(node,)))))
    assert asset.content["nodes"][0]["stateValues"] == {}
    assert b"private-real.mp4" not in msgspec.json.encode(repository.export(asset.asset_id))
    with pytest.raises(InvalidRequestError, match="install the extension"):
        repository.create(CreateAssetRequest(kind=AssetKind.variant, name="Missing", content=msgspec.to_builtins(VariantContent(service_class="test.missing", state_values={"path": "private-real.mp4"}))))


def test_state_removed_later_in_atomic_patch_is_not_sent_to_runtime(tmp_path: Path) -> None:
    from f8pysdk.specs import F8ServiceSchemaVersion, F8SpecEditPolicy, F8StateAccess, F8StateSpec, editable_collection_edit_policy, integer_schema
    from f8studio_core.graph import SetServiceSpecOp

    runtime = HotkeyRuntimeGateway()
    studio = StudioApplication(data_dir=tmp_path, runtime=runtime, service_roots=())
    project = studio.projects.create(CreateProjectRequest(project_id="atomic", name="Atomic"))
    spec = F8ServiceSpec(schemaVersion=F8ServiceSchemaVersion.f8service_2, serviceClass="test.editable", label="Editable", editPolicy=F8SpecEditPolicy(stateFields=editable_collection_edit_policy()),
                         stateFields=[F8StateSpec(name="trigger", valueSchema=integer_schema(default=0), access=F8StateAccess.rw, persistent=False)])
    studio.catalog.sdk_catalog.register_service(spec)
    node = studio.catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id="editable", service_class="test.editable"))
    request = PatchRequest(request_id="atomic", expected_graph_revision=0, expected_layout_revision=0, operations=(
        CreateNodeOp(node=node), SetNodeStateOp(node_id="editable", field="trigger", value=1),
        SetServiceSpecOp(node_id="editable", spec=msgspec.structs.replace(node.spec, stateFields=[])),
    ))
    try:
        result = asyncio.run(studio.tools.apply_patch(project.project_id, request))
        assert result.graph_changed
        assert not result.runtime_errors
        assert runtime.state_calls == []
        assert result.document.nodes[0].state_values == {}
    finally:
        studio.editor.close()
        studio.platform.close()
