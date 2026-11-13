import json
import os
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import redis
import redis.asyncio as aioredis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
LATEST_TTL_SECONDS = 3600
TERMINAL_STAGES = frozenset({"completed", "failed"})


def _channel(job_id: str) -> str:
    return f"ingest:progress:{job_id}"


def _latest_key(job_id: str) -> str:
    return f"ingest:progress:{job_id}:latest"


def _redis_client() -> redis.Redis:
    return redis.Redis.from_url(REDIS_URL, decode_responses=True)


def publish(
    job_id: str,
    stage: str,
    message: str | None = None,
    **meta: Any,
) -> dict:
    if not job_id:
        return {}

    event = {
        "job_id": job_id,
        "stage": stage,
        "message": message or "",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "meta": meta,
    }
    payload = json.dumps(event)
    client = _redis_client()
    try:
        client.publish(_channel(job_id), payload)
        client.setex(_latest_key(job_id), LATEST_TTL_SECONDS, payload)
    finally:
        client.close()
    return event


def get_latest(job_id: str) -> dict | None:
    client = _redis_client()
    try:
        raw = client.get(_latest_key(job_id))
        return json.loads(raw) if raw else None
    finally:
        client.close()


async def subscribe(job_id: str) -> AsyncIterator[dict]:
    seen_payload: str | None = None
    latest = get_latest(job_id)
    if latest:
        seen_payload = json.dumps(latest, sort_keys=True)
        yield latest
        if latest.get("stage") in TERMINAL_STAGES:
            return

    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    pubsub = client.pubsub()
    await pubsub.subscribe(_channel(job_id))

    gap_latest = get_latest(job_id)
    if gap_latest:
        gap_payload = json.dumps(gap_latest, sort_keys=True)
        if gap_payload != seen_payload:
            yield gap_latest
            seen_payload = gap_payload
            if gap_latest.get("stage") in TERMINAL_STAGES:
                await pubsub.unsubscribe(_channel(job_id))
                await pubsub.aclose()
                await client.aclose()
                return

    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            event = json.loads(message["data"])
            yield event
            if event.get("stage") in TERMINAL_STAGES:
                break
    finally:
        await pubsub.unsubscribe(_channel(job_id))
        await pubsub.aclose()
        await client.aclose()
