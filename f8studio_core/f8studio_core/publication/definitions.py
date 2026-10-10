"""Prepare definition JSON for a round trip through JavaScript.

The existing graph reference hash distinguishes 0.0 from 0 in untyped schema
defaults/examples. JavaScript does not. Normalize those representations before
publication, then regenerate references with the unchanged graph hash algorithm.
Typed float fields are restored by decoding the spec, so existing readers and
historical graph hashes retain their original validation rules.
"""
from __future__ import annotations

from typing import overload

import msgspec

from f8pysdk.specs import F8JsonValue, F8OperatorSpec, F8ServiceSpec
from f8studio_core.graph.exchange import ExchangeDefinitions, GraphExchange, definition_ref

from .canonical import publication_json_value
from .models import PortableComponent


def _json_numbers(value: F8JsonValue) -> F8JsonValue:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_json_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_numbers(item) for key, item in value.items()}
    return value


@overload
def portable_definition_numbers(content: GraphExchange) -> GraphExchange: ...


@overload
def portable_definition_numbers(content: PortableComponent) -> PortableComponent: ...


def portable_definition_numbers(content: GraphExchange | PortableComponent) -> GraphExchange | PortableComponent:
    services: dict[str, F8ServiceSpec] = {}
    operators: dict[str, F8OperatorSpec] = {}
    service_refs: dict[str, str] = {}
    operator_refs: dict[str, str] = {}
    for ref, spec in content.definitions.services.items():
        normalized = msgspec.json.decode(msgspec.json.encode(_json_numbers(publication_json_value(spec))), type=F8ServiceSpec)
        service_refs[ref] = definition_ref(normalized)
        services[service_refs[ref]] = normalized
    for ref, spec in content.definitions.operators.items():
        normalized = msgspec.json.decode(msgspec.json.encode(_json_numbers(publication_json_value(spec))), type=F8OperatorSpec)
        operator_refs[ref] = definition_ref(normalized)
        operators[operator_refs[ref]] = normalized
    definitions = ExchangeDefinitions(services=services, operators=operators)
    service_instances = {key: msgspec.structs.replace(node, definition_ref=service_refs[node.definition_ref])
                         for key, node in content.services.items()}
    operator_instances = {key: msgspec.structs.replace(node, definition_ref=operator_refs[node.definition_ref])
                          for key, node in content.operators.items()}
    if isinstance(content, GraphExchange):
        return msgspec.structs.replace(content, definitions=definitions, services=service_instances, operators=operator_instances)
    bindings = tuple(msgspec.structs.replace(binding, definition_ref=service_refs[binding.definition_ref])
                     for binding in content.host_bindings)
    return msgspec.structs.replace(content, definitions=definitions, services=service_instances,
                                  operators=operator_instances, host_bindings=bindings)
