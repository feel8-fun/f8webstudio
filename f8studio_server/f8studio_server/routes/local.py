"""Studio API: local."""
from __future__ import annotations

import asyncio
import logging
from fastapi import FastAPI, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from ..application import StudioApplication
from ..local_integration import RegisterHotkeyRequest
from ..http_support import json_value, decode_body

logger = logging.getLogger(__name__)

def install_local_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.get("/api/local/hotkeys")
    async def list_hotkeys(project_id: str | None = None) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.local.list_hotkeys, project_id))


    @app.post("/api/local/hotkeys", status_code=201)
    async def register_hotkey(request: Request) -> F8JsonValue:
        payload = await decode_body(request, RegisterHotkeyRequest)
        return json_value(await asyncio.to_thread(studio.local.register_hotkey, payload))


    @app.delete("/api/local/hotkeys/{binding_id}", status_code=204)
    async def unregister_hotkey(binding_id: str) -> Response:
        await asyncio.to_thread(studio.local.unregister_hotkey, binding_id)
        return Response(status_code=204)

