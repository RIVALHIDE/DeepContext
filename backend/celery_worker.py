from celery import Celery
from celery.signals import worker_ready
from supervisor import Supervisor
from ingest_progress import publish
from chroma_health import log_chroma_config, wait_for_chroma
from database import initDB, DB_PATH
import sqlite3
import requests
import os

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BACKEND_DIR, "data")

app = Celery(
    "deepcontext_worker",
    broker=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
)

app.conf.update(
    task_track_started=True,
    result_expires=3600
)


@worker_ready.connect
def verify_chroma_on_worker_start(sender, **kwargs):
    initDB()
    log_chroma_config()
    wait_for_chroma()
    print("Celery worker database and Chroma connection verified.")

@app.task(name="process_document_task", bind=True)
def process_document_task(self, file_source: str, is_slack_upload: bool = False, slack_token: str = None, team_id: str = "default", access_level: float = 0):
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
        file_to_process = file_source
        file_name = os.path.basename(file_to_process)
        publish(
            job_id,
            "uploaded",
            "File received, starting ingestion",
            file_name=file_name,
        )

    try:
        supervisor = Supervisor()
        supervisor.supervisor(file_to_process, job_id=job_id, team_id=team_id, access_level=access_level)
        with sqlite3.connect(DB_PATH) as database:
            database.execute('INSERT OR REPLACE INTO document_access VALUES (?, ?, ?)',
                             (os.path.basename(file_to_process).casefold(), team_id, access_level))
        publish(job_id, "completed", "Ingestion complete", file_name=os.path.basename(file_to_process))
        return "Ingestion Complete"
    except Exception as exc:
        publish(
            job_id,
            "failed",
            str(exc),
            file_name=os.path.basename(file_to_process),
        )
        raise
