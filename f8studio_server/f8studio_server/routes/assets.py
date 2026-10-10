"""Studio API: assets."""
from __future__ import annotations

import asyncio
import logging
from fastapi import FastAPI, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from ..application import StudioApplication
from ..assets import AssetExport, AssetKind, CreateAssetRequest, UpdateAssetRequest
from ..http_support import json_value, decode_body

logger = logging.getLogger(__name__)

def install_assets_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.get("/api/assets")
    async def list_assets(kind: AssetKind | None = None) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.assets.list_assets, kind))


    @app.post("/api/assets", status_code=201)
    async def create_asset(request: Request) -> F8JsonValue:
        payload = await decode_body(request, CreateAssetRequest)
        record = await asyncio.to_thread(studio.assets.create, payload)
        await studio.events.publish(event_type="asset.created", scope=f"asset:{record.asset_id}", payload=json_value(record))
        return json_value(record)


    @app.post("/api/assets/import", status_code=201)
    async def import_asset(request: Request) -> F8JsonValue:
        payload = await decode_body(request, AssetExport)
        record = await asyncio.to_thread(studio.assets.import_asset, payload)
        await studio.events.publish(event_type="asset.created", scope=f"asset:{record.asset_id}", payload=json_value(record))
        return json_value(record)


    @app.get("/api/assets/{asset_id}")
    async def get_asset(asset_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.assets.get, asset_id))


    @app.put("/api/assets/{asset_id}")
    async def update_asset(asset_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, UpdateAssetRequest)
        record = await asyncio.to_thread(studio.assets.update, asset_id, payload)
        await studio.events.publish(event_type="asset.updated", scope=f"asset:{record.asset_id}", payload=json_value(record))
        return json_value(record)


    @app.delete("/api/assets/{asset_id}", status_code=204)
    async def delete_asset(asset_id: str) -> Response:
        await asyncio.to_thread(studio.assets.delete, asset_id)
        await studio.events.publish(event_type="asset.deleted", scope=f"asset:{asset_id}", payload={"assetId": asset_id})
        return Response(status_code=204)


    @app.get("/api/assets/{asset_id}/versions")
    async def list_asset_versions(asset_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.assets.versions, asset_id))


    @app.get("/api/assets/{asset_id}/export")
    async def export_asset(asset_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.assets.export, asset_id))


    @app.get("/api/variants")
    async def list_variants() -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.assets.variant_catalog))


    @app.get("/api/assets/{asset_id}/versions/{version}/preview")
    async def preview_component(asset_id: str, version: int) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.tools.component_preview, asset_id, version))

