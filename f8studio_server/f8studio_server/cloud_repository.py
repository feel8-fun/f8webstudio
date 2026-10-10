from __future__ import annotations
import hashlib
import msgspec
from typing import cast
from f8pysdk.specs import F8JsonValue
from f8studio_core.graph.codec import canonical_json_bytes
from f8studio_core.publication import PublicationSource
from .database import StudioDatabase, database_bytes, database_text
from .cloud_models import CloudDraftLink, CloudPublicationResult, CloudPublishRequest, CloudGraphPublishRequest
from .errors import ConflictError

class CloudRepository:
    def __init__(self, database: StudioDatabase) -> None:
        self._database = database
        with database.connection() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS cloud_draft_links (
                    registry_id TEXT NOT NULL, user_id TEXT NOT NULL, local_id TEXT NOT NULL,
                    link BLOB NOT NULL, PRIMARY KEY(registry_id,user_id,local_id)
                );
                CREATE TABLE IF NOT EXISTS cloud_outgoing_publications (
                    registry_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
                    local_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload BLOB NOT NULL, result BLOB,
                    PRIMARY KEY(registry_id,user_id,request_id)
                );
                CREATE TABLE IF NOT EXISTS cloud_deleted_publications (
                    registry_id TEXT NOT NULL, user_id TEXT NOT NULL, asset_id TEXT NOT NULL,
                    PRIMARY KEY(registry_id,user_id,asset_id)
                );
                CREATE TABLE IF NOT EXISTS cloud_draft_origins (
                    registry_id TEXT NOT NULL, user_id TEXT NOT NULL, local_id TEXT NOT NULL, source BLOB NOT NULL,
                    PRIMARY KEY(registry_id,user_id,local_id)
                );
            """)

    def link(self, registry_id: str, user_id: str, local_id: str) -> CloudDraftLink | None:
        with self._database.connection() as connection:
            row = connection.execute("SELECT link FROM cloud_draft_links WHERE registry_id=? AND user_id=? AND local_id=?",
                (registry_id,user_id,local_id)).fetchone()
            if row is None:
                row = connection.execute("SELECT link FROM cloud_draft_links WHERE registry_id=? AND user_id='' AND local_id=?",
                    (registry_id,local_id)).fetchone()
                if row is not None:
                    origin = msgspec.json.decode(database_bytes(row[0]),type=CloudDraftLink)
                    owned = bool(user_id) and user_id==origin.author_id
                    return msgspec.structs.replace(origin,owned=owned,source=origin.author_source if owned else origin.source)
        return None if row is None else msgspec.json.decode(database_bytes(row[0]), type=CloudDraftLink)

    def save_link(self, user_id: str, link: CloudDraftLink) -> None:
        with self._database.connection() as connection:
            if link.owned and connection.execute("""SELECT 1 FROM cloud_deleted_publications
                WHERE registry_id=? AND user_id=? AND asset_id=?""",
                (link.reference.registry_id, link.author_id, link.reference.asset_id)).fetchone() is not None:
                raise ConflictError("Cloud publication was deleted while creating the local draft")
            connection.execute("""INSERT INTO cloud_draft_links(registry_id,user_id,local_id,link) VALUES(?,?,?,?)
                ON CONFLICT(registry_id,user_id,local_id) DO UPDATE SET link=excluded.link""",
                (link.reference.registry_id,user_id,link.local_asset_id,msgspec.json.encode(link)))

    def outgoing(self, registry_id: str, user_id: str, request_id: str, local_id: str, request: CloudPublishRequest | CloudGraphPublishRequest,
                 payload: dict[str, F8JsonValue] | None = None) -> tuple[dict[str, F8JsonValue], CloudPublicationResult | None] | None:
        options = cast(dict[str, F8JsonValue], msgspec.to_builtins(request))
        if isinstance(request, CloudGraphPublishRequest) and not request.excluded_states:
            # Preserve retry identities saved before graph configuration choices
            # were added. An empty selection has the original request semantics.
            del options["excludedStates"]
        fingerprint = hashlib.sha256(canonical_json_bytes((local_id, options))).hexdigest()
        with self._database.connection() as connection:
            if payload is not None:
                connection.execute("""INSERT INTO cloud_outgoing_publications(registry_id,user_id,request_id,local_id,fingerprint,payload)
                    VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING""", (registry_id,user_id,request_id,local_id,fingerprint,msgspec.json.encode(payload)))
            row = connection.execute("""SELECT fingerprint,payload,result FROM cloud_outgoing_publications
                WHERE registry_id=? AND user_id=? AND request_id=?""", (registry_id,user_id,request_id)).fetchone()
            if row is None:
                return None
            if database_text(row[0]) != fingerprint:
                raise ConflictError("Publication request ID is already associated with different draft options")
            saved_payload = msgspec.json.decode(database_bytes(row[1]), type=dict[str,F8JsonValue])
            result = None if row[2] is None else msgspec.json.decode(database_bytes(row[2]),type=CloudPublicationResult)
            cloud_id = result.asset_id if result is not None else saved_payload.get("assetId")
            if isinstance(cloud_id, str) and connection.execute("""SELECT 1 FROM cloud_deleted_publications
                WHERE registry_id=? AND user_id=? AND asset_id=?""", (registry_id,user_id,cloud_id)).fetchone() is not None:
                raise ConflictError("Cloud publication was deleted; start a new publication")
            return saved_payload, result

    def remove_publication(self, registry_id: str, user_id: str, asset_id: str) -> None:
        with self._database.connection() as connection:
            # Retain a deletion record so a late publish response or cached
            # receipt cannot restore a removed link. Actual local content stays.
            connection.execute("""INSERT INTO cloud_deleted_publications(registry_id,user_id,asset_id)
                VALUES(?,?,?) ON CONFLICT DO NOTHING""", (registry_id,user_id,asset_id))
            rows = connection.execute("""SELECT user_id,local_id,link FROM cloud_draft_links
                WHERE registry_id=? AND user_id IN (?, '')""", (registry_id,user_id)).fetchall()
            for row in rows:
                link = msgspec.json.decode(database_bytes(row[2]), type=CloudDraftLink)
                if link.reference.asset_id == asset_id and link.author_id == user_id:
                    # Removing one's publication does not remove attribution
                    # from a derivative draft that may be published again.
                    connection.execute("""INSERT INTO cloud_draft_origins(registry_id,user_id,local_id,source)
                        VALUES(?,?,?,?) ON CONFLICT(registry_id,user_id,local_id) DO UPDATE SET source=excluded.source""",
                        (registry_id,user_id,database_text(row[1]),msgspec.json.encode(link.source)))
                    connection.execute("DELETE FROM cloud_draft_links WHERE registry_id=? AND user_id=? AND local_id=?",
                        (registry_id,database_text(row[0]),database_text(row[1])))

    def origin(self, registry_id: str, user_id: str, local_id: str) -> PublicationSource:
        with self._database.connection() as connection:
            row = connection.execute("SELECT source FROM cloud_draft_origins WHERE registry_id=? AND user_id=? AND local_id=?",
                (registry_id,user_id,local_id)).fetchone()
        return PublicationSource() if row is None else msgspec.json.decode(database_bytes(row[0]),type=PublicationSource)

    def complete(self, registry_id: str, user_id: str, request_id: str, result: CloudPublicationResult, link: CloudDraftLink) -> None:
        with self._database.connection() as connection:
            if connection.execute("""SELECT 1 FROM cloud_deleted_publications
                WHERE registry_id=? AND user_id=? AND asset_id=?""", (registry_id,user_id,result.asset_id)).fetchone() is not None:
                raise ConflictError("Cloud publication was deleted before its response arrived")
            connection.execute("""UPDATE cloud_outgoing_publications SET result=?
                WHERE registry_id=? AND user_id=? AND request_id=?""", (msgspec.json.encode(result),registry_id,user_id,request_id))
            existing = connection.execute("SELECT link FROM cloud_draft_links WHERE registry_id=? AND user_id=? AND local_id=?",
                (registry_id,user_id,link.local_asset_id)).fetchone()
            if existing is not None:
                previous = msgspec.json.decode(database_bytes(existing[0]), type=CloudDraftLink)
                if previous.reference.asset_id == result.asset_id and previous.reference.version > result.version:
                    return
            connection.execute("""INSERT INTO cloud_draft_links(registry_id,user_id,local_id,link) VALUES(?,?,?,?)
                ON CONFLICT(registry_id,user_id,local_id) DO UPDATE SET link=excluded.link""",
                (registry_id,user_id,link.local_asset_id,msgspec.json.encode(link)))
