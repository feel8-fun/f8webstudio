"""Studio API: status."""
from __future__ import annotations

from f8studio_server.errors import InvalidRequestError
import logging
import os
from fastapi import FastAPI
from f8pysdk.specs import F8JsonValue
from f8studio_core import API_PROTOCOL_VERSION, HealthStatus, ServerCapabilities
from ..application import StudioApplication
from ..http_support import SERVER_VERSION, json_value

logger = logging.getLogger(__name__)

def install_status_routes(app: FastAPI, studio: StudioApplication, *, has_web_assets: bool) -> None:
    @app.get("/api/health")
    async def health() -> F8JsonValue:
        status = HealthStatus(
            status="ok",
            service="f8studio-server",
            version=SERVER_VERSION,
            protocol_version=API_PROTOCOL_VERSION,
            server_epoch=studio.server_epoch,
            application_instance=os.environ.get("F8_APPLICATION_INSTANCE"),
        )
        return status.to_json_object()


    @app.get("/api/logs")
    async def recent_logs(limit: int = 500, before_sequence: int | None = None) -> F8JsonValue:
        if limit < 1 or limit > 1000:
            raise InvalidRequestError("log limit must be between 1 and 1000")
        if before_sequence is not None and before_sequence < 1:
            raise InvalidRequestError("before_sequence must be positive")
        return json_value(await studio.events.recent_logs(limit=limit, before_sequence=before_sequence))


    @app.get("/api/capabilities")
    async def capabilities() -> F8JsonValue:
        report = ServerCapabilities(
            graph_editing=True,
            runtime_control=True,
            web_assets=has_web_assets,
            web_rtc_video=True,
            web_rtc_audio=True,
            three_d=True,
            agent_tools=True,
        )
        from f8studio_core.publication import PublicationCapabilities
        return {"protocol_version": API_PROTOCOL_VERSION, "capabilities": report.to_json_object(),
                "publication": json_value(PublicationCapabilities())}

