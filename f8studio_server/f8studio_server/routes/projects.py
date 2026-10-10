"""Studio API: projects."""
from __future__ import annotations

import asyncio
import logging
from fastapi import FastAPI, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from f8studio_core.graph import RevisionConflictError, export_graph
from ..application import StudioApplication
from ..assets import CreateProjectVersionRequest, UpdateProjectVersionRequest
from ..models import CreateProjectRequest, UpdateProjectRequest
from ..http_support import json_value, decode_body

logger = logging.getLogger(__name__)

def install_projects_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.get("/api/projects")
    async def list_projects() -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.projects.list))


    @app.post("/api/projects", status_code=201)
    async def create_project(request: Request) -> F8JsonValue:
        payload = await decode_body(request, CreateProjectRequest)
        record = await asyncio.to_thread(studio.projects.create, payload)
        await studio.events.publish(
            event_type="project.created",
            scope=f"project:{record.project_id}",
            payload=json_value(record),
        )
        return json_value(record)


    @app.get("/api/projects/{project_id}")
    async def get_project(project_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.projects.get, project_id))


    @app.delete("/api/projects/{project_id}", status_code=204)
    async def delete_project(project_id: str) -> Response:
        await studio.lifecycle.delete(project_id)
        return Response(status_code=204)


    @app.get("/api/projects/{project_id}/graph/export")
    async def export_project_graph(project_id: str) -> Response:
        document = await asyncio.to_thread(studio.projects.document, project_id)
        return Response(content=export_graph(document), media_type="application/json")


    @app.post("/api/projects/{project_id}/graph/share")
    async def export_shared_project_graph(project_id: str, request: Request) -> Response:
        from ..assets import ShareGraphRequest
        from f8studio_core.graph.exchange import export_shared_graph

        payload = await decode_body(request, ShareGraphRequest)
        document = await asyncio.to_thread(studio.projects.document, project_id)
        if (document.graph_revision != payload.expected_graph_revision or
                document.layout_revision != payload.expected_layout_revision):
            raise RevisionConflictError("project changed before sharing; refresh and retry")
        return Response(content=export_shared_graph(document, excluded_states=payload.excluded_states),
                        media_type="application/json")


    @app.post("/api/projects/{project_id}/components", status_code=201)
    async def capture_project_component(project_id: str, request: Request) -> F8JsonValue:
        from ..assets import CaptureComponentRequest
        payload = await decode_body(request, CaptureComponentRequest)
        record = await asyncio.to_thread(studio.tools.capture_component, project_id, payload)
        await studio.events.publish(event_type="asset.created", scope=f"asset:{record.asset_id}", payload=json_value(record))
        return json_value(record)


    @app.get("/api/projects/{project_id}/variants")
    async def project_variant_sources(project_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.projects.variant_sources, project_id))


    @app.post("/api/projects/{project_id}/variants", status_code=201)
    async def capture_project_variant(project_id: str, request: Request) -> F8JsonValue:
        from ..variant_models import CaptureVariantRequest
        payload = await decode_body(request, CaptureVariantRequest)
        record = await asyncio.to_thread(studio.tools.capture_variant, project_id, payload)
        await studio.events.publish(event_type="asset.updated" if payload.asset_id else "asset.created",
            scope=f"asset:{record.asset_id}", payload=json_value(record))
        return json_value(record)


    @app.post("/api/projects/{project_id}/components:preview")
    async def preview_component_insertion(project_id: str, request: Request) -> F8JsonValue:
        from ..component_models import InsertComponentRequest
        payload = await decode_body(request, InsertComponentRequest)
        return json_value(await asyncio.to_thread(studio.tools.preview_component_insertion, project_id, payload))


    @app.post("/api/projects/{project_id}/components:insert")
    async def insert_component(project_id: str, request: Request) -> F8JsonValue:
        from ..component_models import InsertComponentRequest
        payload = await decode_body(request, InsertComponentRequest)
        return json_value(await studio.tools.insert_component(project_id, payload))


    @app.post("/api/projects/{project_id}/graph/import")
    async def import_project_graph(project_id: str, request: Request,
                                   expected_graph_revision: int | None = None,
                                   expected_layout_revision: int | None = None) -> F8JsonValue:
        return json_value(await studio.lifecycle.import_graph(
            project_id, await request.body(), expected_graph_revision=expected_graph_revision,
            expected_layout_revision=expected_layout_revision,
        ))


    @app.put("/api/projects/{project_id}")
    async def update_project(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, UpdateProjectRequest)
        record = await asyncio.to_thread(studio.projects.update, project_id, payload)
        await studio.events.publish(
            event_type="project.updated",
            scope=f"project:{project_id}",
            payload=json_value(record),
        )
        return json_value(record)


    @app.get("/api/projects/{project_id}/versions")
    async def list_project_versions(project_id: str) -> F8JsonValue:
        await asyncio.to_thread(studio.projects.get, project_id)
        return json_value(await asyncio.to_thread(studio.assets.list_project_versions, project_id))


    @app.post("/api/projects/{project_id}/versions", status_code=201)
    async def create_project_version(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, CreateProjectVersionRequest)
        record = await asyncio.to_thread(studio.projects.get, project_id)
        version = await asyncio.to_thread(
            studio.assets.create_project_version,
            project_id,
            payload.name,
            record.document,
            payload.description,
        )
        return json_value(version)


    @app.put("/api/projects/{project_id}/versions/{version_id}")
    async def update_project_version(project_id: str, version_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, UpdateProjectVersionRequest)
        await asyncio.to_thread(studio.projects.get, project_id)
        return json_value(await asyncio.to_thread(studio.assets.update_project_version, project_id, version_id, payload))


    @app.delete("/api/projects/{project_id}/versions/{version_id}", status_code=204)
    async def delete_project_version(project_id: str, version_id: str) -> Response:
        await asyncio.to_thread(studio.projects.get, project_id)
        await asyncio.to_thread(studio.assets.delete_project_version, project_id, version_id)
        return Response(status_code=204)


    @app.post("/api/projects/{project_id}/versions/{version_id}/restore")
    async def restore_project_version(project_id: str, version_id: str) -> F8JsonValue:
        return json_value(await studio.lifecycle.restore_version(project_id, version_id))

