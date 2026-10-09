from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import cast
from urllib.parse import quote, urlencode
import msgspec
from f8pysdk.platform_client import PlatformClient
from f8pysdk.extension_status import ExtensionStatus
from f8pysdk.specs import F8JsonValue
from f8studio_core.graph import import_graph, RevisionConflictError, StudioDocument
from f8studio_core.publication import (
    ComponentPublication, GraphPublication, Publication, PublicationManifest, PublicationSource, PortableComponent,
    ExtensionRequirement, InstalledExtension, OperatorRequirement, create_component_publication, create_graph_publication,
    decode_component, decode_publication, diagnose_dependencies,
)
from .assets import AssetKind, AssetRecord, AssetRepository, CreateAssetRequest
from .automation_tools import StudioAutomationTools
from .catalog import CatalogService
from .cloud_client import CloudClient
from .cloud_models import (CloudAsset, CloudPage, CloudVersion, CloudRelations, CloudPublishRequest,
    CloudGraphPublishRequest, CloudPublicationResult, CloudDraftLink, CloudGraphPreview, CloudMetadataRequest)
from .cloud_repository import CloudRepository
from .component_models import CloudReference, ComponentPreview, ComponentPreviewIssue, InsertCloudComponentRequest, InsertComponentResult
from .database import StudioDatabase
from .errors import InvalidRequestError
from .projects import ProjectService
from .models import ProjectRecord

def json_value(value: object) -> F8JsonValue:
    return cast(F8JsonValue, msgspec.to_builtins(value, str_keys=True))

class CloudService:
    def __init__(self, *, client: CloudClient, database: StudioDatabase, assets: AssetRepository,
                 projects: ProjectService, tools: StudioAutomationTools, catalog: CatalogService, platform: PlatformClient,
                 installed: Callable[[], tuple[InstalledExtension, ...]] | None = None) -> None:
        self.client = client
        self.repository = CloudRepository(database)
        self._assets = assets
        self._projects = projects
        self._tools = tools
        self._catalog = catalog
        self._platform = platform
        self._installed = installed or self._installed_extensions

    def _installed_extensions(self) -> tuple[InstalledExtension, ...]:
        statuses = self._platform.read("GET", "/api/extensions", tuple[ExtensionStatus,...])
        snapshot = self._catalog.snapshot()
        return tuple(InstalledExtension(extension_id=item.extension_id,version=item.version,
            service_classes=item.service_classes,
            operators=tuple(OperatorRequirement(service_class=spec.serviceClass,operator_class=spec.operatorClass)
                for spec in snapshot.operators if spec.serviceClass in item.service_classes),
            protocol_versions=("f8service/2", "f8operator/2")) for item in statuses if item.state in ("installed", "available"))

    async def search(self, *, query: str = "", cursor: str = "", view: str = "all") -> CloudPage:
        if view not in ("all", "mine", "following"):
            raise InvalidRequestError("Unsupported Cloud Library view")
        return await self.client.request("GET", "/v2/library?" + urlencode({"q":query,"cursor":cursor,"view":view}), CloudPage)

    async def asset(self, asset_id: str) -> CloudAsset:
        return await self.client.request("GET", "/v2/library/" + quote(asset_id, safe=""), CloudAsset)

    async def versions(self, asset_id: str) -> tuple[CloudVersion, ...]:
        return await self.client.request("GET", "/v2/library/" + quote(asset_id,safe="") + "/versions", tuple[CloudVersion,...])

    def _check_reference(self, reference: CloudReference) -> None:
        if reference.registry_id != self.client.registry_id or not reference.registry_id:
            raise InvalidRequestError("Online reference belongs to a different Cloud registry")
        if reference.version < 1 or len(reference.content_hash) != 64 or not reference.asset_id:
            raise InvalidRequestError("Online reference requires an asset ID, positive fixed version and SHA-256 hash")

    async def publication(self, reference: CloudReference) -> Publication:
        self._check_reference(reference)
        value = await self.client.request("GET", f"/v2/library/{quote(reference.asset_id,safe='')}/versions/{reference.version}", dict[str,F8JsonValue], expected_registry=reference.registry_id)
        try:
            publication = decode_publication(msgspec.json.encode(value))
        except ValueError as exc:
            raise InvalidRequestError(f"Cloud publication is invalid: {exc}") from exc
        if publication.content_hash != reference.content_hash:
            raise InvalidRequestError("Cloud fixed-version content hash does not match the selected reference")
        return publication

    async def preview(self, reference: CloudReference) -> ComponentPreview:
        publication = await self.publication(reference)
        if not isinstance(publication, ComponentPublication):
            raise InvalidRequestError("A graph is opened as a project, not inserted as a Component")
        preview = await asyncio.to_thread(self._tools.template_preview, reference.asset_id, reference.version, publication.content)
        installed = await asyncio.to_thread(self._installed)
        dependency_issues = tuple(ComponentPreviewIssue(code=issue.code,node_id="",message=issue.message)
            for issue in diagnose_dependencies(publication.manifest,installed))
        return msgspec.structs.replace(preview,issues=(*preview.issues,*dependency_issues))

    async def graph_preview(self, reference: CloudReference) -> CloudGraphPreview:
        publication = await self.publication(reference)
        if not isinstance(publication,GraphPublication):
            raise InvalidRequestError("Expected a graph publication")
        document = import_graph(msgspec.json.encode(publication.content))
        component = PortableComponent(definitions=publication.content.definitions,services=publication.content.services,
            operators=publication.content.operators,connections=publication.content.connections,presentation=publication.content.presentation)
        preview = await asyncio.to_thread(self._tools.template_preview,reference.asset_id,reference.version,component)
        installed = await asyncio.to_thread(self._installed)
        issues = tuple(ComponentPreviewIssue(code=item.code,node_id="",message=item.message) for item in diagnose_dependencies(publication.manifest,installed))
        return CloudGraphPreview(reference=reference,document=document,issues=(*preview.issues,*issues))

    async def open_graph(self, reference: CloudReference, *, name: str) -> ProjectRecord:
        preview = await self.graph_preview(reference)
        if preview.issues:
            raise InvalidRequestError("; ".join(issue.message for issue in preview.issues))
        asset = await self.asset(reference.asset_id)
        publication = await self.publication(reference)
        user = self.client.status().user
        link = CloudDraftLink(local_asset_id="",reference=reference,owned=user is not None and user.id==asset.author.id,
                author_id=asset.author.id,source=publication_source(reference,publication_owner=asset.author.id,user_id=None if user is None else user.id),
                author_source=publication.manifest.source)
        record = await asyncio.to_thread(self._projects.create_from_cloud,preview.document,name=name,description=asset.description,reference=reference,link=link)
        return record

    async def insert(self, project_id: str, request: InsertCloudComponentRequest) -> InsertComponentResult:
        replay = await asyncio.to_thread(self._projects.replay_component_insertion, project_id, request)
        if replay is not None:
            return replay
        preview = await self.preview(request.reference)
        asset = await self.asset(request.reference.asset_id)
        if asset.kind not in ("component", "variant"):
            raise InvalidRequestError("Only Components and Variants can be inserted")
        return await self._tools.insert_cloud_template(project_id, request, preview,
            kind=AssetKind.variant if asset.kind == "variant" else AssetKind.component, name=asset.name)

    async def relations(self, asset_id: str) -> CloudRelations:
        value = await self.client.request("GET", "/v2/library/" + quote(asset_id,safe=""), dict[str,F8JsonValue])
        return msgspec.convert(value["relations"], type=CloudRelations)

    async def relate(self, asset_id: str, action: str, enabled: bool) -> CloudRelations:
        if action not in ("like", "follow", "follow-author"):
            raise InvalidRequestError("Unsupported Cloud relation")
        return await self.client.request("PUT" if enabled else "DELETE",
            f"/v2/library/{quote(asset_id,safe='')}/relations/{action}", CloudRelations)

    async def draft(self, reference: CloudReference) -> AssetRecord:
        publication = await self.publication(reference)
        if not isinstance(publication, ComponentPublication):
            raise InvalidRequestError("Graph drafts are independent projects; open this graph as a project")
        asset = await self.asset(reference.asset_id)
        result = await asyncio.to_thread(self._assets.create, CreateAssetRequest(kind=AssetKind.variant if asset.kind == "variant" else AssetKind.component,
            name=asset.name,description=asset.description,tags=asset.tags,content=json_value(publication.content)))
        user = self.client.status().user
        source = publication.manifest.source if user is not None and user.id==asset.author.id else publication_source(reference,publication_owner=asset.author.id,user_id=None)
        await asyncio.to_thread(self.repository.save_link, "", CloudDraftLink(local_asset_id=result.asset_id,
            reference=reference,owned=user is not None and user.id == asset.author.id,author_id=asset.author.id,source=source,author_source=publication.manifest.source))
        return result

    def draft_link(self, asset_id: str) -> CloudDraftLink | None:
        user = self.client.status().user
        return self.repository.link(self.client.registry_id,"" if user is None else user.id,asset_id)

    def _manifest(self, content: PortableComponent | StudioDocument, license: str, link: CloudDraftLink | None) -> PublicationManifest:
        installed = self._installed()
        if isinstance(content, PortableComponent):
            services = {spec.serviceClass for spec in content.definitions.services.values()}
            operators = {(spec.serviceClass,spec.operatorClass) for spec in content.definitions.operators.values()}
        else:
            from f8studio_core.graph.models import OperatorNode
            services = {node.service_class for node in content.nodes}
            operators = {(node.service_class,node.operator_class) for node in content.nodes if isinstance(node,OperatorNode)}
        dependencies: list[ExtensionRequirement] = []
        covered_services: set[str] = set()
        covered_operators: set[tuple[str,str]] = set()
        for item in installed:
            required_services = services.intersection(item.service_classes)
            required_operators = operators.intersection((op.service_class,op.operator_class) for op in item.operators)
            if not required_services and not required_operators:
                continue
            if covered_services.intersection(required_services) or covered_operators.intersection(required_operators):
                raise InvalidRequestError("Extension ownership is ambiguous; resolve duplicate installed service/operator definitions")
            covered_services.update(required_services); covered_operators.update(required_operators)
            dependencies.append(ExtensionRequirement(extension_id=item.extension_id,compatible_versions=(item.version,),
                service_classes=tuple(sorted(required_services)),operators=tuple(OperatorRequirement(service_class=s,operator_class=o) for s,o in sorted(required_operators)),
                protocol_versions=item.protocol_versions))
        source = PublicationSource() if link is None else link.source
        return PublicationManifest(kind="component" if isinstance(content,PortableComponent) else "graph",
            content_format="f8component" if isinstance(content,PortableComponent) else "f8graph",content_version=1 if isinstance(content,PortableComponent) else 4,
            license=license,source=source,dependencies=tuple(dependencies))

    async def publish(self, asset_id: str, request: CloudPublishRequest) -> CloudPublicationResult:
        asset = await asyncio.to_thread(self._assets.get,asset_id)
        if asset.kind not in (AssetKind.component,AssetKind.variant):
            raise InvalidRequestError("Only current Component and Variant templates can be published from Assets")
        async def build(link: CloudDraftLink | None) -> dict[str,F8JsonValue]:
            version = await asyncio.to_thread(self._assets.version,asset_id,request.local_version)
            component = decode_component(msgspec.json.encode(version.content))
            manifest = await asyncio.to_thread(self._manifest,component,request.license,link)
            publication = create_component_publication(component,manifest)
            return {"kind":asset.kind.value,"name":asset.name,"description":asset.description,"tags":list(asset.tags),"publication":json_value(publication)}
        return await self._publish(asset_id,request,build)

    async def publish_graph(self, project_id: str, request: CloudGraphPublishRequest) -> CloudPublicationResult:
        async def build(link: CloudDraftLink | None) -> dict[str,F8JsonValue]:
            project = await asyncio.to_thread(self._projects.get,project_id)
            document = project.document
            if (document.graph_revision,document.layout_revision) != (request.expected_graph_revision,request.expected_layout_revision):
                raise RevisionConflictError("Project changed before publication; refresh and retry")
            manifest = await asyncio.to_thread(self._manifest,document,request.license,link)
            publication = create_graph_publication(document,manifest)
            return {"kind":"graph","name":project.name,"description":project.description,"tags":[],"publication":json_value(publication)}
        return await self._publish("project:"+project_id,request,build)

    async def _publish(self, local_id: str, request: CloudPublishRequest | CloudGraphPublishRequest,
                       build: Callable[[CloudDraftLink | None], Awaitable[dict[str,F8JsonValue]]]) -> CloudPublicationResult:
        user = self.client.status().user
        if user is None:
            raise InvalidRequestError("Sign in to Cloud before publishing")
        registry = self.client.registry_id
        outgoing = await asyncio.to_thread(self.repository.outgoing,registry,user.id,request.request_id,local_id,request)
        if outgoing is None:
            link = await asyncio.to_thread(self.repository.link,registry,user.id,local_id)
            # build is an explicit asynchronous snapshot builder; never reconstruct
            # the payload of a durable request after an uncertain network result.
            payload = await build(link)
            payload.update({"requestId":request.request_id,"assetId":link.reference.asset_id if link is not None and link.owned else None,
                "expectedVersion":link.reference.version if link is not None and link.owned else 0,
                "visibility":request.visibility,"changeSummary":request.change_summary})
            outgoing = await asyncio.to_thread(self.repository.outgoing,registry,user.id,request.request_id,local_id,request,payload)
        if outgoing is None:
            raise RuntimeError("Publication snapshot was not persisted")
        payload,result = outgoing
        if result is not None:
            return result
        result = await self.client.request("POST","/v2/library/publish",CloudPublicationResult,payload=payload,
            expected_registry=registry,expected_user=user.id)
        publication = msgspec.convert(payload["publication"],type=Publication)
        link = CloudDraftLink(local_asset_id=local_id,reference=CloudReference(registry_id=registry,asset_id=result.asset_id,version=result.version,content_hash=result.content_hash),
            owned=True,author_id=user.id,source=publication.manifest.source,author_source=publication.manifest.source)
        await asyncio.to_thread(self.repository.complete,registry,user.id,request.request_id,result,link)
        return result

    async def update_metadata(self, asset_id: str, request: CloudMetadataRequest) -> CloudAsset:
        link = self.draft_link(asset_id)
        if link is None or not link.owned:
            raise InvalidRequestError("Only your linked publication can update listing metadata")
        user = self.client.status().user
        if user is None:
            raise InvalidRequestError("Sign in to Cloud before editing listing metadata")
        return await self.client.request("PUT",f"/v2/library/{quote(link.reference.asset_id,safe='')}/metadata",CloudAsset,
            payload=request,expected_registry=link.reference.registry_id,expected_user=user.id)

def publication_source(reference: CloudReference, *, publication_owner: str, user_id: str | None) -> PublicationSource:
    if user_id is not None and user_id==publication_owner:
        return PublicationSource()
    return PublicationSource(repository_url=reference.registry_id if reference.registry_id.startswith("https://") else None,
        asset_id=reference.asset_id,asset_version=reference.version)
