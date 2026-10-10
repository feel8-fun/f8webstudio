"""Explicit migrations for historical provider settings."""
from __future__ import annotations

from typing import Any


def migrate_providers(providers: dict[str, Any]) -> None:
    for provider_id, config in providers.items():
        supported = config.pop("supportsImage", False)
        model = config["model"]
        models = list(dict.fromkeys(([model] if model else []) + config.get("models", [])))
        config["models"] = models
        capabilities = config.setdefault("modelCapabilities", [])
        if not supported or not model or not (provider_id.startswith("connection_") or provider_id == "systemone_local"):
            continue
        capability = next((item for item in capabilities if item["modelId"] == model), None)
        if capability is None:
            capability = {"modelId": model, "source": "legacy"}
            capabilities.append(capability)
        if capability.get("imageInput") is None:
            capability["imageInput"] = True
            capability["imageSource"] = "legacy"
            if capability.get("thinking") is not None:
                capability.setdefault("thinkingSource", capability.get("source", "catalog"))


