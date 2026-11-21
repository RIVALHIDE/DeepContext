"""Shared upload storage for API/worker deployments.

Set S3_BUCKET plus S3_ENDPOINT_URL/S3 credentials for Neon Object Storage or
any S3-compatible provider. Without them, files stay local for development.
"""
from __future__ import annotations

import contextlib
import os
import shutil
import tempfile
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from database import DATA_DIR


def _bucket() -> str:
    return os.getenv("S3_BUCKET", "").strip()


def is_remote_storage() -> bool:
    return bool(_bucket())


def _client():
    if not is_remote_storage():
        raise RuntimeError("S3_BUCKET is not configured")
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=os.getenv("S3_ENDPOINT_URL") or None,
        region_name=os.getenv("S3_REGION", "auto"),
        aws_access_key_id=os.getenv("S3_ACCESS_KEY_ID") or os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("S3_SECRET_ACCESS_KEY") or os.getenv("AWS_SECRET_ACCESS_KEY"),
    )


def _reference(key: str) -> str:
    return f"s3://{_bucket()}/{quote(key, safe='/')}"


def _key(reference: str) -> str:
    parsed = urlsplit(reference)
    if parsed.scheme != "s3" or parsed.netloc != _bucket():
        raise ValueError("Invalid or foreign object-storage reference")
    return unquote(parsed.path.lstrip("/"))


def store_upload(content: bytes, workspace_id: str, document_id: str, source_name: str, content_type: str = "") -> str:
    safe_name = Path(source_name).name
    if is_remote_storage():
        key = f"uploads/{workspace_id}/{document_id}/{safe_name}"
        extra = {"ContentType": content_type} if content_type else {}
        _client().put_object(Bucket=_bucket(), Key=key, Body=content, **extra)
        return _reference(key)

    directory = DATA_DIR / "uploads" / workspace_id / document_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / safe_name
    path.write_bytes(content)
    return str(path)


def exists(reference: str) -> bool:
    if reference.startswith("s3://"):
        try:
            _client().head_object(Bucket=_bucket(), Key=_key(reference))
            return True
        except Exception:
            return False
    return Path(reference).is_file()


def delete(reference: str) -> None:
    if reference.startswith("s3://"):
        _client().delete_object(Bucket=_bucket(), Key=_key(reference))
        return
    path = Path(reference)
    try:
        path.unlink()
        path.parent.rmdir()
    except FileNotFoundError:
        pass
    except OSError:
        pass


@contextlib.contextmanager
def local_copy(reference: str):
    """Yield a real local path, downloading remote objects for ingestion."""
    if not reference.startswith("s3://"):
        yield reference
        return

    temporary_dir = tempfile.mkdtemp(prefix="deepcontext-ingest-")
    destination = os.path.join(temporary_dir, Path(_key(reference)).name)
    try:
        _client().download_file(_bucket(), _key(reference), destination)
        yield destination
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)
