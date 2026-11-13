from datetime import datetime
import json
import os
import shutil
import requests
import asyncio
import uuid
from fastapi import Request
from fastapi.responses import StreamingResponse

from celery_worker import process_document_task
from celery.result import AsyncResult
from chat_history_manager import ChatHistroyManager
from chat_session_manager import ChatSessionManager
from database import initDB
import supervisor
from fastapi import FastAPI,File,UploadFile,HTTPException,Form
from fastapi.middleware.cors import CORSMiddleware
from auth import (install_auth, current, require_role, session_owner, retrieval_scope, retrieval_filter,
                  connect as auth_connect, ROLES)
from office_loader import OFFICE_EXTENSIONS
from pydantic import BaseModel

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
from rag_engine import DeepContextEngine, _normalize_markdown_answer
from webhook import router as webhook_router, set_engine as set_webhook_engine


SLACK_BOT_TOKEN=os.getenv("SLACK_BOT_TOKEN")

# ── Upload validation constants ─────────────────────────────────────────────
MAX_FILE_SIZE = 15 * 1024 * 1024  # 15 MB

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "text/plain",
    "text/markdown",
    "application/octet-stream",  # .puml, .mmd, .mermaid may report this
}

ALLOWED_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg",
    ".txt", ".md", ".puml", ".mmd", ".mermaid",
}
ALLOWED_EXTENSIONS.update(OFFICE_EXTENSIONS)

app = FastAPI(title="DeepContext API")


origin = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://10.121.162.97:5173",
    *filter(None, os.getenv("AUTH_ALLOWED_ORIGINS", "").split(",")),
]

initDB()
install_auth(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origin,            # Allows requests from your React app
    allow_origin_regex=r"^https?://[^/]+:5173$",
    allow_credentials=True,           # Allows cookies/auth headers
    allow_methods=["*"],              # Allows all methods (GET, POST, etc.)
    allow_headers=["*"],              # Allows all headers
)



# ── Nexconn webhook router ─────────────────────────────────────────────────
app.include_router(webhook_router)

engine = DeepContextEngine()
set_webhook_engine(engine)  # Share the engine with the webhook router
supervisor = supervisor.Supervisor()
history_manager = ChatHistroyManager()
session_manager = ChatSessionManager()

class UserRequest(BaseModel):
    question:str
    sessionId:str
    userTeam:str = "default"


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
            "chroma": chroma,
        },
    }


@app.get("/health/chroma")
def chroma_health_check():
    return check_chroma_health()

@app.post("/upload")
async def upload_docs(file: UploadFile = File(...), access_role: str = Form("viewer")):
    """
    Hardened upload endpoint.

    Validates file size (15 MB max) and MIME type, saves the file to disk,
    and registers it in the pending_uploads table with status 'pending_approval'.
    ChromaDB ingestion is deferred until an admin approves the document.
    """

    actor = require_role('member')
    if access_role not in ROLES or ROLES[access_role] > ROLES[actor['role']]:
        raise HTTPException(403, 'You cannot grant document access above your own role')
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

    if mime_type not in ALLOWED_MIME_TYPES and ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type: mime={mime_type}, ext={ext}. "
                   f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # ── Save file to disk ──
    os.makedirs("./data", exist_ok=True)
    safe_name = os.path.basename((file.filename or '').replace('\\', '/'))
    if not safe_name or safe_name in ('.', '..'):
        raise HTTPException(422, 'A valid filename is required')
    source_name = f"{actor['workspace_id']}__{safe_name}"
    # Each upload has its own directory; pending uploads cannot overwrite each other.
    upload_dir = os.path.join('./data', 'uploads', actor['workspace_id'], uuid.uuid4().hex)
    os.makedirs(upload_dir, exist_ok=True)
    file_path = os.path.join(upload_dir, source_name)
    with open(file_path, "wb") as buffer:
        buffer.write(content)

    # ── Register as pending approval ──
    document_id = str(uuid.uuid4())
    create_pending_upload(
        document_id=document_id,
        source_name=source_name,
        file_path=file_path,
        file_size=file_size,
        mime_type=mime_type or ext,
        uploaded_by=actor["id"],
        team_id=actor["workspace_id"],
    )

    with auth_connect() as db:
        db.execute('UPDATE pending_uploads SET access_level=? WHERE document_id=?', (ROLES[access_role], document_id))

    return {
        "message": "Upload successful. Document is pending approval before ingestion.",
        "document_id": document_id,
        "status": "pending_approval",
        "file_name": file.filename,
        "file_size": file_size,
    }


@app.get("/pending-documents")
def get_pending_documents():
    """List all documents awaiting approval."""
    actor = current()
    pending = [record for record in list_pending_uploads()
               if record.get('team_id') == actor['workspace_id']
               and record.get('access_level', 0) <= ROLES[actor['role']]
               and (ROLES[actor['role']] >= ROLES['admin'] or record.get('uploaded_by') == actor['id'])]
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
    actor = require_role('admin')
    record = get_pending_upload(document_id)
    if not record or record.get('team_id') != actor['workspace_id']:
        raise HTTPException(status_code=404, detail=f"Pending document not found: {document_id}")
    if record.get('access_level', 0) > ROLES[actor['role']]:
        raise HTTPException(403, 'Document access denied')
    if record.get("status") != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Document is not pending (status={record.get('status')})")

    file_path = record.get("file_path")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found on disk for this document.")

    team_id = record.get("team_id", "default")
    task = process_document_task.delay(file_path, team_id=team_id, access_level=record.get('access_level', 0))
    approve_pending_upload(document_id, approved_by=actor['id'], job_id=task.id)

    return {
        "message": "Document approved. Ingestion started in background.",
        "document_id": document_id,
        "job_id": task.id,
    }


@app.post("/reject-document/{document_id}")
def reject_document(document_id: str):
    """Reject a pending document and remove it from the queue."""
    actor = require_role('admin')
    record = get_pending_upload(document_id)
    if not record or record.get('team_id') != actor['workspace_id'] or record.get('access_level', 0) > ROLES[actor['role']]:
        raise HTTPException(404, 'Pending document not found')
    rejected = reject_pending_upload(document_id)
    if not rejected:
        raise HTTPException(status_code=404, detail=f"Pending document not found: {document_id}")

    return {
        "message": "Document rejected.",
        "document_id": document_id,
    }
    

def authorize_job(job_id):
    actor = current()
    with auth_connect() as db:
        row = db.execute('SELECT * FROM pending_uploads WHERE job_id=? AND team_id=?', (job_id, actor['workspace_id'])).fetchone()
    if not row or row['access_level'] > ROLES[actor['role']]:
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
    with auth_connect() as db:
        permitted = {row['source_name']: row['access_level'] for row in db.execute(
            'SELECT source_name, access_level FROM document_access WHERE workspace_id=? AND access_level<=?',
            (actor['workspace_id'], ROLES[actor['role']]))}
    records = [record for record in list_documents() if record['source_name'] in permitted]
    return {'message': 'Success', 'files': [
        {'name': record['source_name'], 'displayName': record['source_name'].split('__', 1)[-1],
         'status': record['status'], 'time': record['ingested_at'], 'version': record['current_version'],
         'chunkCount': len(record.get('chunk_ids') or []),
         'accessRole': next(role for role, value in ROLES.items() if value == permitted[record['source_name']])}
        for record in records]}


@app.delete("/deleteDocument/{sourceName}")
def deleteDocument(sourceName: str):
    actor = require_role('admin')
    with auth_connect() as db:
        allowed = db.execute('SELECT 1 FROM document_access WHERE source_name=? AND workspace_id=? AND access_level<=?',
                             (sourceName.casefold(), actor['workspace_id'], ROLES[actor['role']])).fetchone()
    if not allowed:
        raise HTTPException(404, 'Document not found')
    try:
        vector_db = engine.get_vector_db(refresh=True)
        deleted_count = delete_chunks_for_source(vector_db, sourceName)
        registry_deleted = delete_document_record(sourceName)

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
    access_role: str


@app.patch('/documents/{sourceName}/access')
def update_document_access(sourceName: str, payload: DocumentAccessUpdate):
    actor = require_role('admin')
    if payload.access_role not in ROLES or ROLES[payload.access_role] > ROLES[actor['role']]:
        raise HTTPException(403, 'Cannot assign this access level')
    with auth_connect() as db:
        record = db.execute('SELECT * FROM document_access WHERE source_name=? AND workspace_id=?',
                            (sourceName.casefold(), actor['workspace_id'])).fetchone()
    if not record or record['access_level'] > ROLES[actor['role']]:
        raise HTTPException(404, 'Document not found')
    vector_db = engine.get_vector_db(refresh=True)
    snapshot = vector_db.get(where={'$and': [{'source_name': sourceName.casefold()}, {'team_id': actor['workspace_id']}]})
    if not snapshot['ids']:
        raise HTTPException(409, 'Document has not finished indexing')
    metadata = [{**item, 'access_level': ROLES[payload.access_role]} for item in snapshot['metadatas']]
    vector_db._collection.update(ids=snapshot['ids'], metadatas=metadata)
    with auth_connect() as db:
        db.execute('UPDATE document_access SET access_level=? WHERE source_name=? AND workspace_id=?',
                   (ROLES[payload.access_role], sourceName.casefold(), actor['workspace_id']))
    return {'message': 'Document access updated'}


def visible_history(session_id):
    actor = current()
    with auth_connect() as db:
        permitted = {row['source_name'] for row in db.execute(
            'SELECT source_name FROM document_access WHERE workspace_id=? AND access_level<=?',
            (actor['workspace_id'], ROLES[actor['role']]))}
    history = history_manager.get_history(session_id)
    return [message for message in history if message.get('role') != 'ai' or all(
        str(source.get('sourceName', '')).casefold() in permitted
        for source in message.get('sources', []))]


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
    )
    session_manager.update_session(
        session_owner(),
        session_id,
        last_message_at=now,
        last_message_preview=answer_text or ("Diagram response" if diagrams else "No response was generated."),
    )
    return True

@app.post("/get-answer")
def get_answer(question: UserRequest):
    authorize_session(question.sessionId, allow_new=True)
    question.userTeam = retrieval_scope()
    username = session_owner()
    session_manager.ensure_session(username, question.sessionId)
    history = visible_history(question.sessionId)
    result = engine.get_answer(question.question, history, user_team=question.userTeam)

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
  
    _save_ai_response(question.sessionId, answer_text, diagrams, was_retrieved, sources=sources_to_save)

    return {
        "answer": answer_text,
        "diagrams": diagrams,
        "sources": sources,
        "citation_names": citation_names,
    }


@app.post("/get-answer/stream")
async def get_answer_stream(question: UserRequest):
    authorize_session(question.sessionId, allow_new=True)
    question.userTeam = retrieval_scope()
    username = session_owner()
    session_manager.ensure_session(username, question.sessionId)
    history = visible_history(question.sessionId)

    # Save human message immediately (before streaming begins)
    history_manager.save_messages(question.sessionId, "human", question.question)
    session_manager.update_session(
        username, question.sessionId,
        last_message_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        last_message_preview=question.question,
    )

    async def event_stream():
        # Emit thinking immediately so frontend can show spinner
        yield _build_sse_event("thinking", {"message": "Searching knowledge base…"})

        # Run blocking preparation (retrieval / chain build) in executor
        loop = asyncio.get_event_loop()
        prepared = await loop.run_in_executor(
            None,
            lambda: engine._build_answer_request(question.question, history, team_id=question.userTeam)
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

            _save_ai_response(question.sessionId, answer_text, diagrams, was_retrieved, sources=sources_to_save)
            yield _build_sse_event("done", {
                "answer": answer_text,
                "diagrams": diagrams,
                "sources": sources,
                "citation_names": citation_names,
                "retrieved": was_retrieved,
            })
            return

        question_answer_chain = prepared["question_answer_chain"]
        standalone_q = prepared["standalone_q"]
        context_block = prepared["context_block"]
        diagrams = prepared.get("diagrams", [])
        answer_parts = []
        received_token = False

        try:
            async for chunk in question_answer_chain.astream({
                "input": standalone_q,
                "context": context_block,
            }):
                token = chunk.content if hasattr(chunk, "content") else str(chunk or "")
                if not token:
                    continue
                received_token = True
                answer_parts.append(token)
                yield _build_sse_event("token", {"token": token})

        except Exception as stream_exc:
            if not received_token:
                # Fallback (blocking) in executor if nothing streamed yet
                fallback = await loop.run_in_executor(
                    None,
                    lambda: engine.get_answer(question.question, history, user_team=question.userTeam)
                )
                answer_text = fallback.get("answer", "")
                diagrams = fallback.get("diagrams", [])
                sources = fallback.get("sources", [])
                _save_ai_response(question.sessionId, answer_text, diagrams, True, sources=sources)
                yield _build_sse_event("done", {
                    "answer": answer_text, "diagrams": diagrams,
                    "sources": sources,
                    "retrieved": True, "fallback": True,
                })
                return
            raise stream_exc

        answer_text = _normalize_markdown_answer("".join(answer_parts))
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

        _save_ai_response(question.sessionId, answer_text, diagrams, True, sources=sources_to_save)
        yield _build_sse_event("done", {
            "answer": answer_text,
            "diagrams": diagrams,
            "sources": sources,
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
