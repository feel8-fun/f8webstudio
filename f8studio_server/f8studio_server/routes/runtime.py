"""Studio API: runtime."""
from __future__ import annotations

from f8studio_server.errors import InvalidRequestError
import asyncio
import logging
from collections.abc import Awaitable
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from f8studio_core.graph import HistoryRequest, PatchRequest
from ..application import StudioApplication
from ..models import DeployProjectRequest, RuntimeNodeState, RuntimeStateReadRequest, ServiceActiveRequest, ServiceCommandRequest, ServiceStartRequest, ServiceStateRequest, ValidateDocumentRequest
from ..http_support import json_value, decode_body, patch_payload

logger = logging.getLogger(__name__)

def install_runtime_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.get("/api/runtime/monitors")
    async def runtime_monitors(project_id: str | None = None) -> F8JsonValue:
        return await studio.tools.monitor_snapshot(project_id)


    @app.post("/api/projects/{project_id}/validate")
    async def validate_project(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, ValidateDocumentRequest)
        if payload.document.project_id != project_id:
            raise InvalidRequestError("document projectId does not match route project id")
        await asyncio.to_thread(studio.tools.validate_document, payload.document)
        return {
            "valid": True,
            "graphRevision": payload.document.graph_revision,
            "layoutRevision": payload.document.layout_revision,
        }


    async def runtime_result(operation: str, call: Awaitable[object]) -> F8JsonValue:
        try:
            return json_value(await call)
        except (TimeoutError, OSError, RuntimeError, ValueError) as exc:
            logger.warning("runtime request failed operation=%s", operation, exc_info=exc)
            await studio.events.publish(
                event_type="runtime.error",
                scope="server",
                payload={"operation": operation, "message": f"{type(exc).__name__}: {exc}"},
            )
            raise HTTPException(status_code=503, detail=f"{type(exc).__name__}: {exc}") from exc


    @app.post("/api/projects/{project_id}/patch")
    async def patch_project(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, PatchRequest)
        return patch_payload(await studio.tools.apply_patch(project_id, payload))


    @app.post("/api/projects/{project_id}/patch:preview")
    async def preview_project_patch(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, PatchRequest)
        result = await asyncio.to_thread(studio.tools.preview_patch, project_id, payload)
        return patch_payload(result)


    @app.post("/api/projects/{project_id}/undo")
    async def undo_project(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, HistoryRequest)
        return patch_payload(await studio.tools.undo(project_id, payload))


    @app.post("/api/projects/{project_id}/redo")
    async def redo_project(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, HistoryRequest)
        return patch_payload(await studio.tools.redo(project_id, payload))


    @app.post("/api/projects/{project_id}/deploy", status_code=202)
    async def deploy_project(project_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, DeployProjectRequest)
        return json_value(await studio.tools.deploy(project_id, payload))


    @app.get("/api/projects/{project_id}/deployments/latest")
    async def latest_deployment(project_id: str) -> F8JsonValue:
        await asyncio.to_thread(studio.projects.summary, project_id)
        return json_value(await studio.jobs.latest(project_id))


    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str) -> F8JsonValue:
        return json_value(await studio.jobs.get(job_id))


    @app.delete("/api/jobs/{job_id}")
    async def cancel_job(job_id: str) -> F8JsonValue:
        return json_value(await studio.jobs.cancel(job_id))


    @app.post("/api/runtime/services/{service_id}/start")
    async def start_service(service_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, ServiceStartRequest)
        return json_value(await studio.processes.start(service_id, service_class=payload.service_class))


    @app.post("/api/projects/{project_id}/stop", status_code=204)
    async def stop_project(project_id: str) -> Response:
        await studio.lifecycle.stop(project_id)
        return Response(status_code=204)


    @app.post("/api/runtime/services/{service_id}/stop")
    async def stop_service(service_id: str) -> F8JsonValue:
        return json_value(await studio.lifecycle.stop_service(service_id))


    @app.post("/api/projects/{project_id}/services/{service_id}/restart", status_code=202)
    async def restart_project_service(project_id: str, service_id: str) -> F8JsonValue:
        return json_value(await studio.lifecycle.restart_service(project_id, service_id))


    @app.get("/api/runtime/services/{service_id}/status")
    async def service_status(service_id: str) -> F8JsonValue:
        return await runtime_result(f"status:{service_id}", studio.runtime.status(service_id))


    @app.post("/api/runtime/services/{service_id}/active")
    async def set_service_active(service_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, ServiceActiveRequest)
        return await runtime_result(
            f"active:{service_id}",
            studio.runtime.set_active(service_id, active=payload.active),
        )


    @app.post("/api/runtime/services/{service_id}/state")
    async def set_service_state(service_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, ServiceStateRequest)
        return await runtime_result(
            f"state:{service_id}",
            studio.runtime.set_state(
                service_id,
                node_id=payload.node_id,
                field=payload.field,
                value=payload.value,
            ),
        )


    @app.post("/api/runtime/services/{service_id}/nodes/{node_id}/state:read")
    async def read_node_state(service_id: str, node_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, RuntimeStateReadRequest)
        normalized_fields = tuple(dict.fromkeys(field.strip() for field in payload.fields if field.strip()))
        if len(normalized_fields) > 128:
            raise HTTPException(status_code=422, detail="at most 128 state fields may be read at once")
        fields = await asyncio.gather(
            *(studio.runtime.read_state(service_id, node_id=node_id, field=field) for field in normalized_fields)
        )
        return json_value(RuntimeNodeState(service_id=service_id, node_id=node_id, fields=tuple(fields)))


    @app.post("/api/runtime/services/{service_id}/commands")
    async def invoke_service_command(service_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, ServiceCommandRequest)
        return await runtime_result(
            f"command:{service_id}",
            studio.runtime.invoke_command(
                service_id,
                call=payload.call,
                params=payload.params,
            ),
        )

