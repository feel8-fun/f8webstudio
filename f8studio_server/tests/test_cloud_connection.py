from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import httpx
import msgspec
import pytest
from fastapi.testclient import TestClient

from f8studio_server import create_app
from f8studio_server.application import StudioApplication
from f8studio_server.cloud_client import CloudClient, CloudConnection, CloudCredential, CloudRequestError
from f8studio_server.cloud_models import CloudUser
from f8studio_server.cloud_models import CloudGraphPublishRequest
from f8studio_server.cloud_repository import CloudRepository
from f8studio_server.database import StudioDatabase
from f8studio_server.errors import ConflictError, InvalidRequestError
from f8studio_core.graph.codec import canonical_json_bytes
from f8studio_core.graph.state_policy import ExcludedState
from f8studio_server.cloud_client import registry_origin


CAPABILITIES = {
    "protocolVersion": "f8cloud-api/2", "publicationVersions": ["f8publication/1"],
    "graphVersions": [4], "componentVersions": [1], "hashProfiles": ["f8publication-hash/1"],
}


@pytest.mark.parametrize("existing_url", ["", "https://previous.test", "https://legacy.test"])
def test_missing_cloud_v2_preserves_connection_and_allows_retry(tmp_path: Path, existing_url: str) -> None:
    async def run() -> None:
        upgraded = False

        def handle(request: httpx.Request) -> httpx.Response:
            assert request.url == "https://legacy.test/v2/library/capabilities"
            assert "Authorization" not in request.headers
            return httpx.Response(200, json=CAPABILITIES) if upgraded else httpx.Response(404, json={"message": "not found"})

        client = CloudClient(tmp_path, transport=httpx.MockTransport(handle))
        credential = CloudCredential(access_token="private-access", refresh_token="private-refresh",
            access_token_expires_at="2100-01-01T00:00:00Z", refresh_token_expires_at="2100-01-01T00:00:00Z",
            user=CloudUser(id="author", name="Author")) if existing_url else None
        client._save(CloudConnection(base_url=existing_url, credential=credential))
        previous = client.status()
        previous_file = (tmp_path / "cloud-connection.json").read_bytes()
        try:
            with pytest.raises(CloudRequestError) as error:
                await client.configure("https://legacy.test")
            assert error.value.status == 422
            assert error.value.code == "unsupported_cloud_api"
            assert "database migration and deployment" in str(error.value)
            assert "private-access" not in str(error.value)
            assert client.status() == previous
            assert (tmp_path / "cloud-connection.json").read_bytes() == previous_file

            upgraded = True
            status = await client.configure("https://legacy.test")
            assert status.configured and status.registry_id == "https://legacy.test"
            assert status.user == (previous.user if existing_url == "https://legacy.test" else None)
        finally:
            await client.close()

    asyncio.run(run())


def test_studio_connection_api_explains_missing_cloud_deployment(tmp_path: Path) -> None:
    studio = StudioApplication(data_dir=tmp_path, service_roots=())
    asyncio.run(studio.cloud.client.close())
    studio.cloud.client = CloudClient(tmp_path, transport=httpx.MockTransport(
        lambda _request: httpx.Response(404, json={"message": "not found"})))
    studio.cloud.client._save(CloudConnection())
    client = TestClient(create_app(application=studio))
    try:
        response = client.put("/api/cloud/settings", json={"baseUrl": "https://legacy.test"})
        assert response.status_code == 422
        assert response.json()["code"] == "unsupported_cloud_api"
        assert "Updating Studio alone does not update Cloud" in response.json()["message"]
        assert client.get("/api/cloud/status").json() == {"configured": False, "registryId": "", "user": None}
    finally:
        client.close()
        asyncio.run(studio.cloud.client.close())


def test_cloud_search_api_forwards_kind_view_query_and_cursor_and_rejects_invalid_kind(tmp_path: Path) -> None:
    studio = StudioApplication(data_dir=tmp_path, service_roots=())
    calls: list[httpx.QueryParams] = []

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v2/library"
        calls.append(request.url.params)
        return httpx.Response(200, json={"items": [], "nextCursor": None})

    studio.cloud.client = CloudClient(tmp_path, transport=httpx.MockTransport(handle))
    studio.cloud.client._save(CloudConnection(base_url="https://cloud.test"))

    async def run() -> None:
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(application=studio)), base_url="http://testserver") as client:
                for view in ("all", "mine", "following"):
                    for kind in ("all", "graph", "component", "variant"):
                        params = {"q": "same name 中文", "cursor": "second-page", "view": view, "kind": kind}
                        response = await client.get("/api/cloud/library", params=params)
                        assert response.status_code == 200
                        assert dict(calls[-1]) == params
                previous = len(calls)
                response = await client.get("/api/cloud/library", params={"kind": "unknown"})
                assert response.status_code == 422
                assert response.json()["code"] == "invalid_request"
                assert "asset type" in response.json()["message"]
                assert len(calls) == previous
                response = await client.get("/api/cloud/library")
                assert response.status_code == 200
                assert calls[-1]["kind"] == "all"
        finally:
            await studio.cloud.client.close()

    asyncio.run(run())


@pytest.mark.parametrize("url",["https://cloud.test:invalid", "https://cloud.test:65536", "https://[invalid"])
def test_invalid_cloud_url_is_an_actionable_request_error(url: str) -> None:
    with pytest.raises(InvalidRequestError,match="invalid host or port"):
        registry_origin(url)


def test_earlier_graph_publication_retry_keeps_its_original_fingerprint(tmp_path: Path) -> None:
    database=StudioDatabase(tmp_path/"studio.sqlite3")
    repository=CloudRepository(database)
    request=CloudGraphPublishRequest(request_id="old-request",expected_graph_revision=5,expected_layout_revision=3,license="MIT")
    legacy=msgspec.to_builtins(request)
    del legacy["excludedStates"]
    local_id="project:old"
    fingerprint=hashlib.sha256(canonical_json_bytes((local_id,legacy))).hexdigest()
    payload={"savedSnapshot":"earlier content"}
    with database.connection() as connection:
        connection.execute("INSERT INTO cloud_outgoing_publications(registry_id,user_id,request_id,local_id,fingerprint,payload) VALUES(?,?,?,?,?,?)",
            ("https://cloud.test","author",request.request_id,local_id,fingerprint,msgspec.json.encode(payload)))
    assert repository.outgoing("https://cloud.test","author",request.request_id,local_id,request)==(payload,None)
    changed=msgspec.structs.replace(request,excluded_states=(ExcludedState(node_id="node",field="gain"),))
    with pytest.raises(ConflictError,match="different draft options"):
        repository.outgoing("https://cloud.test","author",request.request_id,local_id,changed)
