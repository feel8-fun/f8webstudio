"""Typed HTTP serialization and origin policy shared by API domains."""
from __future__ import annotations

from collections.abc import Collection
from typing import TypeVar, cast
from urllib.parse import urlparse
import msgspec
from fastapi import HTTPException, Request
from f8pysdk.specs import F8JsonValue
from f8studio_core.graph import PatchResult

SERVER_VERSION = "0.1.0"
T = TypeVar("T")

def origin_allowed(origin: str | None, allowed_hosts: Collection[str]) -> bool:
    if origin is None:
        return True
    parsed = urlparse(origin)
    return parsed.scheme in {"http", "https"} and parsed.hostname in allowed_hosts


def json_value(value: object) -> F8JsonValue:
    return cast(F8JsonValue, msgspec.to_builtins(value, str_keys=True))


async def decode_body(request: Request, value_type: type[T]) -> T:
    raw = await request.body()
    try:
        return msgspec.json.decode(raw, type=value_type)
    except msgspec.DecodeError as exc:
        raise HTTPException(status_code=422, detail=f"invalid request body: {exc}") from exc


def patch_payload(result: PatchResult) -> F8JsonValue:
    return json_value(
        {
            "requestId": result.request_id,
            "graphChanged": result.graph_changed,
            "layoutChanged": result.layout_changed,
            "runtimeErrors": result.runtime_errors,
            "document": result.document,
        }
    )
