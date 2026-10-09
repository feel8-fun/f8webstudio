"""Studio-owned Cloud proxy contracts. Credentials never enter these models."""
from __future__ import annotations
from typing import Literal
import msgspec
from .component_models import CloudReference
from .component_models import ComponentPreviewIssue
from f8studio_core.graph import StudioDocument
from f8studio_core.publication import PublicationSource

class CloudSettingsRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    base_url: str

class CloudUser(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    id: str
    name: str

class CloudStatus(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    configured: bool
    registry_id: str
    user: CloudUser | None

class CloudLoginStart(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    authorization_url: str

class CloudAsset(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    asset_id: str
    kind: Literal["graph", "component", "variant"]
    name: str
    description: str
    tags: tuple[str, ...]
    visibility: Literal["public", "private"]
    version: int
    content_hash: str
    license: str
    author: CloudUser
    updated_at: str

class CloudPage(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    items: tuple[CloudAsset, ...]
    next_cursor: str | None

class CloudVersion(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    version: int
    content_hash: str
    created_at: str
    note: str

class CloudRelations(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    likes: int
    liked: bool
    following: bool
    following_author: bool
    has_update: bool
    latest_version: int

class CloudDraftLink(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    local_asset_id: str
    reference: CloudReference
    owned: bool
    author_id: str = ""
    source: PublicationSource = msgspec.field(default_factory=PublicationSource)
    author_source: PublicationSource = msgspec.field(default_factory=PublicationSource)

class CloudMetadataRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    name: str
    description: str
    tags: tuple[str, ...]
    visibility: Literal["public", "private"]

class CloudPublishRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    request_id: str
    local_version: int
    license: str
    visibility: Literal["public", "private"] = "public"
    change_summary: str = ""

class CloudPublicationResult(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    asset_id: str
    version: int
    content_hash: str
    changed: bool

class CloudGraphPublishRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    request_id: str
    expected_graph_revision: int
    expected_layout_revision: int
    license: str
    visibility: Literal["public", "private"] = "public"
    change_summary: str = ""

class CloudGraphOpenRequest(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    reference: CloudReference
    name: str

class CloudGraphPreview(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    reference: CloudReference
    document: StudioDocument
    issues: tuple[ComponentPreviewIssue, ...]
