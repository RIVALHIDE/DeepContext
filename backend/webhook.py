"""
Nexconn webhook integration.

Exposes POST /nexconn-webhook to receive messages from the Nexconn Chat
channel, run them through the LangGraph RAG workflow, and push the verified
answer back to the channel via the Nexconn API.
"""

import os
import json
import httpx
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

from rag_engine import DeepContextEngine
from auth import retrieval_scope, current, require_role

router = APIRouter()

# ── Nexconn API configuration ────────────────────────────────────────────────
NEXCONN_API_BASE_URL = os.getenv("NEXCONN_API_BASE_URL", "")
NEXCONN_API_TOKEN = os.getenv("NEXCONN_API_TOKEN", "")
NEXCONN_WORKSPACE_ID = os.getenv("NEXCONN_WORKSPACE_ID", "")


class NexconnWebhookPayload(BaseModel):
    """Expected payload from a Nexconn channel webhook."""
    message: str
    channel_id: str = ""
    user_id: str = "anonymous"
    team_id: str = "default"
    session_id: str = ""


# Singleton engine instance — set by MainApplicationRunner at startup
_engine: DeepContextEngine | None = None


def set_engine(engine: DeepContextEngine):
    """Wire the shared DeepContextEngine from the main app."""
    global _engine
    _engine = engine


async def _push_to_nexconn(channel_id: str, answer: str, diagrams: list = None):
    """Send the verified answer back to the Nexconn channel."""
    if not NEXCONN_API_BASE_URL or not channel_id:
        print(
            "ℹ️ Nexconn API not configured or no channel_id — "
            "skipping push-back."
        )
        return

    url = f"{NEXCONN_API_BASE_URL}/channels/{channel_id}/messages"
    headers = {
        "Authorization": f"Bearer {NEXCONN_API_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "message": answer,
    }
    if diagrams:
        payload["diagrams"] = diagrams

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                print(
                    f"⚠️ Nexconn push-back failed | status={resp.status_code} "
                    f"| body={resp.text[:200]}"
                )
            else:
                print(f"✅ Nexconn push-back OK | channel={channel_id}")
    except Exception as exc:
        print(f"⚠️ Nexconn push-back error: {exc}")


@router.post("/nexconn-webhook")
async def nexconn_webhook(request: Request):
    """
    Receive a message from the Nexconn Chat channel, run it through the
    LangGraph RAG workflow (retrieval → draft → reflection), and push the
    final verified answer back to the channel.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # Handle Nexconn webhook verification challenge
    if "challenge" in body:
        return {"challenge": body["challenge"]}

    try:
        payload = NexconnWebhookPayload(**body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid payload: {exc}")

    if not payload.message or not payload.message.strip():
        raise HTTPException(status_code=400, detail="Empty message")

    print(
        f"📩 Nexconn webhook | user={payload.user_id} | team={payload.team_id} "
        f"| channel={payload.channel_id} | msg={payload.message[:80]!r}"
    )

    # Run the LangGraph RAG workflow
    if _engine is None:
        raise HTTPException(status_code=503, detail="RAG engine not initialized")
    result = _engine.run_workflow(
        payload.message,
        user_team=retrieval_scope(),
        chat_history=[],  # Webhook messages are stateless for now
    )

    answer = result.get("answer", "")
    diagrams = result.get("diagrams", [])

    # Push the answer back to the Nexconn channel
    # A global API credential must never be usable by an unrelated workspace.
    if NEXCONN_WORKSPACE_ID == current()['workspace_id']:
        require_role('admin')
        await _push_to_nexconn(payload.channel_id, answer, diagrams)

    return {
        "status": "ok",
        "answer": answer,
        "diagrams": diagrams,
        "sources": result.get("sources", []),
        "retrieved": result.get("retrieved", False),
    }
