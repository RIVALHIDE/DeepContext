import json
import os
import sqlite3
import uuid
from collections import defaultdict
from datetime import datetime

from database import DB_PATH, initDB


def _ensure_db():
    initDB()


def normalize_source_name(source_name: str) -> str:
    return os.path.basename(str(source_name or "").strip()).casefold()


def _connect():
    _ensure_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    chunk_ids_raw = data.get("chunk_ids") or "[]"
    try:
        data["chunk_ids"] = json.loads(chunk_ids_raw)
    except json.JSONDecodeError:
        data["chunk_ids"] = []
    return data


def get_document(source_name: str) -> dict | None:
    normalized = normalize_source_name(source_name)
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM documents WHERE source_name = ?",
            (normalized,),
        ).fetchone()
        return _row_to_dict(row)
    finally:
        conn.close()


def list_documents() -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT *
            FROM documents
            WHERE status = 'active'
            ORDER BY updated_at DESC, source_name ASC
            """
        ).fetchall()
        return [_row_to_dict(row) for row in rows]
    finally:
        conn.close()


def prepare_supersede(source_name: str) -> tuple[str, int]:
    normalized = normalize_source_name(source_name)
    existing = get_document(normalized)
    if existing:
        return existing["document_id"], int(existing["current_version"]) + 1
    return str(uuid.uuid4()), 1


def upsert_document(
    *,
    document_id: str,
    source_name: str,
    current_version: int,
    chunk_ids: list[str],
    ingested_at: str,
    status: str = "active",
) -> dict:
    normalized = normalize_source_name(source_name)
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO documents (
                document_id,
                source_name,
                current_version,
                chunk_ids,
                ingested_at,
                status,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_name) DO UPDATE SET
                document_id = excluded.document_id,
                current_version = excluded.current_version,
                chunk_ids = excluded.chunk_ids,
                ingested_at = excluded.ingested_at,
                status = excluded.status,
                updated_at = excluded.updated_at
            """,
            (
                document_id,
                normalized,
                current_version,
                json.dumps(chunk_ids),
                ingested_at,
                status,
                now,
                now,
            ),
        )
        conn.commit()
        return get_document(normalized)
    finally:
        conn.close()


def delete_document_record(source_name: str) -> bool:
    normalized = normalize_source_name(source_name)
    conn = _connect()
    try:
        cursor = conn.execute(
            "DELETE FROM documents WHERE source_name = ?",
            (normalized,),
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def collect_chunk_ids_from_chroma(vector_db, source_name: str) -> list[str]:
    normalized = normalize_source_name(source_name)
    data = vector_db.get()
    ids = data.get("ids", [])
    metadatas = data.get("metadatas", [])

    matching_ids = []
    for doc_id, metadata in zip(ids, metadatas):
        if not isinstance(metadata, dict):
            continue
        meta_name = normalize_source_name(metadata.get("source_name", ""))
        if meta_name == normalized:
            matching_ids.append(doc_id)
    return matching_ids


def delete_chunks_for_source(vector_db, source_name: str) -> int:
    normalized = normalize_source_name(source_name)
    registry_entry = get_document(normalized)
    candidate_ids = set(registry_entry.get("chunk_ids", []) if registry_entry else [])
    candidate_ids.update(collect_chunk_ids_from_chroma(vector_db, normalized))

    if not candidate_ids:
        return 0

    vector_db.delete(ids=list(candidate_ids))
    return len(candidate_ids)


def collect_chunk_ids_for_version(
    vector_db,
    source_name: str,
    *,
    version: int,
    ingested_at: str | None = None,
) -> list[str]:
    normalized = normalize_source_name(source_name)
    data = vector_db.get()
    ids = data.get("ids", [])
    metadatas = data.get("metadatas", [])

    matching_ids = []
    for doc_id, metadata in zip(ids, metadatas):
        if not isinstance(metadata, dict):
            continue
        if normalize_source_name(metadata.get("source_name", "")) != normalized:
            continue
        meta_version = metadata.get("version")
        try:
            meta_version_int = int(meta_version)
        except (TypeError, ValueError):
            meta_version_int = None
        if meta_version_int != version:
            continue
        if ingested_at and metadata.get("ingested_at") != ingested_at:
            continue
        matching_ids.append(doc_id)
    return matching_ids


def migrate_legacy_duplicate_chunks(vector_db) -> dict:
    data = vector_db.get()  
    ids = data.get("ids", [])
    metadatas = data.get("metadatas", [])

    grouped: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    display_names: dict[str, str] = {}

    for doc_id, metadata in zip(ids, metadatas):
        if not isinstance(metadata, dict):
            continue
        source_name = metadata.get("source_name")
        if not source_name:
            continue
        normalized = normalize_source_name(source_name)
        ingested_at = metadata.get("ingested_at") or ""
        grouped[normalized][ingested_at].append(doc_id)
        display_names[normalized] = str(source_name)

    deleted_count = 0
    documents_processed = 0

    for normalized, ingested_map in grouped.items():
        sorted_ingested = sorted(ingested_map.keys(), reverse=True)
        latest_ingested_at = sorted_ingested[0]
        keep_ids = ingested_map[latest_ingested_at]
        stale_ids = [
            chunk_id
            for ingested_at in sorted_ingested[1:]
            for chunk_id in ingested_map[ingested_at]
        ]

        if stale_ids:
            vector_db.delete(ids=stale_ids)
            deleted_count += len(stale_ids)

        existing = get_document(normalized)
        document_id = existing["document_id"] if existing else str(uuid.uuid4())
        current_version = int(existing["current_version"]) if existing else max(len(sorted_ingested), 1)

        upsert_document(
            document_id=document_id,
            source_name=display_names.get(normalized, normalized),
            current_version=current_version,
            chunk_ids=keep_ids,
            ingested_at=latest_ingested_at,
            status="active",
        )
        documents_processed += 1

    return {
        "documents_processed": documents_processed,
        "stale_chunks_deleted": deleted_count,
    }


# ── Pending upload management ──────────────────────────────────────────────

def create_pending_upload(
    *,
    document_id: str,
    source_name: str,
    file_path: str,
    file_size: int,
    mime_type: str,
    uploaded_by: str = "anonymous",
    team_id: str = "default",
) -> dict:
    """Insert a new pending upload record awaiting approval."""
    _ensure_db()
    conn = _connect()
    try:
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            """
            INSERT INTO pending_uploads
                (document_id, source_name, file_path, file_size, mime_type,
                 status, uploaded_by, team_id, uploaded_at)
            VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?)
            """,
            (document_id, source_name, file_path, file_size, mime_type,
             uploaded_by, team_id, now),
        )
        conn.commit()
        return get_pending_upload(document_id)
    finally:
        conn.close()


def get_pending_upload(document_id: str) -> dict | None:
    _ensure_db()
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM pending_uploads WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_pending_uploads() -> list[dict]:
    _ensure_db()
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT * FROM pending_uploads
            WHERE status = 'pending_approval'
            ORDER BY uploaded_at DESC
            """
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def approve_pending_upload(document_id: str, approved_by: str = "admin", job_id: str = None) -> bool:
    _ensure_db()
    conn = _connect()
    try:
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        cursor = conn.execute(
            """
            UPDATE pending_uploads
            SET status = 'approved', approved_at = ?, approved_by = ?, job_id = ?
            WHERE document_id = ? AND status = 'pending_approval'
            """,
            (now, approved_by, job_id, document_id),
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def reject_pending_upload(document_id: str) -> bool:
    _ensure_db()
    conn = _connect()
    try:
        cursor = conn.execute(
            """
            UPDATE pending_uploads
            SET status = 'rejected'
            WHERE document_id = ? AND status = 'pending_approval'
            """,
            (document_id,),
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()
