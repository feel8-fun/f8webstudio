from __future__ import annotations
import asyncio
import json
import re
import subprocess
from collections.abc import Generator
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import httpx
import msgspec
import pytest
from f8studio_core.graph import CreateNodeOp, PatchRequest, import_graph
from f8studio_core.publication import decode_publication, ComponentPublication, InstalledExtension
from f8studio_server.application import StudioApplication
from f8studio_server.assets import AssetKind, CreateAssetRequest, UpdateAssetRequest
from f8studio_server.cloud_client import CloudClient, CloudRequestError, CloudConnection, CloudCredential
from f8studio_server.cloud_models import CloudUser, CloudPublishRequest, CloudGraphPublishRequest
from f8studio_server.cloud_service import CloudService
from f8studio_server.component_models import CloudReference, InsertCloudComponentRequest
from f8studio_server.errors import InvalidRequestError
from f8studio_server.errors import ServiceUnavailableError
from f8studio_server.models import CreateProjectRequest

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "cloud/test/fixtures"

@pytest.fixture(scope="module")
def cloud_origin(tmp_path_factory: pytest.TempPathFactory) -> Generator[str]:
    with (tmp_path_factory.mktemp("cloud") / "worker.log").open("w") as log:
        process = subprocess.Popen(["node",str(ROOT / "cloud/test_support/p2_server.js")],stdout=subprocess.PIPE,stderr=log,text=True)
        try:
            assert process.stdout is not None
            yield str(json.loads(process.stdout.readline())["baseUrl"])
        finally:
            process.terminate()
            process.wait(timeout=10)

async def login(client: CloudClient, origin: str) -> None:
    await client.configure(origin)
    start = client.begin_login("http://127.0.0.1:8240/api/cloud/auth/callback")
    params = {key: values[0] for key,values in parse_qs(urlsplit(start.authorization_url).query).items()}
    async with httpx.AsyncClient() as browser:
        page = await browser.get(start.authorization_url)
        assert page.status_code == 200
        csrf = re.search(r'name="csrf_token" value="([^"]+)"',page.text)
        assert csrf is not None
        form = {**params,"csrf_token":csrf.group(1),"email":"p2@example.com","password":"p2-only-password"}
        response = await browser.post(origin+"/v1/auth/desktop/authorize",data=form,headers={"Origin":origin})
        assert response.status_code in (302,303),response.text
        callback = parse_qs(urlsplit(response.headers["location"]).query)
        await client.complete_login(state=callback["state"][0],code=callback["code"][0])

def studio_fixture(tmp_path: Path) -> tuple[StudioApplication, CloudService, str]:
    studio = StudioApplication(data_dir=tmp_path / "studio",service_roots=())
    publication = decode_publication((FIXTURES / "component-v1.json").read_bytes())
    assert isinstance(publication,ComponentPublication)
    component = publication.content
    for spec in component.definitions.services.values():studio.catalog.sdk_catalog.register_service(spec)
    studio.catalog.sdk_catalog.register_operators(list(component.definitions.operators.values()))
    dependency = publication.manifest.dependencies[0]
    installed = (InstalledExtension(extension_id=dependency.extension_id,version=dependency.compatible_versions[0],
        service_classes=dependency.service_classes,operators=dependency.operators,
        protocol_versions=dependency.protocol_versions,capabilities=dependency.capabilities),)
    cloud = CloudService(client=studio.cloud.client,database=studio.database,assets=studio.assets,projects=studio.projects,
        tools=studio.tools,catalog=studio.catalog,platform=studio.platform,installed=lambda:installed)
    asset = studio.assets.create(CreateAssetRequest(kind=AssetKind.component,name="P2 script",content=msgspec.to_builtins(component)))
    host_id = "target_host"
    host = studio.catalog.sdk_catalog.services.get(next(iter(component.definitions.services.values())).serviceClass)
    from f8studio_core.graph import NodeCatalog
    target_host = NodeCatalog(services=[host]).create_service_node(node_id=host_id,service_class=host.serviceClass)
    studio.projects.create(CreateProjectRequest(project_id="target",name="Target"))
    studio.projects.patch("target",PatchRequest(request_id="host",expected_graph_revision=0,expected_layout_revision=0,operations=(CreateNodeOp(node=target_host),)))
    return studio,cloud,asset.asset_id

def test_real_worker_login_publication_preview_atomic_insert_undo_and_restart_retry(tmp_path: Path, cloud_origin: str) -> None:
    async def run() -> None:
        studio,cloud,asset_id = studio_fixture(tmp_path)
        try:
            await login(cloud.client,cloud_origin)
            assert cloud.client.status().user is not None
            assert (tmp_path / "studio/cloud-connection.json").stat().st_mode & 0o777 == 0o600
            request = CloudPublishRequest(request_id="publish",local_version=1,license="MIT")
            result = await cloud.publish(asset_id,request)
            assert result.version == 1
            assert await cloud.publish(asset_id,request) == result
            same = await cloud.publish(asset_id,msgspec.structs.replace(request,request_id="same"))
            assert not same.changed
            reference = CloudReference(registry_id=cloud_origin,asset_id=result.asset_id,version=result.version,content_hash=result.content_hash)
            preview = await cloud.preview(reference)
            assert not preview.issues
            assert preview.document.nodes
            before_assets = studio.assets.list_assets()
            original = studio.projects.document("target")
            insertion = InsertCloudComponentRequest(request_id="insert",expected_graph_revision=original.graph_revision,
                expected_layout_revision=original.layout_revision,reference=reference,
                host_bindings={preview.component.host_bindings[0].binding_id:"target_host"})
            inserted = await cloud.insert("target",insertion)
            assert inserted.source.registry_id == cloud_origin
            assert inserted.source.content_hash == result.content_hash
            assert len(inserted.patch.document.nodes) == 2
            assert studio.assets.list_assets() == before_assets
            assert await cloud.insert("target",insertion) == inserted
            await cloud.client.configure("")
            # A completed insertion can replay offline without downloading content.
            assert await cloud.insert("target",insertion) == inserted
            from f8studio_core.graph import HistoryRequest
            undone = await studio.tools.undo("target",HistoryRequest(request_id="undo",expected_graph_revision=inserted.patch.document.graph_revision,
                expected_layout_revision=inserted.patch.document.layout_revision))
            assert len(undone.document.nodes) == 1
            await cloud.client.configure(cloud_origin)
            with pytest.raises(InvalidRequestError,match="hash"):
                await cloud.preview(msgspec.structs.replace(reference,content_hash="0"*64))
            assert studio.projects.document("target") == undone.document
        finally:
            await cloud.client.close()
    asyncio.run(run())

def test_real_worker_draft_provenance_survives_anonymous_clone_and_account_login(tmp_path:Path,cloud_origin:str)->None:
    async def run()->None:
        studio,cloud,asset_id=studio_fixture(tmp_path)
        try:
            await login(cloud.client,cloud_origin)
            published=await cloud.publish(asset_id,CloudPublishRequest(request_id="original",local_version=1,license="MIT"))
            reference=CloudReference(registry_id=cloud_origin,asset_id=published.asset_id,version=1,content_hash=published.content_hash)
            await cloud.client.logout()
            draft=await cloud.draft(reference)
            anonymous=cloud.draft_link(draft.asset_id)
            assert anonymous is not None and not anonymous.owned and anonymous.source.asset_id==published.asset_id
            await login(cloud.client,cloud_origin)
            own=cloud.draft_link(draft.asset_id)
            assert own is not None and own.owned
            relations=await cloud.relate(published.asset_id,"like",True)
            assert relations.liked
            await cloud.relate(published.asset_id,"follow",True)
            assert (await cloud.search(view="following")).items
            assert not (await cloud.relate(published.asset_id,"like",False)).liked
            updated=await cloud.publish(draft.asset_id,CloudPublishRequest(request_id="draft-publish",local_version=1,license="MIT"))
            assert updated.asset_id==published.asset_id
        finally:await cloud.client.close()
    asyncio.run(run())

def test_real_worker_graph_publish_and_open_as_independent_project(tmp_path:Path,cloud_origin:str)->None:
    async def run()->None:
        studio,cloud,_=studio_fixture(tmp_path)
        try:
            await login(cloud.client,cloud_origin)
            publication=decode_publication((FIXTURES/"graph-v1.json").read_bytes())
            source=import_graph(msgspec.json.encode(publication.content),project_id="source")
            studio.projects.create(CreateProjectRequest(project_id="source",name="Published graph"))
            studio.projects.restore("source",source,expected_graph_revision=0,expected_layout_revision=0)
            doc=studio.projects.document("source")
            result=await cloud.publish_graph("source",CloudGraphPublishRequest(request_id="graph",expected_graph_revision=doc.graph_revision,
                expected_layout_revision=doc.layout_revision,license="MIT"))
            reference=CloudReference(registry_id=cloud_origin,asset_id=result.asset_id,version=1,content_hash=result.content_hash)
            opened=await cloud.open_graph(reference,name="Copy")
            assert opened.project_id!="source" and len(opened.document.nodes)==len(source.nodes)
            assert opened.document.graph_revision==0
        finally:await cloud.client.close()
    asyncio.run(run())

def test_cloud_client_refresh_and_registry_credentials_never_leak(tmp_path:Path)->None:
    async def run()->None:
        calls:list[httpx.Request]=[]
        user=CloudUser(id="user",name="User")
        credential=CloudCredential(access_token="access",refresh_token="refresh",access_token_expires_at="2000-01-01T00:00:00Z",
            refresh_token_expires_at="2100-01-01T00:00:00Z",user=user)
        refreshed=msgspec.structs.replace(credential,access_token="new-access",access_token_expires_at="2100-01-01T00:00:00Z")
        def handle(request:httpx.Request)->httpx.Response:
            calls.append(request)
            if request.url.path.endswith("capabilities"):
                return httpx.Response(200,json={"protocolVersion":"f8cloud-api/2","publicationVersions":["f8publication/1"],"graphVersions":[4],"componentVersions":[1],"hashProfiles":["f8publication-hash/1"]})
            response=msgspec.to_builtins(refreshed)
            response["user"]={"userId":user.id,"name":user.name}
            return httpx.Response(200,content=msgspec.json.encode(response) if request.url.path.endswith("refresh") else b'{"ok":true}')
        client=CloudClient(tmp_path,transport=httpx.MockTransport(handle))
        try:
            client._save(CloudConnection(base_url="https://first.test",credential=credential))
            await client.request("GET","/v2/library",dict[str,bool])
            assert calls[1].headers["Authorization"]=="Bearer new-access"
            await client.configure("https://second.test")
            with pytest.raises(InvalidRequestError,match="registry changed"):
                await client.request("GET","/v2/library",dict[str,bool],expected_registry="https://first.test")
            await client.request("GET","/v2/library",dict[str,bool])
            assert "Authorization" not in calls[-1].headers
            with pytest.raises(InvalidRequestError,match="state"):
                await client.complete_login(state="invalid",code="invalid")
        finally:await client.close()
    asyncio.run(run())

@pytest.mark.parametrize("status,body",[(200,b"not JSON"),(302,b"")])
def test_invalid_cloud_response_is_uncertain_gateway_failure(tmp_path:Path,status:int,body:bytes)->None:
    async def run()->None:
        client=CloudClient(tmp_path,transport=httpx.MockTransport(lambda _request:httpx.Response(status,content=body)))
        client._save(CloudConnection(base_url="https://cloud.test"))
        try:
            with pytest.raises(CloudRequestError) as error:
                await client.request("POST","/v2/library/publish",dict[str,bool],payload={"requestId":"retry"})
            assert error.value.status==502 and error.value.code=="invalid_cloud_response"
        finally:await client.close()
    asyncio.run(run())

def test_only_cloud_callback_can_reach_pending_state_validation_without_studio_token(tmp_path:Path)->None:
    from fastapi.testclient import TestClient
    from f8studio_server import create_app
    from f8studio_server.access import StudioAccess
    studio=StudioApplication(data_dir=tmp_path,service_roots=())
    app=create_app(application=studio,access=StudioAccess("private-studio-token",frozenset({"http://localhost:8210"})))
    # No application lifespan/services need to run to reject an invalid state.
    client=TestClient(app,base_url="http://localhost:8210")
    assert client.get("/api/cloud/status").status_code==401
    rejected=client.get("/api/cloud/auth/callback?state=wrong&code=wrong")
    assert rejected.status_code==422
    assert "state" in rejected.text
    assert "private-studio-token" not in rejected.text
    assert client.get("/api/cloud/auth/callback?state=wrong&code=wrong",headers={"Origin":"https://other.test"}).status_code==403
    asyncio.run(studio.cloud.client.close())

def test_uncertain_publication_replays_exact_snapshot_after_restart(tmp_path:Path,cloud_origin:str)->None:
    async def run()->None:
        studio,cloud,asset_id=studio_fixture(tmp_path)
        await login(cloud.client,cloud_origin)
        await cloud.client.close()
        async with httpx.AsyncClient() as actual:
            async def lose_response(request:httpx.Request)->httpx.Response:
                response=await actual.request(request.method,str(request.url),headers=request.headers,content=request.content)
                if request.url.path=="/v2/library/publish":
                    assert response.status_code==200
                    raise httpx.ReadError("connection closed after durable publish",request=request)
                return response
            cloud.client=CloudClient(tmp_path/"studio",transport=httpx.MockTransport(lose_response))
            request=CloudPublishRequest(request_id="uncertain",local_version=1,license="MIT")
            with pytest.raises(ServiceUnavailableError):await cloud.publish(asset_id,request)
            await cloud.client.close()
        # A local edit after the failed response cannot rewrite the saved outgoing
        # request. Reopen the credential file and database, then retry the same ID.
        old=studio.assets.get(asset_id)
        studio.assets.update(asset_id,UpdateAssetRequest(expected_version=1,name="New local title",content=old.content))
        cloud.client=CloudClient(tmp_path/"studio")
        try:
            result=await cloud.publish(asset_id,request)
            assert result.version==1
            assert (await cloud.asset(result.asset_id)).name=="P2 script"
            assert len(await cloud.versions(result.asset_id))==1
        finally:await cloud.client.close()
    asyncio.run(run())

def test_remote_publish_conflict_does_not_change_local_draft(tmp_path:Path,cloud_origin:str)->None:
    async def run()->None:
        studio,cloud,asset_id=studio_fixture(tmp_path)
        try:
            await login(cloud.client,cloud_origin)
            first=await cloud.publish(asset_id,CloudPublishRequest(request_id="first",local_version=1,license="MIT"))
            reference=CloudReference(registry_id=cloud_origin,asset_id=first.asset_id,version=1,content_hash=first.content_hash)
            draft=await cloud.draft(reference)
            content=msgspec.json.decode(msgspec.json.encode(draft.content),type=dict[str,object])
            # Changing only the declared license is a publication content change.
            second=await cloud.publish(asset_id,CloudPublishRequest(request_id="second",local_version=1,license="Apache-2.0"))
            assert second.version==2
            before=studio.assets.get(draft.asset_id)
            with pytest.raises(CloudRequestError) as error:
                await cloud.publish(draft.asset_id,CloudPublishRequest(request_id="stale",local_version=1,license="MIT"))
            assert error.value.status==409 and error.value.code=="version_conflict"
            assert studio.assets.get(draft.asset_id)==before
            assert content
        finally:await cloud.client.close()
    asyncio.run(run())
