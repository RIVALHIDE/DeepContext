"""Workspace-bound Nexconn Chat connection bootstrap.

The browser never receives the Nexconn App Secret. It asks this router for a
connection bootstrap; the backend signs Nexconn's access-token request and
returns only the public App Key, user token, and configured channel.
"""

import hashlib
import logging
import os
import secrets
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException

from auth import current


router = APIRouter(prefix="/nexconn", tags=["Nexconn Chat"])
logger = logging.getLogger(__name__)

CHANNEL_TYPES = {"direct", "group", "open", "community"}
AREA_CODES = {"sg", "bj", "na", "sa", "om"}


def _settings() -> dict:
    """Read settings per request so tests and local .env changes are visible."""
    return {
        "base_url": os.getenv("NEXCONN_API_BASE_URL", "").strip().rstrip("/"),
        "app_key": os.getenv("NEXCONN_APP_KEY", "").strip(),
        "app_secret": os.getenv("NEXCONN_APP_SECRET", "").strip(),
        "workspace_id": os.getenv("NEXCONN_WORKSPACE_ID", "").strip(),
        "channel_type": os.getenv("NEXCONN_CHANNEL_TYPE", "group").strip().lower(),
        "channel_id": os.getenv("NEXCONN_CHANNEL_ID", "").strip(),
        "subchannel_id": os.getenv("NEXCONN_SUBCHANNEL_ID", "").strip(),
        "channel_name": os.getenv("NEXCONN_CHANNEL_NAME", "Nexconn Channel").strip(),
        "area_code": os.getenv("NEXCONN_AREA_CODE", "sg").strip().lower(),
    }


def _signature(app_secret: str, nonce: str, timestamp: str) -> str:
    """Nexconn signature: SHA1(App Secret + Nonce + Timestamp)."""
    return hashlib.sha1(f"{app_secret}{nonce}{timestamp}".encode("utf-8")).hexdigest()


def _nexconn_user_id(workspace_id: str, user_id: str) -> str:
    """Create a stable, opaque Nexconn ID within its 64-byte limit."""
    digest = hashlib.sha256(f"{workspace_id}:{user_id}".encode("utf-8")).hexdigest()
    return f"dc{digest[:48]}"


def _configuration_error(settings: dict, workspace_id: str) -> str | None:
    required = ("base_url", "app_key", "app_secret", "workspace_id", "channel_id")
    if any(not settings[key] for key in required):
        return "Nexconn is not configured for this server."
    if settings["workspace_id"] != workspace_id:
        return "Nexconn is not enabled for this workspace."
    if settings["channel_type"] not in CHANNEL_TYPES:
        return "NEXCONN_CHANNEL_TYPE must be direct, group, open, or community."
    if settings["channel_type"] == "community" and not settings["subchannel_id"]:
        return "NEXCONN_SUBCHANNEL_ID is required for a community channel."
    if settings["channel_type"] == "group" and (
        len(settings["channel_id"]) > 64 or not settings["channel_id"].isalnum()
    ):
        return "A Nexconn group channel ID must contain only letters and numbers (maximum 64)."
    if settings["area_code"] not in AREA_CODES:
        return "NEXCONN_AREA_CODE must be sg, bj, na, sa, or om."
    parsed = urlsplit(settings["base_url"])
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return "NEXCONN_API_BASE_URL must be a valid HTTPS Nexconn API base URL."
    return None


async def _signed_post(settings: dict, path: str, payload: dict) -> dict:
    nonce = secrets.token_hex(8)
    timestamp = str(int(time.time() * 1000))
    headers = {
        "App-Key": settings["app_key"],
        "Nonce": nonce,
        "Timestamp": timestamp,
        "Signature": _signature(settings["app_secret"], nonce, timestamp),
        "Content-Type": "application/json",
    }
    url = f'{settings["base_url"]}{path}'

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Nexconn API request failed for %s: %s", path, exc)
        raise HTTPException(502, "Nexconn could not complete the server request. Check its base URL and credentials.")
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
        raise HTTPException(502, "Nexconn rejected the connection token request.")
    return token


async def _ensure_group_membership(settings: dict, user_id: str, can_create: bool) -> None:
    """Add a user to the workspace group, creating it when the owner connects first."""
    membership = await _signed_post(
        settings,
        "/v4/group-channel/join",
        {"channelId": settings["channel_id"], "userIds": [user_id]},
    )
    if membership.get("code") == 0:
        return
    if not can_create:
        raise HTTPException(409, "The Nexconn group is not ready. Ask the workspace owner to open the Nexconn tab once.")

    created = await _signed_post(
        settings,
        "/v4/group-channel/create",
        {
            "channelId": settings["channel_id"],
            "name": settings["channel_name"][:64],
            "owner": user_id,
        },
    )
    if created.get("code") == 0:
        return

    # Another owner request may have created the group concurrently.
    retry = await _signed_post(
        settings,
        "/v4/group-channel/join",
        {"channelId": settings["channel_id"], "userIds": [user_id]},
    )
    if retry.get("code") != 0:
        logger.warning("Nexconn group provisioning rejected: code=%s", retry.get("code"))
        raise HTTPException(502, "Nexconn could not create or join the configured group channel.")


@router.get("/session")
async def nexconn_session():
    """Return a safe client bootstrap for the authenticated workspace member."""
    principal = current()
    settings = _settings()
    error = _configuration_error(settings, principal["workspace_id"])
    if error:
        return {"enabled": False, "reason": error}

    nexconn_user_id = _nexconn_user_id(principal["workspace_id"], principal["id"])
    token = await _issue_access_token(settings, nexconn_user_id, principal["name"])
    if settings["channel_type"] == "group":
        await _ensure_group_membership(settings, nexconn_user_id, principal["role"] == "owner")
    return {
        "enabled": True,
        "app_key": settings["app_key"],
        "token": token,
        "user_id": nexconn_user_id,
        "channel": {
            "type": settings["channel_type"],
            "id": settings["channel_id"],
            "subchannel_id": settings["subchannel_id"],
            "name": settings["channel_name"],
        },
        "area_code": settings["area_code"],
    }
