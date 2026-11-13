import os
import time
from typing import Any, Callable

import chromadb
from chromadb.config import Settings

DEFAULT_COLLECTION_NAME = "deepcontext_v2"
DEFAULT_HOST = "localhost"
DEFAULT_PORT = 8001
DEFAULT_SSL = False
DEFAULT_STARTUP_RETRIES = 30
DEFAULT_STARTUP_RETRY_DELAY = 2.0


def get_chroma_settings() -> dict[str, Any]:
    return {
        "host": os.getenv("CHROMA_HOST", DEFAULT_HOST),
        "port": int(os.getenv("CHROMA_PORT", str(DEFAULT_PORT))),
        "ssl": os.getenv("CHROMA_SSL", "false").lower() == "true",
        "collection_name": os.getenv("CHROMA_COLLECTION_NAME", DEFAULT_COLLECTION_NAME),
        "max_retries": int(os.getenv("CHROMA_STARTUP_RETRIES", str(DEFAULT_STARTUP_RETRIES))),
        "retry_delay": float(os.getenv("CHROMA_STARTUP_RETRY_DELAY", str(DEFAULT_STARTUP_RETRY_DELAY))),
    }


def chroma_endpoint(settings: dict[str, Any] | None = None) -> str:
    cfg = settings or get_chroma_settings()
    scheme = "https" if cfg["ssl"] else "http"
    return f"{scheme}://{cfg['host']}:{cfg['port']}"


def log_chroma_config(log_fn: Callable[[str], None] = print) -> dict[str, Any]:
    cfg = get_chroma_settings()
    log_fn(
        "Chroma config | "
        f"endpoint={chroma_endpoint(cfg)} | "
        f"collection={cfg['collection_name']} | "
        f"retries={cfg['max_retries']} | "
        f"retry_delay={cfg['retry_delay']}s"
    )
    return cfg


def build_chroma_client(
    host: str | None = None,
    port: int | None = None,
    ssl: bool | None = None,
):
    cfg = get_chroma_settings()
    return chromadb.HttpClient(
        host=host if host is not None else cfg["host"],
        port=port if port is not None else cfg["port"],
        ssl=ssl if ssl is not None else cfg["ssl"],
        settings=Settings(
            anonymized_telemetry=False,
            chroma_product_telemetry_impl="rag_engine.NoOpProductTelemetry",
            chroma_telemetry_impl="rag_engine.NoOpProductTelemetry",
        ),
    )


def ensure_collection(client, collection_name: str | None = None) -> str:
    name = collection_name or get_chroma_settings()["collection_name"]
    client.get_or_create_collection(name=name)
    return name


def wait_for_chroma(
    settings: dict[str, Any] | None = None,
    *,
    log_fn: Callable[[str], None] = print,
) -> dict[str, Any]:
    cfg = settings or get_chroma_settings()
    last_error: Exception | None = None

    for attempt in range(1, cfg["max_retries"] + 1):
        try:
            client = build_chroma_client(cfg["host"], cfg["port"], cfg["ssl"])
            heartbeat = client.heartbeat()
            collection_name = ensure_collection(client, cfg["collection_name"])
            log_fn(
                f"Chroma ready | endpoint={chroma_endpoint(cfg)} | "
                f"collection={collection_name} | heartbeat={heartbeat}"
            )
            return {
                "status": "healthy",
                "endpoint": chroma_endpoint(cfg),
                "collection_name": collection_name,
                "heartbeat": heartbeat,
            }
        except Exception as exc:
            last_error = exc
            if attempt < cfg["max_retries"]:
                log_fn(
                    f"Chroma not ready ({attempt}/{cfg['max_retries']}) at "
                    f"{chroma_endpoint(cfg)}: {exc}. Retrying in {cfg['retry_delay']}s..."
                )
                time.sleep(cfg["retry_delay"])
            else:
                break

    raise RuntimeError(
        f"Chroma HTTP server unavailable at {chroma_endpoint(cfg)} "
        f"(collection={cfg['collection_name']}). Last error: {last_error}"
    ) from last_error


def check_chroma_health(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = settings or get_chroma_settings()
    try:
        client = build_chroma_client(cfg["host"], cfg["port"], cfg["ssl"])
        heartbeat = client.heartbeat()
        collection_name = ensure_collection(client, cfg["collection_name"])
        collection = client.get_collection(name=collection_name)
        count = collection.count()
        return {
            "status": "healthy",
            "endpoint": chroma_endpoint(cfg),
            "collection_name": collection_name,
            "document_count": count,
            "heartbeat": heartbeat,
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "endpoint": chroma_endpoint(cfg),
            "collection_name": cfg["collection_name"],
            "error": str(exc),
        }
