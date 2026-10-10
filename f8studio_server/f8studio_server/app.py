from __future__ import annotations


from f8studio_server.errors import InvalidRequestError

import logging
import os
from collections.abc import AsyncGenerator, Collection
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp

from f8pysdk.platform_client import PlatformClient
from f8media_protocol.contracts import MediaGateway

from .application import StudioApplication
from .api_contracts import install_openapi
from .models import (
    BrowserRtcConfiguration,
)
from .runtime import RuntimeConfig, RuntimeGateway


from .access import StudioAccess, StudioAccessMiddleware

from .http_support import SERVER_VERSION, decode_body, json_value, origin_allowed
from .routes.errors import install_errors_routes
from .routes.status import install_status_routes
from .routes.catalog import install_catalog_routes
from .routes.assets import install_assets_routes
from .routes.projects import install_projects_routes
from .routes.media import install_media_routes
from .routes.editor import install_editor_routes
from .routes.local import install_local_routes
from .routes.runtime import install_runtime_routes
from .routes.agents import install_agents_routes
from .routes.streams import install_streams_routes

logger = logging.getLogger(__name__)


def default_web_dist() -> Path:
    package_dir = Path(__file__).resolve().parent
    checkout = package_dir.parents[1]
    if (checkout / "extension.json").is_file():
        return checkout / "build" / "web-studio"
    return package_dir / "web_dist"


def default_data_dir() -> Path:
    configured = os.environ.get("F8STUDIO_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".local" / "share" / "f8studio-web").resolve()


DEFAULT_ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "testserver"})


class LoopbackOriginMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, *, allowed_hosts: Collection[str]) -> None:
        super().__init__(app)
        self._allowed_hosts = frozenset(allowed_hosts)

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
            if not origin_allowed(request.headers.get("origin"), self._allowed_hosts):
                return JSONResponse(status_code=403, content={"detail": "request origin is not allowed"})
        return await call_next(request)


def create_app(
    *,
    web_dist: Path | None = None,
    data_dir: Path | None = None,
    runtime: RuntimeGateway | None = None,
    runtime_config: RuntimeConfig | None = None,
    service_roots: tuple[Path, ...] | None = None,
    application: StudioApplication | None = None,
    media_gateway: MediaGateway | None = None,
    allowed_hosts: tuple[str, ...] | None = None,
    access: StudioAccess | None = None,
    rtc_configuration: BrowserRtcConfiguration | None = None,
    platform: PlatformClient | None = None,
) -> FastAPI:
    resolved_web_dist = (web_dist or default_web_dist()).resolve()
    index_path = resolved_web_dist / "index.html"
    has_web_assets = index_path.is_file()
    studio = application or StudioApplication(
        data_dir=data_dir or default_data_dir(), runtime=runtime,
        runtime_config=runtime_config, service_roots=service_roots, media_gateway=media_gateway,
        platform=platform,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
        try:
            await studio.start()
            yield
        finally:
            await studio.close()

    app = FastAPI(
        title="Feel8 Web Studio API",
        version=SERVER_VERSION,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    from .cloud_routes import install_cloud_routes
    install_cloud_routes(app,studio,decode_body,json_value)
    resolved_allowed_hosts = frozenset(
        host.strip().lower() for host in (allowed_hosts or tuple(DEFAULT_ALLOWED_HOSTS)) if host.strip()
    )
    if not resolved_allowed_hosts:
        raise InvalidRequestError("at least one allowed host is required")
    app.add_middleware(LoopbackOriginMiddleware, allowed_hosts=resolved_allowed_hosts)
    if access is not None:
        app.add_middleware(StudioAccessMiddleware, access=access)
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=sorted(resolved_allowed_hosts),
    )


    # Browser and Agent requests use the same platform authority as the launcher CLI.


    install_errors_routes(app, studio)
    install_status_routes(app, studio, has_web_assets=has_web_assets)
    install_catalog_routes(app, studio)
    install_assets_routes(app, studio)
    install_projects_routes(app, studio)
    install_media_routes(app, studio, rtc_configuration=rtc_configuration)
    install_editor_routes(app, studio)
    install_local_routes(app, studio)
    install_runtime_routes(app, studio)
    install_agents_routes(app, studio)
    install_streams_routes(app, studio, resolved_allowed_hosts=resolved_allowed_hosts)

    if has_web_assets:
        assets_path = resolved_web_dist / "assets"
        if assets_path.is_dir():
            app.mount("/assets", StaticFiles(directory=assets_path), name="web-assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def web_app(path: str) -> FileResponse:
            if path == "api" or path.startswith("api/"):
                raise HTTPException(status_code=404, detail="API route not found")
            requested_path = (resolved_web_dist / path).resolve()
            if path and requested_path.is_relative_to(resolved_web_dist) and requested_path.is_file():
                return FileResponse(requested_path)
            return FileResponse(index_path)

    install_openapi(app)
    return app
