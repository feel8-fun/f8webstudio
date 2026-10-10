"""Studio API: media."""
from __future__ import annotations

import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from f8media_protocol.models import AudioSessionOffer, MediaSessionOffer, OverlayResult
from ..application import StudioApplication
from ..models import BrowserRtcConfiguration
from ..http_support import json_value, decode_body

logger = logging.getLogger(__name__)

def install_media_routes(app: FastAPI, studio: StudioApplication, *, rtc_configuration: BrowserRtcConfiguration | None) -> None:
    @app.get("/api/media/rtc-configuration")
    async def media_rtc_configuration() -> F8JsonValue:
        return json_value(rtc_configuration or BrowserRtcConfiguration())


    @app.get("/api/presentation")
    async def presentation_snapshot() -> F8JsonValue:
        return json_value(studio.presentation.snapshot())


    @app.post("/api/media/sessions", status_code=201)
    async def create_media_session(request: Request) -> F8JsonValue:
        offer = await decode_body(request, MediaSessionOffer)
        return json_value(await studio.media_gateway.create_video_session(offer))


    @app.post("/api/audio/sessions", status_code=201)
    async def create_audio_session(request: Request) -> F8JsonValue:
        offer = await decode_body(request, AudioSessionOffer)
        return json_value(await studio.media_gateway.create_audio_session(offer))


    @app.delete("/api/audio/sessions/{session_id}", status_code=204)
    async def close_audio_session(session_id: str) -> Response:
        closed = await studio.media_gateway.close_audio_session(session_id)
        if not closed:
            raise HTTPException(status_code=404, detail="audio session not found")
        return Response(status_code=204)


    @app.post("/api/media/overlays", status_code=202)
    async def publish_media_overlay(request: Request) -> F8JsonValue:
        result = await decode_body(request, OverlayResult)
        await studio.media_gateway.publish_overlay(result)
        return {"accepted": True}


    @app.get("/api/media/sessions/{session_id}/media-timestamps/{media_timestamp}")
    async def media_frame_mapping(session_id: str, media_timestamp: int) -> F8JsonValue:
        mapping = await studio.media_gateway.frame_mapping(session_id, media_timestamp)
        if mapping is None:
            raise HTTPException(status_code=404, detail="media frame mapping not found")
        return json_value(mapping)


    @app.get("/api/media/metrics")
    async def media_metrics() -> F8JsonValue:
        return json_value(await studio.media_gateway.metrics())


    @app.get("/api/media/gateway")
    async def media_gateway_health() -> F8JsonValue:
        return json_value(await studio.media_gateway.health())


    @app.get("/api/media/sample")
    async def sample_media(source: str, x: int, y: int) -> F8JsonValue:
        try:
            return json_value(await studio.media_gateway.sample(source, x=x, y=y))
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail=f"media source did not produce a frame: {source}") from exc


    @app.delete("/api/media/sessions/{session_id}", status_code=204)
    async def close_media_session(session_id: str) -> Response:
        closed = await studio.media_gateway.close_video_session(session_id)
        if not closed:
            raise HTTPException(status_code=404, detail="media session not found")
        return Response(status_code=204)

