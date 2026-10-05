"""Studio tests connect to a separate, real platform application via HTTP transport."""
from collections.abc import Generator, Callable
from pathlib import Path

from fastapi.testclient import TestClient
import httpx
import pytest

from f8platform.api import access_token, create_app
from f8pysdk.platform_client import PlatformClient, PlatformConnection


@pytest.fixture(autouse=True)
def platform_connection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Callable[..., PlatformClient]]:
    connections: list[TestClient] = []

    def connect(*, source_index: Path | None = None) -> PlatformClient:
        data = tmp_path / f'platform-{len(connections)}'
        app = create_app(data, source_index=source_index)
        client = TestClient(app)
        client.__enter__()
        connections.append(client)
        access_token(data)
        def forward(request: httpx.Request) -> httpx.Response:
            response = client.request(request.method, str(request.url), headers=request.headers,
                                      content=request.read())
            return httpx.Response(response.status_code, content=response.content, headers=response.headers)
        return PlatformClient(PlatformConnection(url='http://testserver', token_file=str(data / 'platform-token')),
                              transport=httpx.MockTransport(forward))

    monkeypatch.setattr(PlatformClient, 'from_environment', staticmethod(connect))
    from f8media_gateway.service import InProcessMediaGateway
    monkeypatch.setattr('f8studio_server.application.RemoteMediaGateway', lambda _config: InProcessMediaGateway())
    yield connect
    for client in reversed(connections):
        client.__exit__(None, None, None)


@pytest.fixture
def platform_daemon(tmp_path: Path) -> Generator[Path]:
    import socket
    import time
    from threading import Thread
    import uvicorn
    data = tmp_path / 'live-platform'
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0))
        port = reservation.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(data,url=f'http://127.0.0.1:{port}'),
        host='127.0.0.1',port=port,access_log=False))
    thread = Thread(target=server.run,daemon=True)
    thread.start()
    try:
        deadline = time.monotonic()+10
        while not server.started:
            assert thread.is_alive()
            assert time.monotonic()<deadline
            time.sleep(0.01)
        yield data / 'platform.json'
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        assert not thread.is_alive()


@pytest.fixture
def media_gateway_daemon() -> Generator[str]:
    import socket
    import time
    from threading import Thread
    import uvicorn
    from f8media_gateway.app import create_app as media_app
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0))
        port = reservation.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(media_app(),host='127.0.0.1',port=port,access_log=False))
    thread = Thread(target=server.run,daemon=True)
    thread.start()
    try:
        deadline = time.monotonic()+10
        while not server.started:
            assert thread.is_alive()
            assert time.monotonic()<deadline
            time.sleep(0.01)
        yield f'http://127.0.0.1:{port}'
    finally:
        server.should_exit=True
        thread.join(timeout=10)
        assert not thread.is_alive()
