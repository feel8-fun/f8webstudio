from __future__ import annotations
from collections.abc import Awaitable, Callable
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from f8pysdk.specs import F8JsonValue
from .application import StudioApplication
from .cloud_client import CloudRequestError
from .cloud_models import CloudSettingsRequest, CloudPublishRequest, CloudGraphPublishRequest, CloudGraphOpenRequest, CloudMetadataRequest
from .component_models import CloudReference, InsertCloudComponentRequest
from .errors import InvalidRequestError, api_error

def install_cloud_routes(app: FastAPI, studio: StudioApplication, read: Callable[[Request,type[object]], Awaitable[object]],
                         json_value: Callable[[object],F8JsonValue]) -> None:
    @app.exception_handler(CloudRequestError)
    async def cloud_error(_request: Request, exc: CloudRequestError):
        return api_error(exc.status,exc.code,str(exc))

    async def payload(request: Request, model: type[object]) -> object:
        return await read(request, model)

    @app.get("/api/cloud/status")
    async def status():
        return json_value(studio.cloud.client.status())

    @app.put("/api/cloud/settings")
    async def configure(request: Request):
        value = await payload(request,CloudSettingsRequest)
        if not isinstance(value,CloudSettingsRequest): raise TypeError("Expected Cloud settings")
        return json_value(await studio.cloud.client.configure(value.base_url))

    @app.post("/api/cloud/auth/start")
    async def start(request: Request):
        return json_value(studio.cloud.client.begin_login(str(request.url_for("cloud_callback"))))

    @app.get("/api/cloud/auth/callback", name="cloud_callback")
    async def callback(request: Request):
        code,state = request.query_params.get("code"),request.query_params.get("state")
        if not code or not state: raise InvalidRequestError("Cloud authorization requires code and state")
        await studio.cloud.client.complete_login(code=code,state=state)
        # A local page starts a fresh same-origin navigation. A redirect chain
        # from Cloud would withhold Studio's SameSite=Strict access cookie.
        return HTMLResponse('<!doctype html><title>Cloud sign-in complete</title><p>Signed in. <a href="/?view=assets">Return to Studio</a></p><script>location.replace("/?view=assets")</script>',
            headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer"})

    @app.post("/api/cloud/auth/logout")
    async def logout():
        return json_value(await studio.cloud.client.logout())

    @app.get("/api/cloud/library")
    async def search(request: Request):
        return json_value(await studio.cloud.search(query=request.query_params.get("q",""),cursor=request.query_params.get("cursor",""),view=request.query_params.get("view","all")))

    @app.get("/api/cloud/library/{asset_id}")
    async def asset(asset_id: str):
        return json_value(await studio.cloud.asset(asset_id))

    @app.get("/api/cloud/library/{asset_id}/versions")
    async def versions(asset_id: str):
        return json_value(await studio.cloud.versions(asset_id))

    @app.post("/api/cloud/templates:preview")
    async def preview(request: Request):
        value = await payload(request,CloudReference)
        if not isinstance(value,CloudReference): raise TypeError("Expected Cloud reference")
        return json_value(await studio.cloud.preview(value))

    @app.post("/api/cloud/graphs:preview")
    async def graph_preview(request: Request):
        value = await payload(request,CloudReference)
        if not isinstance(value,CloudReference): raise TypeError("Expected Cloud reference")
        return json_value(await studio.cloud.graph_preview(value))

    @app.post("/api/cloud/graphs:open")
    async def open_graph(request: Request):
        value = await payload(request,CloudGraphOpenRequest)
        if not isinstance(value,CloudGraphOpenRequest): raise TypeError("Expected Cloud graph options")
        result = await studio.cloud.open_graph(value.reference,name=value.name)
        await studio.events.publish(event_type="project.created",scope="projects",payload=json_value(result))
        return json_value(result)

    @app.post("/api/projects/{project_id}/cloud:insert")
    async def insert(project_id: str, request: Request):
        value = await payload(request,InsertCloudComponentRequest)
        if not isinstance(value,InsertCloudComponentRequest): raise TypeError("Expected Cloud insertion request")
        return json_value(await studio.cloud.insert(project_id,value))

    @app.post("/api/cloud/drafts")
    async def draft(request: Request):
        value = await payload(request,CloudReference)
        if not isinstance(value,CloudReference): raise TypeError("Expected Cloud reference")
        result = await studio.cloud.draft(value)
        await studio.events.publish(event_type="asset.created",scope="assets",payload=json_value(result))
        return json_value(result)

    @app.get("/api/assets/{asset_id}/cloud")
    async def link(asset_id: str):
        return json_value(studio.cloud.draft_link(asset_id))

    @app.get("/api/projects/{project_id}/cloud")
    async def project_link(project_id: str):
        return json_value(studio.cloud.draft_link("project:"+project_id))

    @app.post("/api/assets/{asset_id}/cloud:publish")
    async def publish(asset_id: str, request: Request):
        value = await payload(request,CloudPublishRequest)
        if not isinstance(value,CloudPublishRequest): raise TypeError("Expected Cloud publication options")
        return json_value(await studio.cloud.publish(asset_id,value))

    @app.put("/api/assets/{asset_id}/cloud:metadata")
    async def metadata(asset_id: str, request: Request):
        value = await payload(request,CloudMetadataRequest)
        if not isinstance(value,CloudMetadataRequest): raise TypeError("Expected Cloud listing metadata")
        return json_value(await studio.cloud.update_metadata(asset_id,value))

    @app.put("/api/projects/{project_id}/cloud:metadata")
    async def project_metadata(project_id: str, request: Request):
        value = await payload(request,CloudMetadataRequest)
        if not isinstance(value,CloudMetadataRequest): raise TypeError("Expected Cloud listing metadata")
        return json_value(await studio.cloud.update_metadata("project:"+project_id,value))

    @app.post("/api/projects/{project_id}/cloud:publish")
    async def publish_graph(project_id: str, request: Request):
        value = await payload(request,CloudGraphPublishRequest)
        if not isinstance(value,CloudGraphPublishRequest): raise TypeError("Expected Cloud graph publication options")
        return json_value(await studio.cloud.publish_graph(project_id,value))

    @app.get("/api/cloud/library/{asset_id}/relations")
    async def relations(asset_id: str):
        return json_value(await studio.cloud.relations(asset_id))

    @app.put("/api/cloud/library/{asset_id}/relations/{action}")
    async def relate(asset_id: str, action: str):
        return json_value(await studio.cloud.relate(asset_id,action,True))

    @app.delete("/api/cloud/library/{asset_id}/relations/{action}")
    async def unrelate(asset_id: str, action: str):
        return json_value(await studio.cloud.relate(asset_id,action,False))
