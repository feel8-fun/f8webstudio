from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TypeVar, Literal
from urllib.parse import urlencode, urlsplit

import httpx
import msgspec
from f8pysdk.specs import F8JsonValue
from .cloud_models import CloudLoginStart, CloudStatus, CloudUser
from .errors import InvalidRequestError, ServiceUnavailableError

logger = logging.getLogger(__name__)
T = TypeVar("T")
MAX_CONTENT_BYTES = 12 * 1024 * 1024

class CloudRequestError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code

class CloudCredential(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    access_token: str
    access_token_expires_at: str
    refresh_token: str
    refresh_token_expires_at: str
    user: CloudUser

class DesktopUser(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    user_id: str
    name: str

class DesktopToken(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    access_token: str
    access_token_expires_at: str
    refresh_token: str
    refresh_token_expires_at: str
    user: DesktopUser

def credential_from_token(token: DesktopToken) -> CloudCredential:
    return CloudCredential(access_token=token.access_token,access_token_expires_at=token.access_token_expires_at,
        refresh_token=token.refresh_token,refresh_token_expires_at=token.refresh_token_expires_at,
        user=CloudUser(id=token.user.user_id,name=token.user.name))

class CloudConnection(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    base_url: str = ""
    credential: CloudCredential | None = None

class LoginAttempt(msgspec.Struct, frozen=True, kw_only=True):
    verifier: str
    redirect_uri: str
    expires_at: float

class CloudCapabilities(msgspec.Struct, frozen=True, kw_only=True, rename="camel"):
    protocol_version: Literal["f8cloud-api/2"]
    publication_versions: tuple[str, ...]
    graph_versions: tuple[int, ...]
    component_versions: tuple[int, ...]
    hash_profiles: tuple[str, ...]

def registry_origin(value: str) -> str:
    if not value.strip():
        return ""
    parsed = urlsplit(value.strip())
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
        or parsed.path not in ("", "/") or (parsed.scheme != "https" and
            not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")))):
        raise InvalidRequestError("Cloud URL must be an HTTPS origin (HTTP is allowed for loopback development)")
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    port = f":{parsed.port}" if parsed.port is not None else ""
    return f"{parsed.scheme}://{host}{port}"

class CloudClient:
    def __init__(self, data_dir: Path, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._path = data_dir / "cloud-connection.json"
        self._connection = (msgspec.json.decode(self._path.read_bytes(), type=CloudConnection) if self._path.exists()
            else CloudConnection(base_url=registry_origin(os.environ.get("F8STUDIO_CLOUD_URL", ""))))
        self._http = httpx.AsyncClient(timeout=20, follow_redirects=False, transport=transport)
        self._lock = asyncio.Lock()
        self._attempts: dict[str, LoginAttempt] = {}

    @property
    def registry_id(self) -> str:
        return self._connection.base_url

    def status(self) -> CloudStatus:
        credential = self._connection.credential
        return CloudStatus(configured=bool(self.registry_id), registry_id=self.registry_id,
            user=None if credential is None else credential.user)

    def _save(self, connection: CloudConnection) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(f".cloud-{secrets.token_hex(8)}.json")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(msgspec.json.encode(connection))
            temporary.replace(self._path)
        finally:
            temporary.unlink(missing_ok=True)
        self._connection = connection

    async def configure(self, value: str) -> CloudStatus:
        async with self._lock:
            base_url = registry_origin(value)
            if base_url != self.registry_id:
                if base_url:
                    capabilities = await self._send("GET","/v2/library/capabilities",CloudCapabilities,registry=base_url)
                    if ("f8publication/1" not in capabilities.publication_versions or "f8publication-hash/1" not in capabilities.hash_profiles
                        or 4 not in capabilities.graph_versions or 1 not in capabilities.component_versions):
                        raise InvalidRequestError("Cloud does not support Studio's publication contract and hash profile")
                self._attempts.clear()
                self._save(CloudConnection(base_url=base_url))
        return self.status()

    def begin_login(self, redirect_uri: str) -> CloudLoginStart:
        if not self.registry_id:
            raise InvalidRequestError("Configure a Cloud URL first")
        parsed = urlsplit(redirect_uri)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise InvalidRequestError("Cloud sign-in requires a loopback Studio address")
        self._attempts = {key: value for key, value in self._attempts.items() if value.expires_at > time.monotonic()}
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        self._attempts[state] = LoginAttempt(verifier=verifier, redirect_uri=redirect_uri, expires_at=time.monotonic() + 300)
        return CloudLoginStart(authorization_url=self.registry_id + "/v1/auth/desktop/authorize?" + urlencode({
            "client_id": "f8studio", "redirect_uri": redirect_uri, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256"}))

    async def complete_login(self, *, state: str, code: str) -> None:
        async with self._lock:
            attempt = self._attempts.pop(state, None)
            if attempt is None or attempt.expires_at < time.monotonic():
                raise InvalidRequestError("Cloud login state is invalid or expired; start sign-in again")
            payload = {"clientId": "f8studio", "code": code, "redirectUri": attempt.redirect_uri, "codeVerifier": attempt.verifier}
            credential = credential_from_token(await self._send("POST", "/v1/auth/desktop/token", DesktopToken, payload=payload))
            self._save(CloudConnection(base_url=self.registry_id, credential=credential))

    async def logout(self) -> CloudStatus:
        async with self._lock:
            credential = self._connection.credential
            if credential is not None:
                try:
                    await self._send("POST", "/v1/auth/desktop/revoke", dict[str, F8JsonValue], payload={"refreshToken": credential.refresh_token})
                except (CloudRequestError, ServiceUnavailableError):
                    logger.exception("Cloud token revocation failed; clearing local credentials")
            self._attempts.clear()
            self._save(CloudConnection(base_url=self.registry_id))
        return self.status()

    async def request(self, method: str, path: str, model: type[T], *, payload: object = None,
                      expected_registry: str | None = None, expected_user: str | None = None) -> T:
        if not self.registry_id:
            raise InvalidRequestError("Cloud is not configured")
        async with self._lock:
            registry = self.registry_id
            credential = self._connection.credential
            if expected_registry is not None and registry != expected_registry:
                raise InvalidRequestError("Cloud registry changed; restart this operation")
            if expected_user is not None and (credential is None or credential.user.id != expected_user):
                raise InvalidRequestError("Cloud account changed; restart this operation")
            if credential is not None and datetime.fromisoformat(credential.access_token_expires_at.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                credential = credential_from_token(await self._send("POST", "/v1/auth/desktop/refresh", DesktopToken, payload={"refreshToken": credential.refresh_token}))
                self._save(CloudConnection(base_url=self.registry_id, credential=credential))
            token = None if credential is None else credential.access_token
        return await self._send(method, path, model, payload=payload, token=token, registry=registry)

    async def _send(self, method: str, path: str, model: type[T], *, payload: object = None, token: str | None = None,
                    registry: str | None = None) -> T:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Cloud request paths must remain on the configured registry")
        headers = {"Accept": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        content = None if payload is None else msgspec.json.encode(payload)
        if content is not None:
            if len(content) > MAX_CONTENT_BYTES:
                raise InvalidRequestError("Cloud request exceeds the 12 MiB content limit")
            headers["Content-Type"] = "application/json"
        try:
            async with self._http.stream(method, (registry or self.registry_id) + path, content=content, headers=headers) as response:
                chunks: list[bytes] = []
                length = 0
                async for chunk in response.aiter_bytes():
                    length += len(chunk)
                    if length > MAX_CONTENT_BYTES:
                        raise CloudRequestError(502, "invalid_cloud_response", "Cloud response exceeds the 12 MiB content limit")
                    chunks.append(chunk)
                body = b"".join(chunks)
                if response.is_error:
                    error = msgspec.json.decode(body, type=dict[str, F8JsonValue])
                    raise CloudRequestError(response.status_code, str(error.get("code", "cloud_request_failed")), str(error.get("message", "Cloud request failed")))
                if response.is_redirect:
                    raise CloudRequestError(502, "invalid_cloud_response", "Cloud API redirected; configure its canonical origin")
                return msgspec.json.decode(body, type=model)
        except httpx.HTTPError as exc:
            logger.exception("Cloud transport failed method=%s path=%s", method, path)
            raise ServiceUnavailableError("Cloud is unavailable; local projects and templates remain usable") from exc
        except msgspec.DecodeError as exc:
            logger.exception("Cloud returned invalid response method=%s path=%s", method, path)
            raise CloudRequestError(502, "invalid_cloud_response", f"Cloud response does not match the supported contract: {exc}") from exc

    async def close(self) -> None:
        await self._http.aclose()
