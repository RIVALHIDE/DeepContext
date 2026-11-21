"""Zero-trust, workspace-scoped document ACL security.

ACLs are stored as normalized tokens in the relational database and copied to
every vector chunk. Chroma metadata cannot store/query arrays reliably across
the supported versions, so chunks also receive deterministic boolean keys for
native query-time filtering. The original ``acl_entries`` value remains on
each chunk as canonical JSON for auditing and migrations.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Iterable

from database import connect, initDB


DEFAULT_ACL = ("role:admin",)
TOKEN_PATTERN = re.compile(r"^(?:user|group|role):[a-z0-9][a-z0-9._:@+-]{0,127}$")
SYSTEM_ROLES = ("viewer", "member", "editor", "admin", "owner")
ROLE_RANK = {"viewer": 0, "member": 1, "editor": 1.5, "admin": 2, "owner": 3}


def enforcement_mode() -> str:
    value = os.getenv("ACL_ENFORCEMENT_MODE", "enforce").strip().lower()
    return value if value in {"shadow", "enforce"} else "enforce"


def normalize_acl_entries(entries: Iterable[str] | str | None, *, default=True) -> list[str]:
    if isinstance(entries, str):
        raw = entries.strip()
        if raw.startswith("["):
            try:
                entries = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError("acl_entries must be a JSON list of ACL tokens") from exc
        else:
            entries = [raw]

    normalized: list[str] = []
    for entry in entries or ():
        token = str(entry or "").strip().lower()
        if token == "public":
            pass
        elif not TOKEN_PATTERN.fullmatch(token):
            raise ValueError(f"Invalid ACL token: {entry!r}")
        if token and token not in normalized:
            normalized.append(token)
    if not normalized and default:
        normalized = list(DEFAULT_ACL)
    return sorted(normalized)


def minimum_role_acl(role: str) -> list[str]:
    """Translate the legacy minimum-role UI into explicit role tokens."""
    role = str(role or "").strip().lower()
    if role not in ROLE_RANK:
        raise ValueError("Unknown access role")
    if role == "viewer":
        return ["public"]
    threshold = ROLE_RANK[role]
    return [f"role:{candidate}" for candidate in SYSTEM_ROLES if ROLE_RANK[candidate] >= threshold]


def acl_display_role(entries) -> str:
    tokens = normalize_acl_entries(entries, default=False)
    for role in SYSTEM_ROLES:
        if tokens == sorted(minimum_role_acl(role)):
            return role
    return "custom"


def acl_metadata(entries: Iterable[str] | str | None) -> dict:
    tokens = normalize_acl_entries(entries)
    metadata = {"acl_entries": json.dumps(tokens, separators=(",", ":"))}
    for token in tokens:
        metadata[acl_token_key(token)] = True
    return metadata


def parse_acl_metadata(metadata: dict | None) -> list[str]:
    if not isinstance(metadata, dict):
        return []
    raw = metadata.get("acl_entries")
    try:
        return normalize_acl_entries(raw, default=False)
    except ValueError:
        return []


def acl_token_key(token: str) -> str:
    normalized = normalize_acl_entries([token], default=False)[0]
    return "acl_" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def strip_acl_metadata(metadata: dict | None) -> dict:
    """Remove old ACL flags before a permission-only metadata update."""
    return {
        key: value for key, value in (metadata or {}).items()
        if key != "acl_entries" and not str(key).startswith("acl_")
    }


def effective_acl_scope(principal: dict) -> dict:
    """Resolve identity and groups from the authenticated server-side user."""
    workspace_id = str(principal.get("workspace_id") or "").strip()
    user_id = str(principal.get("id") or "").strip()
    if not workspace_id or not user_id:
        raise ValueError("A verified workspace identity is required")

    initDB()
    with connect() as database:
        membership = database.execute(
            "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
            (workspace_id, user_id),
        ).fetchone()
        role = str(membership["role"] if membership else "").strip().lower()
        if role not in SYSTEM_ROLES:
            raise ValueError("A verified workspace membership is required")
        rows = database.execute(
            """SELECT gm.group_id FROM group_memberships gm
               JOIN workspace_groups g
                 ON g.workspace_id=gm.workspace_id AND g.id=gm.group_id
               WHERE gm.workspace_id=? AND gm.user_id=?
               ORDER BY gm.group_id""",
            (workspace_id, user_id),
        ).fetchall()
    tokens = ["public", f"user:{user_id}", f"role:{role}"]
    # The existing product role is named "editor"; expose the conventional
    # curator ACL token as an exact alias without changing JWT/system roles.
    if role == "editor":
        tokens.append("role:curator")
    tokens.extend(f"group:{row['group_id']}" for row in rows)
    return {
        "workspace_id": workspace_id,
        "user_id": user_id,
        "role": role,
        "legacy_level": ROLE_RANK[role],
        "effective_acl": normalize_acl_entries(tokens, default=False),
    }


def acl_filter(scope: dict, source_names: Iterable[str] | None = None) -> dict:
    """Build a native vector-store filter; never return an unscoped query."""
    if not isinstance(scope, dict):
        raise ValueError("A server-resolved ACL scope is required")
    workspace_id = str(scope.get("workspace_id") or "").strip()
    tokens = normalize_acl_entries(scope.get("effective_acl"), default=False)
    if not workspace_id or not tokens:
        raise ValueError("A non-empty verified ACL scope is required")

    filters: list[dict] = [{"team_id": workspace_id}]
    if enforcement_mode() == "shadow":
        filters.append({"access_level": {"$lte": scope.get("legacy_level", -1)}})
    else:
        filters.append({"$or": [{acl_token_key(token): True} for token in tokens]})

    selected = list(dict.fromkeys(
        str(name).strip().casefold() for name in (source_names or ()) if str(name).strip()
    ))
    if selected:
        filters.append({"source_name": {"$in": selected}})
    return {"$and": filters}


def can_access_acl(principal_or_scope: dict, entries: Iterable[str] | str | None) -> bool:
    scope = (
        principal_or_scope if "effective_acl" in principal_or_scope
        else effective_acl_scope(principal_or_scope)
    )
    document_tokens = set(normalize_acl_entries(entries, default=False))
    return bool(document_tokens.intersection(scope["effective_acl"]))


def save_document_acl(workspace_id: str, document_id: str, entries) -> list[str]:
    tokens = normalize_acl_entries(entries)
    now = datetime.now(timezone.utc).isoformat()
    with connect() as database:
        database.execute(
            "DELETE FROM document_acl_entries WHERE workspace_id=? AND document_id=?",
            (workspace_id, document_id),
        )
        for token in tokens:
            database.execute(
                """INSERT INTO document_acl_entries
                   (workspace_id, document_id, acl_token, updated_at)
                   VALUES (?, ?, ?, ?)""",
                (workspace_id, document_id, token, now),
            )
        database.execute(
            "UPDATE documents SET acl_entries=?, updated_at=CURRENT_TIMESTAMP "
            "WHERE workspace_id=? AND document_id=?",
            (json.dumps(tokens), workspace_id, document_id),
        )
    return tokens


def document_acl(workspace_id: str, document_id: str) -> list[str]:
    with connect() as database:
        rows = database.execute(
            """SELECT acl_token FROM document_acl_entries
               WHERE workspace_id=? AND document_id=? ORDER BY acl_token""",
            (workspace_id, document_id),
        ).fetchall()
        if rows:
            return [row["acl_token"] for row in rows]
        row = database.execute(
            "SELECT acl_entries FROM documents WHERE workspace_id=? AND document_id=?",
            (workspace_id, document_id),
        ).fetchone()
    if not row:
        return []
    try:
        return normalize_acl_entries(row["acl_entries"], default=False)
    except ValueError:
        return []


def sync_vector_acl(
    vector_db, workspace_id: str, document_id: str, entries,
    *, source_name: str | None = None,
) -> int:
    """Update ACL metadata only; document text and embeddings remain unchanged."""
    tokens = normalize_acl_entries(entries)
    snapshot = vector_db.get(where={"$and": [
        {"team_id": workspace_id}, {"document_id": document_id},
    ]})
    ids = snapshot.get("ids", [])
    metadatas = snapshot.get("metadatas", [])
    if not ids and source_name:
        snapshot = vector_db.get(where={"$and": [
            {"team_id": workspace_id}, {"source_name": str(source_name).casefold()},
        ]})
        ids = snapshot.get("ids", [])
        metadatas = snapshot.get("metadatas", [])
    if ids:
        acl_values = acl_metadata(tokens)
        updated = [
            {**strip_acl_metadata(meta), "document_id": document_id, **acl_values}
            for meta in metadatas
        ]
        vector_db._collection.update(ids=ids, metadatas=updated)
    save_document_acl(workspace_id, document_id, tokens)
    return len(ids)


def record_retrieval_audit(scope: dict, query: str, documents: list) -> None:
    """Append a privacy-preserving retrieval audit event."""
    document_ids = sorted({
        str((getattr(doc, "metadata", {}) or {}).get("document_id"))
        for doc in documents or []
        if (getattr(doc, "metadata", {}) or {}).get("document_id")
    })
    tokens = normalize_acl_entries(scope.get("effective_acl"), default=False)
    token_fingerprint = hashlib.sha256("\n".join(tokens).encode()).hexdigest()
    query_hash = hashlib.sha256(str(query or "").encode()).hexdigest()
    scope_summary = {
        "public": "public" in tokens,
        "user_tokens": sum(token.startswith("user:") for token in tokens),
        "group_tokens": sum(token.startswith("group:") for token in tokens),
        "role_tokens": sum(token.startswith("role:") for token in tokens),
    }
    with connect() as database:
        database.execute(
            """INSERT INTO retrieval_audit_log
               (id, workspace_id, user_id, occurred_at, query_hash,
                acl_scope_hash, acl_token_count, acl_scope_summary,
                retrieved_document_ids, result_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                uuid.uuid4().hex,
                scope["workspace_id"],
                scope["user_id"],
                datetime.now(timezone.utc).isoformat(),
                query_hash,
                token_fingerprint,
                len(tokens),
                json.dumps(scope_summary, sort_keys=True),
                json.dumps(document_ids),
                len(documents or []),
            ),
        )
