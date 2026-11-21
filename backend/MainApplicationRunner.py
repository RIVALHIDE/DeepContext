from datetime import datetime
import json
import os
import requests
import asyncio
import uuid
import re
import logging
from fastapi import Request
from fastapi.responses import StreamingResponse

from celery_worker import enqueue_document_task
from celery.result import AsyncResult
from chat_history_manager import ChatHistroyManager
from chat_session_manager import ChatSessionManager
from database import initDB
from fastapi import FastAPI,File,UploadFile,HTTPException,Form,Response
from fastapi.middleware.cors import CORSMiddleware
from auth import (install_auth, current, require_role, session_owner, retrieval_scope, retrieval_filter,
                  connect as auth_connect, ROLES)
from office_loader import OFFICE_EXTENSIONS
from access_policy import query_clearance
from pydantic import BaseModel, Field

from ingest_progress import get_latest, subscribe
from chroma_health import check_chroma_health, log_chroma_config
from document_registry import (
    delete_chunks_for_source,
    delete_document_record,
    list_documents,
    migrate_legacy_duplicate_chunks,
    create_pending_upload,
    get_pending_upload,
    list_pending_uploads,
    approve_pending_upload,
    reject_pending_upload,
)
from object_storage import delete as delete_staged_file, exists as staged_file_exists, store_upload
from rag_engine import DeepContextEngine, _normalize_markdown_answer
from webhook import router as nexconn_router
from workspace_leaderboard import (
    award_approved_upload,
    award_cited_sources,
    get_workspace_leaderboard,
    upload_contributor,
)
from backfill_acl_entries import run as backfill_acl_entries
from acl_security import (
    DEFAULT_ACL,
    acl_display_role,
    can_access_acl,
    document_acl,
    effective_acl_scope,
    minimum_role_acl,
    normalize_acl_entries,
    record_retrieval_audit,
    sync_vector_acl,
)


SLACK_BOT_TOKEN=os.getenv("SLACK_BOT_TOKEN")
logger = logging.getLogger(__name__)

# ── Upload validation constants ─────────────────────────────────────────────
MAX_FILE_SIZE = 15 * 1024 * 1024  # 15 MB

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "text/xml",
    "application/json",
    "application/xml",
    "application/x-yaml",
    "text/yaml",
    "application/octet-stream",  # .puml, .mmd, .mermaid may report this
}

ALLOWED_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg",
    ".txt", ".md", ".puml", ".mmd", ".mermaid",
    ".csv", ".json", ".jsonl", ".yaml", ".yml",
    ".xml", ".html", ".htm", ".log", ".rst",
}
ALLOWED_EXTENSIONS.update(OFFICE_EXTENSIONS)

app = FastAPI(title="DeepContext API")


origin = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://10.121.162.97:5173",
    *(value.strip() for value in os.getenv("AUTH_ALLOWED_ORIGINS", "").split(",") if value.strip()),
]

initDB()
install_auth(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origin,            # Allows requests from your React app
    allow_origin_regex=(r"^https?://[^/]+:5173$" if os.getenv("APP_ENV", "development") != "production" else None),
    allow_credentials=True,           # Allows cookies/auth headers
    allow_methods=["*"],              # Allows all methods (GET, POST, etc.)
    allow_headers=["*"],              # Allows all headers
)



# ── Nexconn webhook router ─────────────────────────────────────────────────
app.include_router(nexconn_router)

engine = DeepContextEngine()
history_manager = ChatHistroyManager()
session_manager = ChatSessionManager()

class UserRequest(BaseModel):
    question:str
    sessionId:str
    userTeam:str = "default"
    selectedSources: list[str] = Field(default_factory=list, max_length=10)
    replaceHumanTurn: int | None = Field(default=None, ge=0)


UNAVAILABLE_SOURCE_SENTINEL = "__no_permitted_selected_source__"


def _validate_acl_references(entries: list[str], actor: dict) -> list[str]:
    """Validate user/group/role ACL targets inside the active workspace."""
    user_ids = [token.split(':', 1)[1] for token in entries if token.startswith('user:')]
    group_ids = [token.split(':', 1)[1] for token in entries if token.startswith('group:')]
    role_ids = [token.split(':', 1)[1] for token in entries if token.startswith('role:')]
    if any(role not in {*ROLES, 'curator'} for role in role_ids):
        raise HTTPException(422, 'ACL contains an unknown workspace role')
    with auth_connect() as database:
        valid_users = {
            row['user_id'] for row in database.execute(
                'SELECT user_id FROM memberships WHERE workspace_id=?',
                (actor['workspace_id'],),
            )
        }
        valid_groups = {
            row['id'] for row in database.execute(
                'SELECT id FROM workspace_groups WHERE workspace_id=?',
                (actor['workspace_id'],),
            )
        }
    if not set(user_ids).issubset(valid_users) or not set(group_ids).issubset(valid_groups):
        raise HTTPException(422, 'ACL references a user or group outside this workspace')
    return entries


def _upload_acl(access_role: str, raw_acl: str, actor: dict) -> tuple[list[str], str]:
    """Resolve upload permissions without trusting client identity claims."""
    if str(raw_acl or '').strip():
        if ROLES[actor['role']] < ROLES['editor']:
            raise HTTPException(403, 'Editor access is required to assign custom ACL entries')
        try:
            entries = normalize_acl_entries(raw_acl)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return _validate_acl_references(entries, actor), access_role or 'admin'
    if access_role:
        if access_role not in ROLES or ROLES[access_role] > ROLES[actor['role']]:
            raise HTTPException(403, 'You cannot grant document access above your own role')
        return minimum_role_acl(access_role), access_role
    return list(DEFAULT_ACL), 'admin'


def _apply_chat_branch(request: UserRequest):
    """Make edits and retries replace an existing turn instead of duplicating it."""
    if request.replaceHumanTurn is not None:
        history_manager.truncate_from_human_turn(
            request.sessionId,
            request.replaceHumanTurn,
        )


def _validated_selected_sources(requested_sources: list[str], actor: dict) -> list[str]:
    """Resolve explicitly selected files against the caller's RBAC scope."""
    requested = list(dict.fromkeys(
        str(source).strip().casefold()
        for source in (requested_sources or [])
        if str(source).strip()
    ))
    if not requested:
        return []

    scope = effective_acl_scope(actor)
    permitted = {
        str(record['source_name']).casefold(): str(record['source_name'])
        for record in list_documents(actor['workspace_id'])
        if can_access_acl(scope, record.get('acl_entries'))
    }
    unavailable = [source for source in requested if source not in permitted]
    if unavailable:
        # Do not disclose whether a named document exists but is restricted.
        return [UNAVAILABLE_SOURCE_SENTINEL]
    return [permitted[source] for source in requested]


def _retrieval_question(question: str, selected_sources: list[str]) -> str:
    if not selected_sources:
        return question
    cleaned = re.sub(r'@\[[^\]]+\]', ' ', str(question or ''))
    cleaned = ' '.join(cleaned.split())
    return cleaned or 'Summarize the selected documents.'


class ChatSessionCreateRequest(BaseModel):
    sessionId: str
    title: str = "New Chat"


class ChatSessionUpdateRequest(BaseModel):
    title: str | None = None
    lastMessageAt: str | None = None
    lastMessagePreview: str | None = None
    

    
@app.post("/")
def run_server():
    return "DeepContext is working properly."


@app.on_event("startup")
def bootstrap_app():
    initDB()
    log_chroma_config()
    chroma_status = check_chroma_health()
    if chroma_status.get("status") != "healthy":
        raise RuntimeError(
            f"Chroma health check failed: {chroma_status.get('error', 'unknown error')}"
        )
    print(
        f"Chroma bootstrap OK | collection={chroma_status.get('collection_name')} | "
        f"documents={chroma_status.get('document_count', 0)}"
    )
    if os.getenv('ACL_AUTO_BACKFILL', 'true').strip().lower() in {'1', 'true', 'yes'}:
        acl_backfill = backfill_acl_entries(
            apply=True, vector_db=engine.get_vector_db(refresh=True),
        )
        print(
            "ACL metadata backfill OK | "
            f"documents={acl_backfill['documents_updated']} | "
            f"chunks={acl_backfill['chunks_updated']} | "
            f"admin_defaults={acl_backfill['defaults_to_admin']}"
        )
    migration = migrate_legacy_duplicate_chunks(engine.get_vector_db(refresh=True))
    if migration["stale_chunks_deleted"] or migration["documents_processed"]:
        print(
            "Document versioning migration | "
            f"documents_processed={migration['documents_processed']} | "
            f"stale_chunks_deleted={migration['stale_chunks_deleted']}"
        )


@app.get("/health")
def health_check():
    chroma = check_chroma_health()
    healthy = chroma.get("status") == "healthy"
    return {
        "status": "healthy" if healthy else "degraded",
        "services": {
            "api": "healthy",
            # This endpoint is intentionally unauthenticated for Render health
            # checks. Never expose document counts, collection names, errors,
            # or connection details here: they can reveal restricted data or
            # infrastructure to anonymous callers.
            "vector_store": "healthy" if healthy else "degraded",
        },
    }


@app.get("/health/chroma")
def chroma_health_check():
    chroma = check_chroma_health()
    return {"status": "healthy" if chroma.get("status") == "healthy" else "degraded"}

@app.post("/upload")
async def upload_docs(
    file: UploadFile = File(...),
    access_role: str = Form(""),
    acl_entries: str = Form(""),
):
    """
    Hardened upload endpoint.

    Validates file size (15 MB max) and MIME type, saves the file to disk,
    and registers it in the upload audit table. Member uploads wait for approval;
    editor, admin, and owner uploads start ingestion immediately.
    """

    actor = require_role('member')
    document_acl_entries, compatibility_role = _upload_acl(access_role, acl_entries, actor)
    # ── File size validation ──
    content = await file.read()
    file_size = len(content)
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File size {file_size} bytes exceeds the 15 MB limit.",
        )

    # ── MIME type validation ──
    mime_type = file.content_type or ""
    ext = os.path.splitext(file.filename or "")[1].lower()

    # Extension allowlisting is authoritative. Browsers often report valid
    # Office/diagram files as application/octet-stream, so MIME is advisory;
    # an unknown binary extension must never bypass validation via that MIME.
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type: mime={mime_type}, ext={ext}. "
                   f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # ── Save to shared object storage (or local disk in development) ──
    safe_name = os.path.basename((file.filename or '').replace('\\', '/'))
    if not safe_name or safe_name in ('.', '..'):
        raise HTTPException(422, 'A valid filename is required')
    source_name = f"{actor['workspace_id']}__{safe_name}"
    document_id = str(uuid.uuid4())
    try:
        file_path = store_upload(
            content, actor['workspace_id'], document_id, source_name, mime_type or ext
        )
    except Exception as exc:
        logger.exception("Object storage rejected upload for workspace %s", actor['workspace_id'])
        raise HTTPException(
            503,
            "Upload storage is unavailable. Check the Render S3_* environment variables.",
        ) from exc

    # ── Register the upload before either approval or immediate ingestion ──
    try:
        create_pending_upload(
            document_id=document_id,
            source_name=source_name,
            file_path=file_path,
            file_size=file_size,
            mime_type=mime_type or ext,
            uploaded_by=actor["id"],
            team_id=actor["workspace_id"],
            acl_entries=document_acl_entries,
        )
    except Exception:
        delete_staged_file(file_path)
        raise

    with auth_connect() as db:
        db.execute('UPDATE pending_uploads SET access_level=? WHERE document_id=?',
                   (ROLES[compatibility_role], document_id))

    if ROLES[actor['role']] >= ROLES['editor']:
        job_id = enqueue_document_task(
            file_path,
            team_id=actor['workspace_id'],
            access_level=ROLES[compatibility_role],
            uploader_id=actor['id'],
            uploader_name=actor['name'],
            uploader_team=actor['workspace_name'],
            acl_entries=document_acl_entries,
        )
        if approve_pending_upload(document_id, approved_by=actor['id'], job_id=job_id):
            award_approved_upload(get_pending_upload(document_id))
        return {
            "message": "Upload successful. Ingestion started.",
            "document_id": document_id,
            "job_id": job_id,
            "status": "processing",
            "file_name": file.filename,
            "file_size": file_size,
            "access_role": compatibility_role,
        }

    return {
        "message": "Upload successful. Document is pending approval before ingestion.",
        "document_id": document_id,
        "status": "pending_approval",
        "file_name": file.filename,
        "file_size": file_size,
        "access_role": compatibility_role,
    }


@app.post("/nexconn/share-file", status_code=201)
async def stage_nexconn_shared_file(file: UploadFile = File(...)):
    """Stage a chat attachment for optional editor-approved ingestion.

    Every workspace role may share a file in Nexconn, but this endpoint only
    creates a pending proposal. It never writes to Chroma or grants the sender
    upload privileges; an editor, admin, or owner must approve it separately.
    """
    actor = current()
    content = await file.read(MAX_FILE_SIZE + 1)
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(413, "Shared knowledge files are limited to 15 MB each")

    safe_name = os.path.basename((file.filename or '').replace('\\', '/'))
    extension = os.path.splitext(safe_name)[1].lower()
    if not safe_name or safe_name in ('.', '..'):
        raise HTTPException(422, 'A valid filename is required')
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, 'This attachment can be shared in chat but its format cannot be added to the knowledge base')

    document_id = str(uuid.uuid4())
    source_name = f"{actor['workspace_id']}__{safe_name}"
    try:
        file_path = store_upload(
            content, actor['workspace_id'], document_id, source_name,
            file.content_type or extension,
        )
    except Exception as exc:
        logger.exception("Object storage rejected Nexconn share for workspace %s", actor['workspace_id'])
        raise HTTPException(
            503,
            "Attachment storage is unavailable. Check the Render S3_* environment variables.",
        ) from exc

    try:
        create_pending_upload(
            document_id=document_id,
            source_name=source_name,
            file_path=file_path,
            file_size=len(content),
            mime_type=file.content_type or extension,
            uploaded_by=actor['id'],
            team_id=actor['workspace_id'],
            acl_entries=DEFAULT_ACL,
        )
    except Exception:
        delete_staged_file(file_path)
        raise
    with auth_connect() as database:
        database.execute(
            'UPDATE pending_uploads SET access_level=? WHERE document_id=?',
            (ROLES['admin'], document_id),
        )
    return {
        'document_id': document_id,
        'file_name': safe_name,
        'status': 'pending_approval',
        'message': 'File shared. An editor can add it to the workspace.',
    }


@app.delete("/nexconn/share-file/{document_id}")
def discard_failed_nexconn_share(document_id: str):
    """Remove staging when Nexconn rejects the corresponding attachment."""
    actor = current()
    with auth_connect() as database:
        record = database.execute(
            """SELECT file_path FROM pending_uploads
               WHERE document_id=? AND team_id=? AND uploaded_by=? AND status='pending_approval'""",
            (document_id, actor['workspace_id'], actor['id']),
        ).fetchone()
        if not record:
            raise HTTPException(404, 'Shared file proposal not found')
        database.execute(
            "UPDATE pending_uploads SET status='rejected' WHERE document_id=?",
            (document_id,),
        )
    delete_staged_file(record['file_path'])
    return {'message': 'Unsent shared file removed'}


@app.get("/pending-documents")
def get_pending_documents():
    """List all documents awaiting approval."""
    actor = current()
    pending = [record for record in list_pending_uploads()
               if record.get('team_id') == actor['workspace_id']
               and (ROLES[actor['role']] >= ROLES['editor'] or record.get('uploaded_by') == actor['id'])]
    for record in pending:
        record['display_name'] = record['source_name'].split('__', 1)[-1]
        record['access_role'] = next(role for role, value in ROLES.items() if value == record.get('access_level', 0))
    return {
        "message": "Success" if pending else "No pending documents",
        "documents": pending,
    }


@app.post("/approve-document/{document_id}")
def approve_document(document_id: str):
    """
    Approve a pending document and trigger ChromaDB ingestion via Celery.
    """
    actor = require_role('editor')
    record = get_pending_upload(document_id)
    if not record or record.get('team_id') != actor['workspace_id']:
        raise HTTPException(status_code=404, detail=f"Pending document not found: {document_id}")
    if record.get("status") != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Document is not pending (status={record.get('status')})")

    file_path = record.get("file_path")
    if not file_path or not staged_file_exists(file_path):
        raise HTTPException(status_code=404, detail="The staged upload could not be found in object storage.")

    team_id = record.get("team_id", "default")
    contributor = upload_contributor(record) or {}
    job_id = enqueue_document_task(
        file_path,
        team_id=team_id,
        access_level=record.get('access_level', 0),
        uploader_id=contributor.get('user_id', ''),
        uploader_name=contributor.get('user_name', ''),
        uploader_team=contributor.get('team_name', ''),
        acl_entries=record.get('acl_entries'),
    )
    if approve_pending_upload(document_id, approved_by=actor['id'], job_id=job_id):
        award_approved_upload(record)

    return {
        "message": "Document approved. Ingestion started in background.",
        "document_id": document_id,
        "job_id": job_id,
    }


@app.post("/reject-document/{document_id}")
def reject_document(document_id: str):
    """Reject a pending document and remove it from the queue."""
    actor = require_role('editor')
    record = get_pending_upload(document_id)
    if not record or record.get('team_id') != actor['workspace_id']:
        raise HTTPException(404, 'Pending document not found')
    rejected = reject_pending_upload(document_id)
    if not rejected:
        raise HTTPException(status_code=404, detail=f"Pending document not found: {document_id}")

    delete_staged_file(record['file_path'])
    return {
        "message": "Document rejected.",
        "document_id": document_id,
    }
    

def authorize_job(job_id):
    actor = current()
    with auth_connect() as db:
        row = db.execute('SELECT * FROM pending_uploads WHERE job_id=? AND team_id=?', (job_id, actor['workspace_id'])).fetchone()
    if not row or (
        row['uploaded_by'] != actor['id'] and ROLES[actor['role']] < ROLES['editor']
    ):
        raise HTTPException(404, 'Job not found')


@app.get("/job-status/{job_id}")
async def get_job_status(job_id: str):
    authorize_job(job_id)
    
    from celery_worker import app as celery_app
    result = AsyncResult(job_id,app=celery_app)
    
    if result.state == "SUCCESS":
        status = "completed"
    elif result.state == "FAILURE":
        status = "failed"   
    else:
        status = "processing"

    latest = get_latest(job_id)

    return {
        "job_id": job_id,
        "status": status,
        "stage": latest.get("stage") if latest else None,
        "message": latest.get("message") if latest else None,
        "result": result.result if result.state == "SUCCESS" else None
    }


@app.get("/job-progress/{job_id}")
async def job_progress_stream(job_id: str):
    authorize_job(job_id)
    async def event_stream():
        async for event in subscribe(job_id):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
 
@app.get("/retriveAllDocuments")
def getAllDocuments():
    actor = current()
    scope = effective_acl_scope(actor)
    records = [
        record for record in list_documents(actor['workspace_id'])
        if can_access_acl(scope, record.get('acl_entries'))
    ]
    return {'message': 'Success', 'files': [
        {'name': record['source_name'], 'displayName': record['source_name'].split('__', 1)[-1],
         'status': record['status'], 'time': record['ingested_at'], 'version': record['current_version'],
         'chunkCount': len(record.get('chunk_ids') or []),
         'accessRole': acl_display_role(record.get('acl_entries')), 'aclEntries': record.get('acl_entries', [])}
        for record in records]}


@app.delete("/deleteDocument/{sourceName}")
def deleteDocument(sourceName: str):
    actor = require_role('editor')
    record = next((item for item in list_documents(actor['workspace_id'])
                   if item['source_name'] == sourceName.casefold()), None)
    if not record or not can_access_acl(effective_acl_scope(actor), record.get('acl_entries')):
        raise HTTPException(404, 'Document not found')
    try:
        vector_db = engine.get_vector_db(refresh=True)
        deleted_count = delete_chunks_for_source(vector_db, sourceName, actor['workspace_id'])
        registry_deleted = delete_document_record(sourceName, actor['workspace_id'])

        if deleted_count == 0 and not registry_deleted:
            raise HTTPException(status_code=404, detail=f"Document not found: {sourceName}")

        engine._try_persist()
        
        return {
            "message":"Document deleted successfully.",
            "sourceName":sourceName,
            "deletedCount": deleted_count,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete document: {str(e)}")
        
        


class DocumentAccessUpdate(BaseModel):
    access_role: str | None = None
    acl_entries: list[str] | None = None


@app.patch('/documents/{sourceName}/access')
def update_document_access(sourceName: str, payload: DocumentAccessUpdate):
    actor = require_role('editor')
    record = next((item for item in list_documents(actor['workspace_id'])
                   if item['source_name'] == sourceName.casefold()), None)
    if not record or not can_access_acl(effective_acl_scope(actor), record.get('acl_entries')):
        raise HTTPException(404, 'Document not found')
    if payload.acl_entries is not None:
        try:
            entries = normalize_acl_entries(payload.acl_entries)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        entries = _validate_acl_references(entries, actor)
    elif payload.access_role:
        if payload.access_role not in ROLES or ROLES[payload.access_role] > ROLES[actor['role']]:
            raise HTTPException(403, 'Cannot assign this access level')
        entries = minimum_role_acl(payload.access_role)
    else:
        entries = list(DEFAULT_ACL)
    vector_db = engine.get_vector_db(refresh=True)
    updated_chunks = sync_vector_acl(
        vector_db, actor['workspace_id'], record['document_id'], entries,
    )
    if payload.access_role:
        with auth_connect() as db:
            db.execute('UPDATE document_access SET access_level=? WHERE source_name=? AND workspace_id=?',
                       (ROLES[payload.access_role], sourceName.casefold(), actor['workspace_id']))
    return {'message': 'Document access updated', 'acl_entries': entries, 'updated_chunks': updated_chunks}


def visible_history(session_id):
    actor = current()
    scope = effective_acl_scope(actor)
    permitted = {
        record['source_name'] for record in list_documents(actor['workspace_id'])
        if can_access_acl(scope, record.get('acl_entries'))
    }
    history = history_manager.get_history(session_id)
    visible = []
    for message in history:
        if message.get('role') != 'ai':
            visible.append(message)
            continue
        sources = message.get('sources') or []
        # Legacy AI turns without provenance cannot be proven safe after a
        # permission change, so they fail closed and are not sent to the LLM.
        if message.get('retrieval_grounded') == 0:
            visible.append(message)
        elif sources and all(
            str(source.get('sourceName', '')).casefold() in permitted
            for source in sources
        ):
            visible.append(message)
    return visible


@app.get("/api/workspaces/{workspace_id}/leaderboard")
def workspace_leaderboard(workspace_id: str, response: Response):
    actor = current()
    if workspace_id != actor['workspace_id']:
        raise HTTPException(403, 'Switch to this workspace before viewing its leaderboard')
    response.headers['Cache-Control'] = 'private, no-store'
    return {
        'workspace_id': workspace_id,
        'leaders': get_workspace_leaderboard(workspace_id, limit=10),
    }


def authorize_session(session_id, allow_new=False):
    if not session_id or len(session_id) > 240:
        raise HTTPException(422, 'Invalid chat session ID')
    prefix = f'session_{session_owner()}'
    if session_id != prefix and not session_id.startswith(prefix + '_'):
        raise HTTPException(404, 'Chat session not found')
    with auth_connect() as db:
        if allow_new:
            db.execute('INSERT OR IGNORE INTO chat_sessions (session_id, username, title) VALUES (?, ?, ?)',
                       (session_id, session_owner(), 'New Chat'))
        existing = db.execute('SELECT username FROM chat_sessions WHERE session_id=?', (session_id,)).fetchone()
    if existing and existing['username'] != session_owner():
        raise HTTPException(404, 'Chat session not found')
    if not existing and not allow_new:
        raise HTTPException(404, 'Chat session not found')


@app.get("/chat-sessions")
def get_chat_sessions():
    return {
        "message": "Success",
        "sessions": session_manager.list_sessions(session_owner())
    }


@app.post("/chat-sessions")
def create_chat_session(payload: ChatSessionCreateRequest):
    authorize_session(payload.sessionId, allow_new=True)
    session = session_manager.update_session(
        session_owner(),
        payload.sessionId,
        title=payload.title or "New Chat",
    )
    return {
        "message": "Chat session created successfully.",
        "session": session
    }


@app.patch("/chat-sessions/{sessionId}")
def update_chat_session(sessionId: str, payload: ChatSessionUpdateRequest):
    authorize_session(sessionId)
    session = session_manager.update_session(
        session_owner(),
        sessionId,
        title=payload.title,
        last_message_at=payload.lastMessageAt,
        last_message_preview=payload.lastMessagePreview,
    )
    return {
        "message": "Chat session updated successfully.",
        "session": session
    }


# ─── AFTER ───────────────────────────────────────────────────────────────────
_SAVE_SKIP_PHRASES = [
    "i don't know", "i do not know", "no information",
    "not available", "no relevant", "cannot find",
    "not mentioned", "not provided", "no details",
    "couldn't find any relevant"
]


def _build_sse_event(event_type: str, payload: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _should_skip_ai_save(answer_text: str, was_retrieved: bool) -> bool:
    answer_lower = str(answer_text or "").lower().strip()
    is_bad_answer = any(phrase in answer_lower for phrase in _SAVE_SKIP_PHRASES)
    return bool(is_bad_answer and was_retrieved)


def _save_ai_response(session_id: str, answer_text: str, diagrams: list, was_retrieved: bool, sources: list = None):
    if _should_skip_ai_save(answer_text, was_retrieved):
        print("⚠️ Skipping history save — model returned weak answer despite retrieved docs.")
        return False

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    history_manager.save_messages(
        session_id,
        "ai",
        answer_text,
        diagrams=diagrams,
        sources=sources,
        retrieval_grounded=was_retrieved,
    )
    session_manager.update_session(
        session_owner(),
        session_id,
        last_message_at=now,
        last_message_preview=answer_text or ("Diagram response" if diagrams else "No response was generated."),
    )
    return True


def _public_sources(sources: list | None) -> list:
    """Never expose internal uploader metadata through citation responses/history."""
    return [
        {key: value for key, value in source.items() if not str(key).startswith('_')}
        for source in (sources or [])
        if isinstance(source, dict)
    ]


def _save_scored_ai_response(
    session_id: str,
    answer_text: str,
    diagrams: list,
    was_retrieved: bool,
    actor: dict,
    sources: list | None = None,
) -> list:
    public_sources = _public_sources(sources)
    saved = _save_ai_response(
        session_id,
        answer_text,
        diagrams,
        was_retrieved,
        sources=public_sources,
    )
    if saved and was_retrieved and sources:
        award_cited_sources(actor['workspace_id'], sources, uuid.uuid4().hex)
    return public_sources

@app.post("/get-answer")
def get_answer(question: UserRequest):
    authorize_session(question.sessionId, allow_new=True)
    question.userTeam = retrieval_scope()
    actor = current()
    selected_sources = _validated_selected_sources(question.selectedSources, actor)
    retrieval_question = _retrieval_question(question.question, selected_sources)
    username = session_owner()
    session_manager.ensure_session(username, question.sessionId)
    _apply_chat_branch(question)
    history = visible_history(question.sessionId)
    clearance = query_clearance(question.question, actor['role'])
    if not clearance['allowed']:
        record_retrieval_audit(question.userTeam, question.question, [])
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        history_manager.save_messages(question.sessionId, "human", question.question)
        session_manager.update_session(
            username, question.sessionId,
            last_message_at=now,
            last_message_preview=question.question,
        )
        _save_ai_response(question.sessionId, clearance['message'], [], False, sources=[])
        return {
            "answer": clearance['message'],
            "diagrams": [],
            "sources": [],
            "citation_names": [],
            "blocked": True,
            "guardrail": {
                "category": clearance['category'],
                "minimum_role": clearance['minimum_role'],
                "current_role": actor['role'],
            },
        }
    result = engine.get_answer(
        retrieval_question,
        history,
        user_team=question.userTeam,
        selected_sources=selected_sources,
    )

    answer_text = result["answer"]
    diagrams = result.get("diagrams",[])
    sources = result.get("sources", [])
    citation_names = result.get("citation_names", [])
    # Prefer structured `sources` (list of dicts). If absent, build minimal
    # structured entries from `citation_names` so UI can render after reload.
    if sources and isinstance(sources, list) and len(sources) > 0:
        sources_to_save = sources
    elif citation_names and isinstance(citation_names, list) and len(citation_names) > 0:
        built = []
        for idx, name in enumerate(citation_names, start=1):
            built.append({
                "index": idx,
                "sourceName": name,
                "preview": "",
            })
        sources_to_save = built
    else:
        sources_to_save = []
    was_retrieved = result.get("retrieved", True)
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    # Always save the human message
    history_manager.save_messages(question.sessionId, "human", question.question)
    session_manager.update_session(
        username,
        question.sessionId,
        last_message_at=now,
        last_message_preview=question.question
    )
  
    public_sources = _save_scored_ai_response(
        question.sessionId, answer_text, diagrams, was_retrieved, actor,
        sources=sources_to_save,
    )

    return {
        "answer": answer_text,
        "diagrams": diagrams,
        "sources": public_sources,
        "citation_names": citation_names,
    }


@app.post("/get-answer/stream")
async def get_answer_stream(question: UserRequest):
    authorize_session(question.sessionId, allow_new=True)
    question.userTeam = retrieval_scope()
    actor = current()
    selected_sources = _validated_selected_sources(question.selectedSources, actor)
    retrieval_question = _retrieval_question(question.question, selected_sources)
    username = session_owner()
    session_manager.ensure_session(username, question.sessionId)
    _apply_chat_branch(question)
    history = visible_history(question.sessionId)
    clearance = query_clearance(question.question, actor['role'])

    # Save human message immediately (before streaming begins)
    history_manager.save_messages(question.sessionId, "human", question.question)
    session_manager.update_session(
        username, question.sessionId,
        last_message_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        last_message_preview=question.question,
    )

    if not clearance['allowed']:
        record_retrieval_audit(question.userTeam, question.question, [])
        answer_text = clearance['message']
        _save_ai_response(question.sessionId, answer_text, [], False, sources=[])

        async def blocked_event_stream():
            yield _build_sse_event("guardrail", {
                "blocked": True,
                "category": clearance['category'],
                "minimum_role": clearance['minimum_role'],
                "current_role": actor['role'],
            })
            for token in re.findall(r"\S+\s*|\s+", answer_text):
                yield _build_sse_event("token", {"token": token})
            yield _build_sse_event("done", {
                "answer": answer_text,
                "diagrams": [],
                "sources": [],
                "citation_names": [],
                "retrieved": False,
                "blocked": True,
                "guardrail": {
                    "category": clearance['category'],
                    "minimum_role": clearance['minimum_role'],
                    "current_role": actor['role'],
                },
            })

        return StreamingResponse(
            blocked_event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def event_stream():
        yield _build_sse_event("thinking", {
            "stage": "retrieving",
            "message": "Retrieving permitted documents…",
        })

        # Run blocking preparation (retrieval / chain build) in executor
        loop = asyncio.get_event_loop()
        prepared = await loop.run_in_executor(
            None,
            lambda: engine._build_answer_request(
                retrieval_question,
                history,
                team_id=question.userTeam,
                selected_sources=selected_sources,
            )
        )

        mode = prepared.get("mode")

        if mode != "answer":
            answer_text = prepared.get("answer", "")
            diagrams = prepared.get("diagrams", [])
            was_retrieved = prepared.get("retrieved", True)
            sources = prepared.get("sources", [])
            citation_names = prepared.get("citation_names", [])
            if sources and isinstance(sources, list) and len(sources) > 0:
                sources_to_save = sources
            elif citation_names and isinstance(citation_names, list) and len(citation_names) > 0:
                built = []
                for idx, name in enumerate(citation_names, start=1):
                    built.append({
                        "index": idx,
                        "sourceName": name,
                        "preview": "",
                    })
                sources_to_save = built
            else:
                sources_to_save = []

            public_sources = _save_scored_ai_response(
                question.sessionId, answer_text, diagrams, was_retrieved, actor,
                sources=sources_to_save,
            )
            yield _build_sse_event("done", {
                "answer": answer_text,
                "diagrams": diagrams,
                "sources": public_sources,
                "citation_names": citation_names,
                "retrieved": was_retrieved,
            })
            return

        question_answer_chain = prepared["question_answer_chain"]
        standalone_q = prepared["standalone_q"]
        context_block = prepared["context_block"]
        diagrams = prepared.get("diagrams", [])
        answer_parts = []

        yield _build_sse_event("thinking", {
            "stage": "drafting",
            "message": "Drafting a grounded response…",
        })

        try:
            async for chunk in question_answer_chain.astream({
                "input": standalone_q,
                "context": context_block,
            }):
                token = chunk.content if hasattr(chunk, "content") else str(chunk or "")
                if not token:
                    continue
                answer_parts.append(token)

        except Exception as stream_exc:
            print(f"Streaming draft failed; using reflected workflow: {stream_exc}")
            yield _build_sse_event("thinking", {
                "stage": "verifying",
                "message": "Agent verifying facts…",
            })
            fallback = await loop.run_in_executor(
                None,
                lambda: engine.get_answer(
                    retrieval_question,
                    history,
                    user_team=question.userTeam,
                    selected_sources=selected_sources,
                )
            )
            answer_text = fallback.get("answer", "")
            diagrams = fallback.get("diagrams", [])
            sources = fallback.get("sources", [])
            public_sources = _save_scored_ai_response(
                question.sessionId, answer_text, diagrams, True, actor,
                sources=sources,
            )
            for token in re.findall(r"\S+\s*|\s+", answer_text):
                yield _build_sse_event("token", {"token": token})
            yield _build_sse_event("done", {
                "answer": answer_text, "diagrams": diagrams,
                "sources": public_sources,
                "retrieved": True, "fallback": True,
            })
            return

        answer_text = _normalize_markdown_answer("".join(answer_parts))
        sources = prepared.get("sources", [])
        citation_names = prepared.get("citation_names", [])

        yield _build_sse_event("thinking", {
            "stage": "verifying",
            "message": "Agent verifying facts…",
        })
        reflection_state = {
            "draft_answer": answer_text,
            "context_block": context_block,
            "retry_count": 0,
            "reflection_passed": False,
            "reflection_feedback": "",
        }
        reflection_state = await loop.run_in_executor(
            None,
            lambda: engine._node_reflect(reflection_state),
        )
        if not reflection_state.get("reflection_passed", True):
            corrected = await loop.run_in_executor(
                None,
                lambda: engine.get_answer(
                    retrieval_question,
                    history,
                    user_team=question.userTeam,
                    selected_sources=selected_sources,
                ),
            )
            answer_text = corrected.get("answer", answer_text)
            diagrams = corrected.get("diagrams", diagrams)
            sources = corrected.get("sources", sources)
            citation_names = corrected.get("citation_names", citation_names)

        for token in re.findall(r"\S+\s*|\s+", answer_text):
            yield _build_sse_event("token", {"token": token})

        if sources and isinstance(sources, list) and len(sources) > 0:
            sources_to_save = sources
        elif citation_names and isinstance(citation_names, list) and len(citation_names) > 0:
            built = []
            for idx, name in enumerate(citation_names, start=1):
                built.append({
                    "index": idx,
                    "sourceName": name,
                    "preview": "",
                })
            sources_to_save = built
        else:
            sources_to_save = []

        public_sources = _save_scored_ai_response(
            question.sessionId, answer_text, diagrams, True, actor,
            sources=sources_to_save,
        )
        yield _build_sse_event("done", {
            "answer": answer_text,
            "diagrams": diagrams,
            "sources": public_sources,
            "citation_names": citation_names,
            "retrieved": True,
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
     
@app.post("/get-history/{sessionId}")
async def getAllChatHistory(sessionId:str):
    authorize_session(sessionId)
    chatHistory = visible_history(sessionId)
    if len(chatHistory) > 0:
        return {
            "message":"Successfully Retrived Chat History.",
            "chat-history":chatHistory
        }
    else:   
        return {
            "message":"No history for this User found."
        }
    
    
@app.post("/delete-chat/{sessionId}")
async def deleteChatBySessionId(sessionId:str):
    authorize_session(sessionId)
    session_manager.delete_session(session_owner(), sessionId)
    
    return {
        "message":"Chat Deleted Successfully.."
    }


    
    
@app.post("/slack/events")
async def slack_events(request: Request):
    
    raise HTTPException(403, 'Slack ingestion requires a workspace-bound integration; use authenticated uploads for now.')
