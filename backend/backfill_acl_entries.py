"""Backfill ACL metadata for already indexed documents without re-embedding.

Dry-run is the default. Run with ``--apply`` only after reviewing the summary.
The script is restart-safe: documents with normalized ACL rows are skipped.
"""
from __future__ import annotations

import argparse
import json

from acl_security import minimum_role_acl, sync_vector_acl
from access_policy import ROLES
from database import connect, initDB


def _legacy_acl(access_level) -> list[str]:
    try:
        numeric = float(access_level)
    except (TypeError, ValueError):
        return ["role:admin"]
    role = next((name for name, level in ROLES.items() if float(level) == numeric), None)
    return minimum_role_acl(role) if role else ["role:admin"]


def candidates() -> list[dict]:
    initDB()
    with connect() as database:
        return [dict(row) for row in database.execute(
            """SELECT d.document_id, d.workspace_id, d.source_name,
                      da.access_level,
                      COUNT(a.acl_token) AS acl_count
               FROM documents d
               LEFT JOIN document_access da
                 ON da.workspace_id=d.workspace_id AND da.source_name=d.source_name
               LEFT JOIN document_acl_entries a
                 ON a.workspace_id=d.workspace_id AND a.document_id=d.document_id
               GROUP BY d.document_id, d.workspace_id, d.source_name, da.access_level
               HAVING COUNT(a.acl_token)=0
               ORDER BY d.workspace_id, d.document_id"""
        ).fetchall()]


def run(*, apply: bool = False, vector_db=None) -> dict:
    rows = candidates()
    summary = {
        "mode": "apply" if apply else "dry-run",
        "documents_found": len(rows),
        "documents_updated": 0,
        "chunks_updated": 0,
        "defaults_to_admin": 0,
    }
    if not apply or not rows:
        summary["defaults_to_admin"] = sum(row.get("access_level") is None for row in rows)
        return summary

    if vector_db is None:
        # Lazy import keeps the helper safe to call from API startup without a
        # circular import or a second embedding-model allocation.
        from rag_engine import DeepContextEngine
        vector_db = DeepContextEngine().get_vector_db(refresh=True)
    for row in rows:
        entries = _legacy_acl(row.get("access_level"))
        if row.get("access_level") is None:
            summary["defaults_to_admin"] += 1
        updated = sync_vector_acl(
            vector_db, row["workspace_id"], row["document_id"], entries,
            source_name=row["source_name"],
        )
        summary["documents_updated"] += 1
        summary["chunks_updated"] += updated
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write ACL rows and vector metadata")
    args = parser.parse_args()
    print(json.dumps(run(apply=args.apply), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
