"""Workspace-isolated Nexconn Chat connection bootstrap.

The browser never receives the Nexconn App Secret. It asks this router for a
connection bootstrap; the backend signs Nexconn's access-token request and
returns only the public App Key, user token, and derived workspace channel.
"""

import hashlib
import asyncio
import logging
import os
import secrets
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from auth import connect as auth_connect, current


router = APIRouter(prefix="/nexconn", tags=["Nexconn Chat"])
logger = logging.getLogger(__name__)

AREA_CODES = {"sg", "bj", "na", "sa", "om"}


def _settings() -> dict:
    """Read settings per request so tests and local .env changes are visible."""
    return {
        "base_url": os.getenv("NEXCONN_API_BASE_URL", "").strip().rstrip("/"),
        # NEXCONN_API_TOKEN was used by the first prototype but actually held
        # the public App Key. Keep it as a migration fallback only.
        "app_key": (os.getenv("NEXCONN_APP_KEY", "").strip()
                    or os.getenv("NEXCONN_API_TOKEN", "").strip()),
        "app_secret": os.getenv("NEXCONN_APP_SECRET", "").strip(),
        "area_code": os.getenv("NEXCONN_AREA_CODE", "sg").strip().lower(),
    }


def _signature(app_secret: str, nonce: str, timestamp: str) -> str:
    """Nexconn signature: SHA1(App Secret + Nonce + Timestamp)."""
    return hashlib.sha1(f"{app_secret}{nonce}{timestamp}".encode("utf-8")).hexdigest()


def _nexconn_user_id(workspace_id: str, user_id: str) -> str:
    """Create a stable, opaque Nexconn ID within its 64-byte limit."""
    digest = hashlib.sha256(f"{workspace_id}:{user_id}".encode("utf-8")).hexdigest()
    return f"dc{digest[:48]}"


def _workspace_channel(workspace_id: str, workspace_name: str) -> dict:
    """Derive a stable, provider-safe group for one authenticated workspace."""
    digest = hashlib.sha256(str(workspace_id).encode("utf-8")).hexdigest()
    name = str(workspace_name or "DeepContext Workspace").strip() or "DeepContext Workspace"
    return {"type": "group", "id": f"dcw{digest[:40]}", "subchannel_id": "", "name": name[:64]}


def _configuration_error(settings: dict) -> str | None:
    names = {
        "base_url": "NEXCONN_API_BASE_URL",
        "app_key": "NEXCONN_APP_KEY",
        "app_secret": "NEXCONN_APP_SECRET",
    }
    missing = [environment_name for key, environment_name in names.items() if not settings[key]]
    if missing:
        return f"Missing Nexconn settings: {', '.join(missing)}. Save backend/.env and restart the API."
    if settings["area_code"] not in AREA_CODES:
        return "NEXCONN_AREA_CODE must be sg, bj, na, sa, or om."
    parsed = urlsplit(settings["base_url"])
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return "NEXCONN_API_BASE_URL must be a valid HTTPS Nexconn API base URL."
    return None


def _workspace_members(workspace_id: str) -> list[dict]:
    with auth_connect() as database:
        rows = database.execute(
            """SELECT u.id, u.name, m.role FROM memberships m
               JOIN auth_users u ON u.id=m.user_id
               WHERE m.workspace_id=? ORDER BY u.id""",
            (workspace_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def _huddle_call(workspace_id: str) -> str | None:
    with auth_connect() as database:
        database.execute(
            """CREATE TABLE IF NOT EXISTS nexconn_huddles (
                   workspace_id TEXT PRIMARY KEY,
                   call_id TEXT NOT NULL,
                   updated_at INTEGER NOT NULL
               )"""
        )
        row = database.execute(
            "SELECT call_id, updated_at FROM nexconn_huddles WHERE workspace_id=?",
            (workspace_id,),
        ).fetchone()
        if not row:
            return None
        if row["updated_at"] < int(time.time()) - 4 * 60 * 60:
            database.execute("DELETE FROM nexconn_huddles WHERE workspace_id=?", (workspace_id,))
            return None
        return row["call_id"]


class HuddleCall(BaseModel):
    call_id: str = Field(min_length=1, max_length=128)


async def _signed_post(settings: dict, path: str, payload: dict) -> dict:
    nonce = secrets.token_hex(8)
    timestamp = str(int(time.time() * 1000))
    headers = {
        "App-Key": settings["app_key"],
        "Nonce": nonce,
        "Timestamp": timestamp,
        "Signature": _signature(settings["app_secret"], nonce, timestamp),
        "Content-Type": "application/json",
        "X-Request-ID": secrets.token_hex(16),
    }
    url = f'{settings["base_url"]}{path}'

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, headers=headers, json=payload)
            body = response.json()
            # Nexconn returns documented business errors as HTTP 400. Callers
            # need the provider code (for example 25410 = group missing) to
            # perform the correct recovery instead of treating it as transport
            # failure.
            if response.status_code == 400 and isinstance(body, dict) and body.get("code") is not None:
                logger.info(
                    "Nexconn business response | path=%s code=%s request_id=%s",
                    path, body.get("code"), response.headers.get("x-request-id"),
                )
                return body
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        logger.warning("Nexconn API rejected %s with HTTP %s", path, status)
        if status in {401, 403}:
            raise HTTPException(
                502,
                "Nexconn rejected the App Key/App Secret signature. Verify that both credentials come from the same application and environment.",
            )
        if status == 404:
            raise HTTPException(
                502,
                "Nexconn API endpoint was not found. Verify NEXCONN_API_BASE_URL and its data-center region.",
            )
        raise HTTPException(502, f"Nexconn server request failed (HTTP {status}).")
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Nexconn API request failed for %s: %s", path, exc)
        raise HTTPException(502, "Nexconn could not be reached or returned invalid data. Check its base URL and network connection.")
    return body


async def _issue_access_token(settings: dict, user_id: str, name: str) -> str:
    body = await _signed_post(
        settings,
        "/v4/auth/access-token/issue",
        {"userId": user_id, "name": name[:64]},
    )

    token = (body.get("result") or {}).get("accessToken")
    if body.get("code") != 0 or not token:
        logger.warning("Nexconn token request rejected: code=%s", body.get("code"))
        message = str(body.get("errorMessage") or body.get("message") or "").strip()[:180]
        detail = f"Nexconn rejected token issuance (code {body.get('code')})"
        raise HTTPException(502, f"{detail}: {message}" if message else detail)
    return token


async def _ensure_group_membership(settings: dict, channel: dict, user_id: str, can_create: bool) -> None:
    """Add a user to the workspace group, creating it when the owner connects first."""
    membership = await _signed_post(
        settings,
        "/v4/group-channel/join",
        {"channelId": channel["id"], "userIds": [user_id]},
    )
    membership_code = membership.get("code")
    if membership_code in {0, 25412}:  # success / already a member
        return
    if membership_code != 25410:
        message = str(membership.get("errorMessage") or membership.get("message") or "").strip()[:180]
        detail = f"Nexconn could not join the workspace group (code {membership_code})"
        raise HTTPException(502, f"{detail}: {message}" if message else detail)
    if not can_create:
        raise HTTPException(409, "The Nexconn group is not ready. Ask the workspace owner to open the Nexconn tab once.")

    created = await _signed_post(
        settings,
        "/v4/group-channel/create",
        {
            "channelId": channel["id"],
            "name": channel["name"],
            "owner": user_id,
        },
    )
    if created.get("code") == 0:
        return
    if created.get("code") != 25409:  # another request may have created it
        message = str(created.get("errorMessage") or created.get("message") or "").strip()[:180]
        detail = f"Nexconn could not create the workspace group (code {created.get('code')})"
        raise HTTPException(502, f"{detail}: {message}" if message else detail)

    # Another owner request may have created the group concurrently.
    retry = await _signed_post(
        settings,
        "/v4/group-channel/join",
        {"channelId": channel["id"], "userIds": [user_id]},
    )
    if retry.get("code") not in {0, 25412}:
        logger.warning("Nexconn group provisioning rejected: code=%s", retry.get("code"))
        raise HTTPException(502, "Nexconn could not create or join the configured group channel.")


@router.get("/session")
async def nexconn_session():
    """Return a safe client bootstrap for the authenticated workspace member."""
    principal = current()
    settings = _settings()
    error = _configuration_error(settings)
    if error:
        return {"enabled": False, "reason": error}

    channel = _workspace_channel(principal["workspace_id"], principal["workspace_name"])
    members = _workspace_members(principal["workspace_id"])
    provider_ids = {
        member["id"]: _nexconn_user_id(principal["workspace_id"], member["id"])
        for member in members
    }

    # Issuing a token registers each workspace identity with Nexconn. This lets
    # the browser subscribe to presence and mention members who have not opened
    # the Nexconn tab yet; only the current user's token is returned.
    tokens = await asyncio.gather(*(
        _issue_access_token(settings, provider_ids[member["id"]], member["name"])
        for member in members
    ))
    current_index = next(index for index, member in enumerate(members) if member["id"] == principal["id"])
    nexconn_user_id = provider_ids[principal["id"]]
    await _ensure_group_membership(settings, channel, nexconn_user_id, principal["role"] == "owner")
    await asyncio.gather(*(
        _ensure_group_membership(settings, channel, provider_ids[member["id"]], False)
        for member in members if member["id"] != principal["id"]
    ))
    return {
        "enabled": True,
        "app_key": settings["app_key"],
        "token": tokens[current_index],
        "user_id": nexconn_user_id,
        "channel": channel,
        "area_code": settings["area_code"],
        "members": [
            {
                "id": member["id"],
                "provider_id": provider_ids[member["id"]],
                "name": member["name"],
                "role": member["role"],
            }
            for member in members
        ],
    }


@router.get("/huddle-session")
async def nexconn_huddle_session():
    """Return Call SDK bootstrap data for the active workspace huddle."""
    principal = current()
    settings = _settings()
    error = _configuration_error(settings)
    if error:
        return {"enabled": False, "reason": error}

    channel = _workspace_channel(principal["workspace_id"], principal["workspace_name"])
    members = _workspace_members(principal["workspace_id"])
    member_ids = {
        member["id"]: _nexconn_user_id(principal["workspace_id"], member["id"])
        for member in members
    }

    # Token issuance also registers a Nexconn identity. Register every current
    # workspace member so a caller can invite them even before they open Huddle.
    tokens = await asyncio.gather(*(
        _issue_access_token(settings, member_ids[member["id"]], member["name"])
        for member in members
    ))
    current_index = next(index for index, member in enumerate(members) if member["id"] == principal["id"])
    user_id = member_ids[principal["id"]]
    await _ensure_group_membership(settings, channel, user_id, principal["role"] == "owner")

    return {
        "enabled": True,
        "app_key": settings["app_key"],
        "token": tokens[current_index],
        "user_id": user_id,
        "area_code": settings["area_code"],
        "workspace": {"id": principal["workspace_id"], "name": principal["workspace_name"]},
        "callee_ids": [provider_id for user, provider_id in member_ids.items() if user != principal["id"]],
        "call_id": _huddle_call(principal["workspace_id"]),
    }


@router.post("/huddle")
def save_nexconn_huddle(payload: HuddleCall):
    principal = current()
    with auth_connect() as database:
        database.execute(
            """CREATE TABLE IF NOT EXISTS nexconn_huddles (
                   workspace_id TEXT PRIMARY KEY,
                   call_id TEXT NOT NULL,
                   updated_at INTEGER NOT NULL
               )"""
        )
        database.execute(
            """INSERT INTO nexconn_huddles VALUES (?, ?, ?)
               ON CONFLICT(workspace_id) DO UPDATE SET
               call_id=excluded.call_id, updated_at=excluded.updated_at""",
            (principal["workspace_id"], payload.call_id, int(time.time())),
        )
    return {"message": "Huddle is active", "call_id": payload.call_id}


@router.delete("/huddle/{call_id}")
def clear_nexconn_huddle(call_id: str):
    principal = current()
    with auth_connect() as database:
        database.execute(
            "DELETE FROM nexconn_huddles WHERE workspace_id=? AND call_id=?",
            (principal["workspace_id"], call_id),
        )
    return {"message": "Huddle ended"}
