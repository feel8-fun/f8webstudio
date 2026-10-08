"""Versioned, cross-language hash encoding for publication content.

Numbers use IEEE-754 binary64 hex rather than language-specific decimal printers.
Every JSON type is tagged, so user objects cannot collide with encoder tags.
This encoding is a hash preimage, not the on-disk JSON serialization.
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
from typing import cast

import msgspec

from f8pysdk.specs import F8JsonValue

HASH_PROFILE = "f8publication-hash/1"
MAX_SAFE_INTEGER = 2**53 - 1


def _tree(value: F8JsonValue) -> F8JsonValue:
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["boolean", value]
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("publication numbers must be finite")
        if number.is_integer() and abs(number) > MAX_SAFE_INTEGER:
            raise ValueError("publication integers must be exactly representable in JavaScript")
        # Treat 0, 0.0 and -0 as the same JSON number.
        return ["number", struct.pack(">d", 0.0 if number == 0 else number).hex()]
    if isinstance(value, str):
        # Reject lone surrogates, which have no portable UTF-8 encoding.
        value.encode("utf-8")
        return ["string", value]
    if isinstance(value, list):
        return ["array", [_tree(item) for item in value]]
    return ["object", [[key, _tree(value[key])] for key in sorted(value)]]


def canonical_publication_bytes(value: object) -> bytes:
    builtins = publication_json_value(value)
    tree = [HASH_PROFILE, _tree(builtins)]
    return json.dumps(tree, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def publication_json_value(value: object) -> F8JsonValue:
    # msgspec's JSON encoder maps non-finite numbers to null; reject them here.
    return cast(F8JsonValue, json.loads(json.dumps(msgspec.to_builtins(value, str_keys=True),
        ensure_ascii=False, allow_nan=False)))


def hash_publication_value(value: object) -> str:
    return hashlib.sha256(canonical_publication_bytes(value)).hexdigest()
