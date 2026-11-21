"""Auditable, workspace-scoped contribution scoring."""
from __future__ import annotations

import os
import uuid
from contextlib import contextmanager

from database import connect, initDB
from document_registry import normalize_source_name


@contextmanager
def _connection():
    database = connect()
    try:
        yield database
        database.commit()
    except Exception:
        database.rollback()
        raise
    finally:
        database.close()


def badge_for_score(score: int) -> str | None:
    if score >= 25:
        return "Gold"
    if score >= 10:
        return "Silver"
    if score >= 1:
        return "Bronze"
    return None


def award_workspace_points(
    workspace_id: str,
    user_id: str,
    user_name: str,
    team_name: str,
    points: int,
    reason: str,
    *,
    event_key: str | None = None,
) -> bool:
    """Increment one contributor atomically; return False for a replayed event."""
    workspace_id = str(workspace_id or "").strip()
    user_id = str(user_id or "").strip()
    user_name = str(user_name or "Contributor").strip() or "Contributor"
    team_name = str(team_name or "Workspace").strip() or "Workspace"
    reason = str(reason or "Contribution").strip() or "Contribution"
    points = int(points)
    if not workspace_id or not user_id or points <= 0:
        return False

    initDB()
    event_key = event_key or f"manual:{uuid.uuid4().hex}"
    with _connection() as database:
        inserted = database.execute(
            """INSERT OR IGNORE INTO workspace_point_events
               (workspace_id, event_key, user_id, points, reason)
               VALUES (?, ?, ?, ?, ?)""",
            (workspace_id, event_key, user_id, points, reason),
        )
        if inserted.rowcount == 0:
            return False
        database.execute(
            """INSERT INTO workspace_leaderboard
               (workspace_id, user_id, user_name, team_name, score, updated_at)
               VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                 user_name=excluded.user_name,
                 team_name=excluded.team_name,
                 score=workspace_leaderboard.score + excluded.score,
                 updated_at=CURRENT_TIMESTAMP""",
            (workspace_id, user_id, user_name, team_name, points),
        )
    return True


def upload_contributor(upload: dict) -> dict | None:
    """Resolve the authenticated uploader and workspace names for an upload."""
    if not upload:
        return None
    workspace_id = str(upload.get("team_id") or "").strip()
    user_id = str(upload.get("uploaded_by") or "").strip()
    if not workspace_id or not user_id or user_id == "anonymous":
        return None
    with _connection() as database:
        row = database.execute(
            """SELECT u.id AS user_id, u.name AS user_name, w.name AS team_name
               FROM memberships m
               JOIN auth_users u ON u.id=m.user_id
               JOIN workspaces w ON w.id=m.workspace_id
               WHERE m.workspace_id=? AND m.user_id=?""",
            (workspace_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def award_approved_upload(upload: dict) -> bool:
    if not upload:
        return False
    contributor = upload_contributor(upload)
    if not contributor:
        return False
    return award_workspace_points(
        upload["team_id"],
        contributor["user_id"],
        contributor["user_name"],
        contributor["team_name"],
        10,
        f"Approved document upload: {os.path.basename(upload.get('source_name') or 'document')}",
        event_key=f"document-approved:{upload['document_id']}",
    )


def _legacy_source_contributor(workspace_id: str, source_name: str) -> dict | None:
    normalized = normalize_source_name(source_name)
    with _connection() as database:
        row = database.execute(
            """SELECT p.uploaded_by AS user_id, u.name AS user_name, w.name AS team_name
               FROM pending_uploads p
               JOIN auth_users u ON u.id=p.uploaded_by
               JOIN workspaces w ON w.id=p.team_id
               WHERE p.team_id=? AND LOWER(p.source_name)=? AND p.status='approved'
               ORDER BY p.approved_at DESC LIMIT 1""",
            (workspace_id, normalized),
        ).fetchone()
    return dict(row) if row else None


def award_cited_sources(workspace_id: str, sources: list[dict], response_id: str) -> int:
    """Award two points for each cited chunk, resolving legacy chunk ownership."""
    total = 0
    for source in sources or []:
        if not isinstance(source, dict):
            continue
        source_name = str(source.get("sourceName") or "").strip()
        contributor = None
        uploader_id = str(source.get("_uploader_id") or "").strip()
        if uploader_id:
            contributor = {
                "user_id": uploader_id,
                "user_name": source.get("_uploader_name") or "Contributor",
                "team_name": source.get("_uploader_team") or "Workspace",
            }
        if not contributor and source_name:
            contributor = _legacy_source_contributor(workspace_id, source_name)
        if not contributor:
            continue
        chunks = max(int(source.get("chunk_count") or 1), 1)
        points = chunks * 2
        awarded = award_workspace_points(
            workspace_id,
            contributor["user_id"],
            contributor["user_name"],
            contributor["team_name"],
            points,
            f"Cited {chunks} chunk(s) from {os.path.basename(source_name)}",
            event_key=f"citation:{response_id}:{normalize_source_name(source_name)}:{contributor['user_id']}",
        )
        if awarded:
            total += points
    return total


def get_workspace_leaderboard(workspace_id: str, limit: int = 10) -> list[dict]:
    workspace_id = str(workspace_id or "").strip()
    if not workspace_id:
        return []
    with _connection() as database:
        rows = database.execute(
            """SELECT user_id, user_name, team_name, score
               FROM workspace_leaderboard
               WHERE workspace_id=? AND score>0
               ORDER BY score DESC, user_name ASC, user_id ASC
               LIMIT ?""",
            (workspace_id, max(1, min(int(limit), 100))),
        ).fetchall()
    return [
        {
            "user_id": row["user_id"],
            "display_name": row["user_name"],
            "team": row["team_name"],
            "contributions": int(row["score"]),
            "badge": badge_for_score(int(row["score"])),
        }
        for row in rows
    ]
