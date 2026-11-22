from concurrent.futures import ThreadPoolExecutor
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import uuid

from celery import Celery
from celery.signals import worker_ready
from supervisor import Supervisor
from ingest_progress import publish
from chroma_health import log_chroma_config, wait_for_chroma
from database import connect, initDB, run_with_db_retry
from object_storage import delete as delete_staged_file, local_copy
from acl_security import normalize_acl_entries
import requests

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BACKEND_DIR, "data")

def _redis_url():
    """Upstash uses TLS; Celery requires an explicit certificate policy."""
    value = os.getenv("REDIS_URL", "redis://localhost:6379/0").strip()
    if value.startswith("rediss://"):
        parsed = urlsplit(value)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query.setdefault("ssl_cert_reqs", "required")
        value = urlunsplit(parsed._replace(query=urlencode(query)))
    return value


REDIS_URL = _redis_url()


app = Celery(
    "deepcontext_worker",
    broker=REDIS_URL,
    backend=REDIS_URL,
)

app.conf.update(
    task_track_started=True,
    result_expires=3600,
    task_always_eager=os.getenv("CELERY_TASK_ALWAYS_EAGER", "false").lower() == "true",
    task_store_eager_result=True,
    task_eager_propagates=False,
)

# Render's free plan cannot run a separate worker service. In eager mode we
# therefore use one in-process worker thread so uploads return immediately and
# memory-heavy extraction jobs cannot overlap. Paid/non-eager deployments keep
# using the normal Redis/Celery queue.
_EAGER_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ingest")


def enqueue_document_task(
    file_source: str,
    is_slack_upload: bool = False,
    slack_token: str | None = None,
    team_id: str = "default",
    access_level: float = 0,
    uploader_id: str = "",
    uploader_name: str = "",
    uploader_team: str = "",
    acl_entries=None,
) -> str:
    task_id = str(uuid.uuid4())
    kwargs = {
        "file_source": file_source,
        "is_slack_upload": is_slack_upload,
        "slack_token": slack_token,
        "team_id": team_id,
        "access_level": access_level,
        "uploader_id": uploader_id,
        "uploader_name": uploader_name,
        "uploader_team": uploader_team,
        "acl_entries": normalize_acl_entries(acl_entries),
    }
    if app.conf.task_always_eager:
        _EAGER_EXECUTOR.submit(
            process_document_task.apply_async,
            kwargs=kwargs,
            task_id=task_id,
        )
    else:
        process_document_task.apply_async(kwargs=kwargs, task_id=task_id)
    return task_id


@worker_ready.connect
def verify_chroma_on_worker_start(sender, **kwargs):
    initDB()
    log_chroma_config()
    wait_for_chroma()
    print("Celery worker database and Chroma connection verified.")

@app.task(name="process_document_task", bind=True)
def process_document_task(
    self,
    file_source: str,
    is_slack_upload: bool = False,
    slack_token: str = None,
    team_id: str = "default",
    access_level: float = 0,
    uploader_id: str = "",
    uploader_name: str = "",
    uploader_team: str = "",
    acl_entries=None,
):
    job_id = self.request.id
    os.makedirs(DATA_DIR, exist_ok=True)

    if is_slack_upload:
        file_name = file_source.split('/')[-1]
        local_path = os.path.join(DATA_DIR, f"slack_{file_name}")

        publish(
            job_id,
            "uploaded",
            "Slack file received, downloading",
            file_name=file_name,
        )

        headers = {"Authorization": f"Bearer {slack_token}"}
        response = requests.get(file_source, headers=headers, stream=True)

        if response.status_code == 200:
            with open(local_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            file_to_process = local_path
        else:
            print(f"❌ Failed to download from Slack. Status: {response.status_code}")
            publish(
                job_id,
                "failed",
                f"Failed to download from Slack (HTTP {response.status_code})",
                file_name=file_name,
            )
            return "Download Failed"
    else:
        file_name = os.path.basename(file_source)
        publish(
            job_id,
            "uploaded",
            "File received, starting ingestion",
            file_name=file_name,
        )

    try:
        context = local_copy(file_to_process) if is_slack_upload else local_copy(file_source)
        with context as local_file:
            supervisor = Supervisor()
            supervisor.supervisor(
                local_file,
                job_id=job_id,
                team_id=team_id,
                access_level=access_level,
                uploader_id=uploader_id,
                uploader_name=uploader_name,
                uploader_team=uploader_team,
                acl_entries=acl_entries,
            )
            def finalize_document_access():
                with connect() as database:
                    database.execute(
                        '''INSERT INTO document_access(source_name, workspace_id, access_level)
                           VALUES (?, ?, ?)
                           ON CONFLICT(workspace_id, source_name)
                           DO UPDATE SET access_level=excluded.access_level''',
                        (os.path.basename(local_file).casefold(), team_id, access_level),
                    )

            run_with_db_retry(
                finalize_document_access,
                operation_name="document access finalization",
            )
            publish(job_id, "completed", "Ingestion complete", file_name=os.path.basename(local_file))
            if not is_slack_upload:
                delete_staged_file(file_source)
            return "Ingestion Complete"
    except Exception as exc:
        publish(job_id, "failed", str(exc), file_name=file_name)
        raise
