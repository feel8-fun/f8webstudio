"""Studio API: catalog."""
from __future__ import annotations

import asyncio
import logging
from fastapi import FastAPI, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from ..application import StudioApplication
from ..api_contracts import ROUTES
from ..models import CreateCatalogNodeRequest
from ..http_support import json_value, decode_body

logger = logging.getLogger(__name__)

def install_catalog_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.get("/api/catalog")
    async def catalog() -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.catalog.refresh))


    @app.post("/api/catalog/refresh")
    async def refresh_catalog() -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.catalog.refresh))


    async def platform_management(request: Request) -> Response:
        response = await asyncio.to_thread(studio.platform.request, request.method,
            request.url.path, content=await request.body(), params=str(request.url.query))
        if request.method != 'GET' and response.is_success and response.status_code != 202:
            await asyncio.to_thread(studio.catalog.refresh)
        headers = {name: value for name, value in response.headers.items()
                   if name in {'content-type', 'content-disposition'}}
        return Response(response.content, status_code=response.status_code, headers=headers)


    management_prefixes = ('/api/extensions', '/api/environments', '/api/extension-tools',
                           '/api/tool-jobs', '/api/extension-resources', '/api/applications', '/api/source-applications',
                           '/api/management-jobs')


    for contract in ROUTES:
        if contract.path.startswith(management_prefixes):
            app.add_api_route(contract.path, platform_management, methods=[contract.method.upper()],
                              status_code=contract.status)


    @app.post("/api/catalog/nodes")
    async def create_catalog_node(request: Request) -> F8JsonValue:
        payload = await decode_body(request, CreateCatalogNodeRequest)
        return json_value(await asyncio.to_thread(studio.catalog.create_node, payload))

