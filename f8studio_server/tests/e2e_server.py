"""Playwright server with an explicit offline provider; never used by Studio launches."""
from pathlib import Path

import uvicorn

from f8media_protocol.client import RemoteMediaGateway, RemoteMediaGatewayConfig
from f8pysdk.platform_client import PlatformClient
from f8studio_server import create_app
from f8studio_server.app import default_data_dir
from f8studio_server.application import StudioApplication
from offline_agent import OfflineAgentProvider


if __name__ == "__main__":
    platform = PlatformClient.from_environment()
    dependencies = platform.application_dependencies("webstudio", start=True)
    gateway_url = next(item.url for item in dependencies if item.name == "media-gateway.http")
    studio = StudioApplication(
        data_dir=default_data_dir(), platform=platform,
        media_gateway=RemoteMediaGateway(RemoteMediaGatewayConfig(base_url=gateway_url, manage_process=False)),
    )
    studio.agents._providers = OfflineAgentProvider(studio.data_dir / "agent-providers.json")
    uvicorn.run(
        create_app(application=studio, web_dist=Path("extensions/f8webstudio/build/web-studio")),
        host="127.0.0.1", port=8240,
    )
