from __future__ import annotations

import msgspec

from f8pysdk.specs import (
    F8OperatorSpec, F8ServiceSpec, F8StateSpec, normalize_spec_policy, state_is_persistent, state_is_publishable,
)

from .catalog import ports_for_spec
from .models import DOCUMENT_SCHEMA_VERSION, GraphEdgeKind, GraphNode, OperatorNode, StudioDocument
from .validation import GraphValidationError, validate_document


class ExcludedState(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    node_id: str
    field: str


def normalize_node_policy(node: GraphNode) -> GraphNode:
    spec = normalize_spec_policy(node.spec)
    fields = () if isinstance(spec.stateFields, msgspec.UnsetType) else spec.stateFields
    discarded = {field.name for field in fields if not state_is_persistent(field)}
    return msgspec.structs.replace(
        node, spec=spec, ports=ports_for_spec(spec, node.port_ids),
        state_values={name: value for name, value in node.state_values.items() if name not in discarded},
    )


def apply_installed_state_policy(node: GraphNode, installed: F8ServiceSpec | F8OperatorSpec) -> GraphNode:
    """Apply newly declared restrictions when loading historical project/asset snapshots."""
    installed = normalize_spec_policy(installed)
    spec = normalize_spec_policy(node.spec)
    fields = () if isinstance(installed.stateFields, msgspec.UnsetType) else installed.stateFields
    indexed = {field.name: field for field in fields}
    if not isinstance(spec.stateFields, msgspec.UnsetType):
        updated: list[F8StateSpec] = []
        for field in spec.stateFields:
            original = indexed.get(field.name)
            if original is not None:
                field = msgspec.structs.replace(
                    field,
                    persistent=field.persistent is True and original.persistent is True,
                    publishable=field.publishable is True and original.publishable is True,
                    redactOnPublish=field.redactOnPublish is True or original.redactOnPublish is True,
                )
            updated.append(field)
        spec = msgspec.structs.replace(spec, stateFields=updated)
    return normalize_node_policy(msgspec.structs.replace(node, spec=spec))


def upgrade_document(document: StudioDocument) -> StudioDocument:
    if document.schema_version == DOCUMENT_SCHEMA_VERSION:
        return document
    if document.schema_version not in ("f8studio-document/2", DOCUMENT_SCHEMA_VERSION):
        raise GraphValidationError("unsupported_document_version", f"unsupported schemaVersion: {document.schema_version}")
    return msgspec.structs.replace(
        document, schema_version=DOCUMENT_SCHEMA_VERSION,
        nodes=tuple(normalize_node_policy(node) for node in document.nodes),
    )


def project_document_for_sharing(
    document: StudioDocument, *, excluded_states: tuple[ExcludedState, ...] = (),
) -> StudioDocument:
    """Build a shareable copy, preserving field/port identities and the local project."""
    validate_document(document)
    nodes = {node.node_id: node for node in document.nodes}
    excluded = {(item.node_id, item.field) for item in excluded_states}
    for node_id, name in excluded:
        node = nodes.get(node_id)
        fields = () if node is None or isinstance(node.spec.stateFields, msgspec.UnsetType) else node.spec.stateFields
        if not any(field.name == name for field in fields):
            raise GraphValidationError("invalid_excluded_state", f"excluded state not found: {node_id}.{name}")

    def enabled(node: GraphNode) -> bool:
        return node.enabled and (not isinstance(node, OperatorNode) or nodes[node.service_id].enabled)

    bound: set[tuple[str, str]] = set()
    for edge in document.edges:
        source, target = nodes[edge.from_node_id], nodes[edge.to_node_id]
        if edge.kind is GraphEdgeKind.state and enabled(source) and enabled(target):
            port = next(port for port in target.ports if port.port_id == edge.to_port_id)
            bound.add((target.node_id, port.runtime_name))

    shared: list[GraphNode] = []
    for node in document.nodes:
        spec = normalize_spec_policy(node.spec)
        fields = () if isinstance(spec.stateFields, msgspec.UnsetType) else spec.stateFields
        allowed = {field.name for field in fields if state_is_publishable(field) and (node.node_id, field.name) not in excluded}
        shared.append(msgspec.structs.replace(
            node, spec=spec, ports=ports_for_spec(spec, node.port_ids),
            state_values={name: value for name, value in node.state_values.items()
                          if name in allowed and (node.node_id, name) not in bound},
        ))
    result = msgspec.structs.replace(document, nodes=tuple(shared))
    validate_document(result)
    return result
