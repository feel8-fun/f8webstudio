"""Studio API: streams."""
from __future__ import annotations

from ..websocket_lifecycle import send_until_disconnect
import logging
from collections.abc import Collection
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from ..application import StudioApplication
from ..presentation_models import StreamHello, LiveSnapshot
from ..http_support import json_value, origin_allowed

logger = logging.getLogger(__name__)

def install_streams_routes(app: FastAPI, studio: StudioApplication, *, resolved_allowed_hosts: Collection[str]) -> None:
    @app.websocket("/api/events")
    async def events(websocket: WebSocket) -> None:
        if not origin_allowed(websocket.headers.get("origin"), resolved_allowed_hosts):
            await websocket.close(code=1008, reason="websocket origin is not allowed")
            return
        after_text = websocket.query_params.get("after")
        try:
            after_sequence = None if after_text is None else int(after_text)
        except ValueError:
            await websocket.close(code=1008, reason="after must be an integer")
            return
        stream = await studio.events.open_stream(
            client_epoch=websocket.query_params.get("epoch"),
            after_sequence=after_sequence,
        )
        await websocket.accept()
        try:
            await websocket.send_json(json_value(StreamHello(
                server_epoch=studio.server_epoch, sequence=stream.current_sequence,
                resumed=not stream.snapshot_required,
            )))
            for event in stream.replay:
                await websocket.send_json(json_value(event))
            async def send_events() -> None:
                while True:
                    event = await stream.queue.get()
                    if event is None:
                        await websocket.close(code=1013, reason="event stream overflow; reconnect with the last processed cursor")
                        return
                    await websocket.send_json(json_value(event))

            await send_until_disconnect(websocket, send_events())
        except WebSocketDisconnect:
            return
        finally:
            await studio.events.close_stream(stream.subscription_id)


    @app.websocket("/api/live")
    async def live_values(websocket: WebSocket) -> None:
        if not origin_allowed(websocket.headers.get("origin"), resolved_allowed_hosts):
            await websocket.close(code=1008, reason="websocket origin is not allowed")
            return
        await websocket.accept()
        subscription, snapshot = studio.events.live.subscribe()
        try:
            await websocket.send_json(json_value(LiveSnapshot(values=snapshot)))
            async def send_patches() -> None:
                while True:
                    patch = await subscription.next_patch()
                    await websocket.send_json(patch)

            await send_until_disconnect(websocket, send_patches())
        except WebSocketDisconnect:
            return
        finally:
            studio.events.live.unsubscribe(subscription)

