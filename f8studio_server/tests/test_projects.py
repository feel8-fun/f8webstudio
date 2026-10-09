from pathlib import Path
import asyncio
import sqlite3
from typing import cast
from unittest.mock import AsyncMock

import msgspec
import pytest

from f8pysdk.specs import F8OperatorSpec, F8ServiceSpec
from f8studio_core import compile_document
from f8studio_core.graph import (
    CreateNodeOp,
    IdempotencyConflictError,
    NodeCatalog,
    PatchRequest,
    RenameNodeOp,
    ServiceNode,
    encode_document,
)
from f8studio_server.models import CreateProjectRequest, ServiceDeployResult
from f8studio_server.project_repository import ProjectRepository
from f8studio_server.projects import ProjectService
from f8studio_server.runtime import RuntimeGateway, StudioBoundRuntimeGateway


def build_service(database_path: Path) -> ProjectService:
    return ProjectService(ProjectRepository(database_path))


def test_project_patch_is_persisted_and_idempotent_across_service_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "studio.sqlite3"
    service = build_service(database_path)
    project = service.create(CreateProjectRequest(project_id="project1", name="Example"))
    catalog = NodeCatalog(services=[F8ServiceSpec(serviceClass="f8.pyengine", label="Engine")])
    engine = catalog.create_service_node(node_id="engine", service_class="f8.pyengine")
    request = PatchRequest(
        request_id="create-engine",
        expected_graph_revision=0,
        expected_layout_revision=0,
        operations=(CreateNodeOp(node=engine),),
    )

    first = service.patch(project.project_id, request)
    restarted = build_service(database_path)
    replayed = restarted.patch(project.project_id, request)

    assert first.replayed is False
    assert replayed.replayed is True
    assert replayed.result == first.result
    assert restarted.get(project.project_id).document == first.result.document
    assert restarted.list()[0].graph_revision == 1


def test_project_request_id_conflict_survives_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "studio.sqlite3"
    service = build_service(database_path)
    service.create(CreateProjectRequest(project_id="project1", name="Example"))
    catalog = NodeCatalog(services=[F8ServiceSpec(serviceClass="f8.pyengine", label="Engine")])
    engine = catalog.create_service_node(node_id="engine", service_class="f8.pyengine")
    service.patch(
        "project1",
        PatchRequest(
            request_id="request1",
            expected_graph_revision=0,
            expected_layout_revision=0,
            operations=(CreateNodeOp(node=engine),),
        ),
    )

    restarted = build_service(database_path)
    with pytest.raises(IdempotencyConflictError):
        restarted.patch(
            "project1",
            PatchRequest(
                request_id="request1",
                expected_graph_revision=1,
                expected_layout_revision=0,
                operations=(),
            ),
        )


def test_historical_copied_studio_hosts_load_and_deploy_as_one_runtime(tmp_path: Path) -> None:
    database_path = tmp_path / "studio.sqlite3"
    service = build_service(database_path)
    project = service.create(CreateProjectRequest(project_id="copied", name="Copied graph"))
    catalog = NodeCatalog(services=[F8ServiceSpec(serviceClass="f8.pystudio", label="Runtime")], operators=[
        F8OperatorSpec(serviceClass="f8.pystudio", operatorClass="f8.viz.text", label="Text"),
    ])
    host = catalog.create_service_node(node_id="studio", service_class="f8.pystudio")
    cloned_host = msgspec.structs.replace(host, node_id="service_bad_copy", service_id="service_bad_copy")
    viz = catalog.create_operator_node(node_id="viz", service_id="studio", service_class="f8.pystudio", operator_class="f8.viz.text")
    cloned_viz = msgspec.structs.replace(viz, node_id="viz_copy", service_id="service_bad_copy")
    historical = msgspec.structs.replace(project.document, graph_revision=8, layout_revision=3,
        nodes=(host, viz, cloned_host, cloned_viz))
    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE projects SET graph_revision = ?, layout_revision = ?, document = ? WHERE project_id = ?",
            (8, 3, encode_document(historical), "copied"))
    restarted = build_service(database_path)
    repaired = restarted.get("copied").document
    assert (repaired.graph_revision, repaired.layout_revision) == (8, 3)
    assert restarted.summary("copied").graph_revision == 8
    assert [node.node_id for node in repaired.nodes if isinstance(node, ServiceNode)] == ["studio"]
    assert next(node for node in repaired.nodes if node.node_id == "viz_copy").service_id == "studio"
    compiled = compile_document(repaired)
    assert set(compiled.per_service) == {"studio"}

    async def deploy() -> None:
        remote = AsyncMock()
        remote.deploy.return_value = ServiceDeployResult(service_id="studio_local", success=True)
        gateway = StudioBoundRuntimeGateway(cast(RuntimeGateway, remote), studio_service_id="studio_local")
        result = await gateway.deploy(service_id="studio", graph=compiled.per_service["studio"], force_apply=False)
        assert result.success
        remote.deploy.assert_awaited_once()
        bound = remote.deploy.await_args.kwargs["graph"]
        assert {(node.nodeId, node.serviceId) for node in bound.nodes} == {
            ("studio_local", "studio_local"), ("viz", "studio_local"), ("viz_copy", "studio_local"),
        }
    asyncio.run(deploy())
    updated = restarted.patch("copied", PatchRequest(request_id="edit", expected_graph_revision=8,
        expected_layout_revision=3, operations=(RenameNodeOp(node_id="viz_copy", name="Copied Text"),))).result.document
    assert updated.graph_revision == 9
    assert build_service(database_path).get("copied").document == updated
    with sqlite3.connect(database_path) as connection:
        saved = connection.execute("SELECT document FROM projects WHERE project_id = 'copied'").fetchone()[0]
    assert "service_bad_copy" not in saved.decode()
