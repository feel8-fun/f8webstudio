from __future__ import annotations

from f8studio_server.errors import InvalidRequestError

import argparse
import logging
import os
import sys
from uuid import uuid4
import msgspec
from f8pysdk.platform_client import PlatformClient
from f8pysdk.platform_spec import SourceApplicationRegistration
from threading import Thread
from ipaddress import ip_address
from pathlib import Path

import uvicorn

from f8media_protocol.client import RemoteMediaGateway, RemoteMediaGatewayConfig

from .app import DEFAULT_ALLOWED_HOSTS, SERVER_VERSION, create_app, default_data_dir
from .access import StudioAccess
from .browser import run_server
from .defaults import DEFAULT_STUDIO_PORT
from .models import BrowserIceServer, BrowserRtcConfiguration
from .server_instance import StudioServerAlreadyRunningError, single_server_instance


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Feel8 Web Studio server.")
    parser.add_argument("--exit-on-stdin-close", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--allowed-host",
        action="append",
        default=[],
        help="Trusted HTTP Host/Origin hostname. Repeat for multiple names when binding a wildcard address.",
    )
    parser.add_argument("--port", default=DEFAULT_STUDIO_PORT, type=int)
    parser.add_argument("--web-dist", type=Path)
    parser.add_argument("--open-browser", action=argparse.BooleanOptionalAction, default=False,
                        help="Open the browser after the server is ready.")
    parser.add_argument("--no-browser", dest="open_browser", action="store_false",
                        help="Start without opening a browser.")
    parser.add_argument(
        "--media-gateway-url",
        help="Loopback URL for the Media Gateway. Defaults to the provider managed by the Launcher.",
    )
    parser.add_argument(
        "--external-media-gateway",
        action="store_true",
        help="Require an explicit --media-gateway-url for the independently running gateway.",
    )
    parser.add_argument(
        "--turn-url",
        action="append",
        default=[],
        help="Browser TURN URL. Repeat to provide fallback transports.",
    )
    parser.add_argument("--turn-username")
    parser.add_argument("--turn-credential")
    parser.add_argument(
        "--force-turn",
        action="store_true",
        help="Require browser media to use TURN relay candidates.",
    )
    args = parser.parse_args()
    if args.external_media_gateway and args.media_gateway_url is None:
        parser.error("--external-media-gateway requires --media-gateway-url")
    return args


def main() -> None:
    args = _parse_args()
    host = str(args.host).strip().lower()
    if host != "localhost":
        try:
            bind_address = ip_address(host)
        except ValueError as exc:
            raise InvalidRequestError("Studio host must be localhost or an explicit IP address") from exc
        if bind_address.is_multicast:
            raise InvalidRequestError("Studio host cannot be a multicast address")
    configured_allowed_hosts = {
        str(allowed_host).strip().lower() for allowed_host in args.allowed_host if str(allowed_host).strip()
    }
    if host in {"0.0.0.0", "::"} and not configured_allowed_hosts:
        raise InvalidRequestError("Wildcard Studio binding requires at least one --allowed-host")
    turn_urls = tuple(str(url).strip() for url in args.turn_url if str(url).strip())
    turn_username = None if args.turn_username is None else str(args.turn_username).strip()
    turn_credential = None if args.turn_credential is None else str(args.turn_credential)
    if (turn_username is None) != (turn_credential is None):
        raise InvalidRequestError("--turn-username and --turn-credential must be provided together")
    if args.force_turn and not turn_urls:
        raise InvalidRequestError("--force-turn requires at least one --turn-url")
    for turn_url in turn_urls:
        if not turn_url.startswith(("turn:", "turns:")):
            raise InvalidRequestError(f"TURN URL must use turn: or turns:: {turn_url}")
    ice_server: BrowserIceServer | None = None
    if turn_urls:
        ice_server = BrowserIceServer(
            urls=turn_urls,
            username=turn_username,
            credential=turn_credential,
        )
    rtc_configuration = BrowserRtcConfiguration(
        ice_servers=() if ice_server is None else (ice_server,),
        ice_transport_policy="relay" if args.force_turn else "all",
    )
    try:
        with single_server_instance():
            platform = PlatformClient.from_environment()
            gateway_url = args.media_gateway_url
            if gateway_url is None:
                dependencies = platform.application_dependencies('webstudio', start='F8_APPLICATION_INSTANCE' not in os.environ)
                gateway_url = next(item.url for item in dependencies if item.name == 'media-gateway.http')
            gateway = RemoteMediaGateway(
                RemoteMediaGatewayConfig(
                    base_url=gateway_url,
                    manage_process=False,
                )
            )
            allowed_hosts = (set(DEFAULT_ALLOWED_HOSTS) - {"testserver"}) | configured_allowed_hosts
            if host not in {"0.0.0.0", "::"}:
                allowed_hosts.add(host)
            access = StudioAccess.create(default_data_dir(), origins=tuple(
                f"http://{'[' + name + ']' if ':' in name else name}:{args.port}" for name in sorted(allowed_hosts)
            ))
            os.environ["F8STUDIO_ACCESS_TOKEN"] = access.token
            external_source = 'F8_APPLICATION_INSTANCE' not in os.environ
            if external_source:
                os.environ['F8_APPLICATION_INSTANCE'] = uuid4().hex
            app = create_app(
                web_dist=args.web_dist,
                access=access,
                media_gateway=gateway,
                allowed_hosts=tuple(allowed_hosts),
                rtc_configuration=rtc_configuration,
                platform=platform,
            )
            local_host = "127.0.0.1" if host == "0.0.0.0" else "::1" if host == "::" else host
            url_host = f"[{local_host}]" if ":" in local_host else local_host
            os.environ["F8STUDIO_SERVER_URL"] = f"http://{url_host}:{args.port}"
            if external_source:
                response = platform.request('POST', '/api/source-applications/register', content=msgspec.json.encode(
                    SourceApplicationRegistration(extension_id='webstudio', version=SERVER_VERSION,
                        instance=os.environ['F8_APPLICATION_INSTANCE'], url=os.environ['F8STUDIO_SERVER_URL'])))
                response.raise_for_status()
            server = uvicorn.Server(uvicorn.Config(
                app, host=host, port=args.port, log_level="info", timeout_graceful_shutdown=5,
            ))
            if args.exit_on_stdin_close:
                def watch_parent() -> None:
                    try:
                        while os.read(sys.stdin.fileno(), 4096):
                            continue
                    except OSError:
                        logging.getLogger(__name__).exception("Studio parent-watch pipe failed")
                    server.should_exit = True
                Thread(target=watch_parent, name="studio-parent-watch", daemon=True).start()
            run_server(server, browser_url=os.environ["F8STUDIO_SERVER_URL"] if args.open_browser else None)
    except KeyboardInterrupt:
        logging.getLogger(__name__).info("Studio stopped by user")
    except StudioServerAlreadyRunningError as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
