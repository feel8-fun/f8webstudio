"""Studio API: editor."""
from __future__ import annotations

from f8studio_server.errors import InvalidRequestError, NotFoundError
import asyncio
import logging
import msgspec
from fastapi import FastAPI, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from ..application import StudioApplication
from ..editor import CreateEditorSessionRequest, EditorPositionRequest, UpdateEditorDocumentRequest
from ..editor_context import editor_support_files
from ..http_support import json_value, decode_body

logger = logging.getLogger(__name__)

def install_editor_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.post("/api/editor/sessions", status_code=201)
    async def create_editor_session(request: Request) -> F8JsonValue:
        payload = await decode_body(request, CreateEditorSessionRequest)
        target = (payload.project_id, payload.node_id, payload.field_name)
        if any(target):
            if not all(target):
                raise InvalidRequestError("projectId, nodeId, and fieldName are all required for a code field")
            document = await asyncio.to_thread(studio.projects.document, payload.project_id)
            node = next((item for item in document.nodes if item.node_id == payload.node_id), None)
            if node is None:
                raise NotFoundError(f"code editor node not found: {payload.node_id}")
            support_files = editor_support_files(node, payload.field_name)
            payload = msgspec.structs.replace(payload, support_files=support_files)
        return json_value(await asyncio.to_thread(studio.editor.create, payload))


    @app.get("/api/editor/sessions/{session_id}")
    async def get_editor_session(session_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.editor.get, session_id))


    @app.put("/api/editor/sessions/{session_id}")
    async def update_editor_session(session_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, UpdateEditorDocumentRequest)
        return json_value(await asyncio.to_thread(studio.editor.update, session_id, payload))


    @app.post("/api/editor/sessions/{session_id}/analyze")
    async def analyze_editor_session(session_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.editor.analyze, session_id))


    @app.post("/api/editor/sessions/{session_id}/completion")
    async def editor_completion(session_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, EditorPositionRequest)
        return json_value(await asyncio.to_thread(studio.editor.completion, session_id, payload))


    @app.post("/api/editor/sessions/{session_id}/hover")
    async def editor_hover(session_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, EditorPositionRequest)
        return json_value(await asyncio.to_thread(studio.editor.hover, session_id, payload))


    @app.post("/api/editor/sessions/{session_id}/signature-help")
    async def editor_signature_help(session_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, EditorPositionRequest)
        return json_value(await asyncio.to_thread(studio.editor.signature_help, session_id, payload))


    @app.delete("/api/editor/sessions/{session_id}", status_code=204)
    async def close_editor_session(session_id: str) -> Response:
        await asyncio.to_thread(studio.editor.close_session, session_id)
        return Response(status_code=204)

