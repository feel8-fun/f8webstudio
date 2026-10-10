"""Versioned document upgrades, applied once at decode/import boundaries."""
from __future__ import annotations
import msgspec
from .models import DOCUMENT_SCHEMA_VERSION, StudioDocument, ServiceNode
from .state_policy import normalize_node_policy
from .validation import GraphValidationError

def upgrade_document(document: StudioDocument) -> StudioDocument:
    if document.schema_version == DOCUMENT_SCHEMA_VERSION:
        return document
    if document.schema_version not in ("f8studio-document/2", DOCUMENT_SCHEMA_VERSION):
        raise GraphValidationError("unsupported_document_version", f"unsupported schemaVersion: {document.schema_version}")
    return msgspec.structs.replace(
        document, schema_version=DOCUMENT_SCHEMA_VERSION,
        nodes=tuple(normalize_node_policy(node) for node in document.nodes),
        layout=tuple(msgspec.structs.replace(item, width=None)
                     if item.width == 620 and any(isinstance(node, ServiceNode) and node.node_id == item.node_id
                                                 for node in document.nodes) else item
                     for item in document.layout),
    )

