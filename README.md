# DeepContext

DeepContext is a document-grounded AI assistant for internal knowledge search. It ingests files into a shared Chroma collection, answers questions with hybrid retrieval, supports diagram-aware responses, and keeps chat sessions/history in SQLite.

## Accounts, workspaces, and access

On first opening the app, create an account and workspace. Its creator becomes the owner. Existing users can sign in; invited users join through the link generated under **Workspace settings**. Invitation links are tied to an email address, expire after seven days, and can be used once. Share links yourself; the app does not send invitation emails.

| Role | Permissions |
| --- | --- |
| Viewer | Chat and read documents permitted for viewers |
| Member | Viewer permissions plus uploads |
| Editor | Member permissions plus document approval, deletion, and access changes |
| Admin | Editor permissions plus invitations for viewers, members, and editors |
| Owner | All permissions plus admin invitations, member role changes, and access revocation |

The clearance hierarchy is `viewer < member < editor < admin < owner`. A role inherits the document access of every role below it, but management capabilities remain explicit: editors manage documents, admins manage invitations and member visibility, and only owners can change or revoke memberships. Owners cannot be demoted or removed.

Choose a minimum role when uploading a document; the uploader's role is selected by default. For example, **Editors and above** excludes viewers and members from document listings, retrieval, diagrams, and job progress. Editor, admin, and owner uploads are self-approved and start indexing immediately. Member uploads wait for an editor or higher role to approve them. Editors, admins, and owners can change access later using the document card selector. Workspace membership is checked on every authenticated request, so role changes apply to existing sessions and revoking access invalidates workspace sessions. Chats are private to a user, workspace, and role; changing role starts a separate history to avoid exposing previously privileged answers.

Authentication uses signed HS256 JWTs with an eight-hour expiry in an HttpOnly, SameSite=Lax cookie. JWT sessions are tracked server-side so logout revokes the token. Passwords use salted scrypt hashes. Browser requests include credentials; API callers may supply the same JWT as `Authorization: Bearer <token>`. Requests from unrelated browser origins are rejected. Login attempts are limited per client/email.

Install the new dependency before restarting API and Celery:

```bash
cd backend
source .venv/bin/activate
uv pip install PyJWT==2.10.1
```

Optional backend settings:

```env
# Set a strong shared secret for deployed installations (at least 32 characters).
# If unset locally, a random secret is stored in backend/data/.jwt-secret.
JWT_SECRET=replace_with_a_random_secret_at_least_32_characters_long
# Enable when the app is served over HTTPS.
AUTH_COOKIE_SECURE=false
# Optional comma-separated explicit frontend origins for a different host.
AUTH_ALLOWED_ORIGINS=
```

Keep API and frontend on the same browser hostname (both localhost or both the same LAN IP). The default frontend configuration chooses that hostname automatically. For deployment, use HTTPS and `AUTH_COOKIE_SECURE=true`; preserve the SQLite database and signing secret across restarts.

Existing anonymous documents and conversations are retained on disk but are not automatically assigned to a workspace. Re-upload and approve the documents you want in a workspace. The old public Slack webhook is disabled until a workspace-bound integration is configured.

The center panel has two separate modes: **AI assistant** is the document-grounded DeepContext chat, while **Nexconn** is a real Nexconn Chat SDK channel. Nexconn is bound to one DeepContext workspace by `NEXCONN_WORKSPACE_ID`; users in any other workspace receive no Nexconn credentials. The App Secret is used only by the backend to sign Nexconn's access-token request and is never returned to the browser.

Main authentication endpoints: `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/workspaces`, `/auth/switch-workspace`, `/auth/invitations`, `/auth/accept-invite`; `GET /auth/me`, `/auth/members`; `PATCH`/`DELETE /auth/members/{user_id}`. Document access is updated with `PATCH /documents/{sourceName}/access` and `{ "access_role": "viewer|member|editor|admin|owner" }`.

### AI clearance enforcement

AI access is enforced at two independent layers:

1. Every Chroma query includes the authenticated workspace ID and `access_level <= current role`. This applies to semantic retrieval, BM25, sibling expansion, diagrams, and document snapshots, so restricted chunks never enter the model context.
2. `access_policy.query_clearance` evaluates sensitive intent before retrieval. Compensation and private employee records require `admin`; credentials and secrets require `owner`. Blocked questions return a clean policy response without calling Chroma or the LLM.

`viewer` is the lowest-clearance role in the five-role model and is the intern-equivalent tier. Keep document access at the lowest role that genuinely needs it; the query guardrail is defense in depth and never replaces document metadata permissions. Add or revise sensitive-topic patterns centrally in `backend/access_policy.py`.

Run backend checks without external services:

```bash
cd backend
source .venv/bin/activate
python -m unittest discover -s tests -v
```

## What This App Does

- Uploads business documents and processes them asynchronously
- Extracts text from plain files, PDFs, and image-heavy documents
- Stores retrievable chunks in ChromaDB
- Answers questions with retrieval + LLM generation
- Renders markdown answers with citations and diagrams in a React UI
- Supports chat sessions, history, and document management
- Includes a legacy Slack ingestion path, disabled until workspace-bound integration is configured
- Uses a tokenized design system and custom brand components in the frontend
- Holds browser uploads for approval before indexing
- Connects authenticated workspace members to a real Nexconn direct, group, open, or community channel

## Architecture at a Glance

```text
Frontend (React + Vite)
    |
    v
Backend API (FastAPI)
    |
    +--> SQLite (chat_history, chat_sessions)
    +--> Celery Worker ---> Redis (broker/result backend)
    |         |
    |         +--> Supervisor
    |         +--> DataIngestor
    |         +--> MeetingAgent
    |         +--> ChromaDB
    |
    +--> DeepContextEngine (RAG)
              |
              +--> HuggingFace embeddings
              +--> Chroma vector retrieval
              +--> BM25 rank fusion
              +--> Groq LLM
              +--> Diagram intent + extraction
```

## End-to-End Flow

1. Frontend uploads a file to `POST /upload` (maximum 15 MB).
2. Backend stores the file in `backend/data` and registers it as `pending_approval`.
3. Approve it with `POST /approve-document/{document_id}` to queue a Celery task. The worker runs ingestion via `Supervisor` -> `DataIngestor`.
4. Content is chunked, diagram blocks are extracted, and records are indexed in Chroma.
5. User asks a question through `POST /get-answer` (or the streaming SSE endpoint `POST /get-answer/stream`).
6. Backend fetches session history, performs hybrid retrieval (vector + BM25), then generates a grounded answer (streamed tokens are sent to the frontend when using the streaming endpoint).
7. The AI response (or streamed tokens) are saved to session history unless the answer is judged to be weak/placeholder by the service.
8. Frontend renders markdown, diagrams, and source cards.

## Core Features

- **Async ingestion:** FastAPI + Celery + Redis job pipeline
- **Hybrid retrieval:** sentence-transformer embeddings + BM25 reciprocal-rank fusion
- **OCR-style extraction:** scanned PDFs and images can be converted to retrievable text
- **Diagram-aware QA:** Mermaid and PlantUML sources are extracted and can be returned directly
- **Streaming answers:** server-sent-events (SSE) endpoint for partial token streaming (`/get-answer/stream`)
- **Skip-save heuristics:** very weak or placeholder answers are not persisted to chat history to avoid noisy records
- **Meeting transcript path:** files containing `meeting` or `transcript` get summarized into structured records
- **Session persistence:** chat sessions and message history stored in SQLite
- **Slack ingestion:** `file_shared` events can trigger the same ingestion pipeline

## Tech Stack

### Frontend

- React 19
- Vite 7
- React Router 7
- Axios
- Tailwind CSS 4
- `react-markdown` + `remark-gfm`
- Mermaid
- Design tokens: `src/styles/tokens.css` centralizes colors, radii, motion and surface tokens
- Custom brand components: `SonarGlyph` (animated logo), `LogoLockup`, token-aware components (`DocCard`, `MessageBubble`, `ThinkingIndicator`, `WelcomeScreen`)
- Accessible `ConfirmModal` component used for delete confirmations (replaces native `confirm()`)
- Fonts: Inter (UI) and JetBrains Mono (code) are loaded via `src/index.css` @import

### Backend

- FastAPI + Uvicorn
- Celery
- Redis
- LangChain ecosystem (`langchain`, `langchain-chroma`, `langchain-huggingface`, `langchain-groq`)
- ChromaDB (HTTP mode)
- SQLite
- `pdf2image`, Pillow

## Repository Structure

```text
DeepContext/
├── backend/
│   ├── MainApplicationRunner.py   # API routes and app setup
│   ├── rag_engine.py              # Retrieval + answer generation
│   ├── ingestor.py                # File parsing/chunking/diagram extraction
│   ├── supervisor.py              # Ingestion orchestration
│   ├── meeting_agent.py           # Meeting transcript summarization
│   ├── celery_worker.py           # Celery task entrypoint
│   ├── database.py                # SQLite schema bootstrap
│   ├── chat_history_manager.py
│   ├── chat_session_manager.py
│   ├── diagram_utils.py
│   ├── start_chroma.sh
│   └── requirements.txt
├── frontend/
│   ├── src/App.jsx
│   ├── src/main.jsx
│   ├── src/styles/tokens.css
│   ├── src/components/brand/SonarGlyph.jsx
│   ├── src/components/brand/LogoLockup.jsx
│   ├── src/components/layout/Sidebar.jsx
│   ├── src/components/ChatWindow.jsx
│   ├── src/components/ChatHistoryDrawer.jsx
│   ├── src/components/MarkdownRenderer.jsx
│   ├── src/components/DiagramRenderer.jsx
│   ├── src/components/docs/DocCard.jsx
│   ├── src/components/chat/MessageBubble.jsx
│   ├── src/components/chat/ThinkingIndicator.jsx
│   ├── src/components/chat/WelcomeScreen.jsx
│   ├── src/components/ui/ConfirmModal.jsx
│   ├── src/utils/api.util.js
│   ├── src/utils/chatSessions.util.js
│   └── package.json
└── docker-compose.yml
```

## Supported File Types


| File type               | Processing strategy                      |
| ----------------------- | ---------------------------------------- |
| `.txt`, `.md`           | Direct text load                         |
| `.puml`                 | Text load + PlantUML extraction          |
| `.mmd`, `.mermaid`      | Text load + Mermaid extraction           |
| Text PDFs               | Native PDF text extraction               |
| Scanned PDFs            | PDF page imaging + vision/OCR extraction |
| `.jpg`, `.jpeg`, `.png` | Vision/OCR extraction                    |
| `.docx` | Word body paragraphs and tables |
| `.xlsx` | Worksheet names, cell values and formulas |
| `.pptx` | Slide text, tables, grouped text and speaker notes |
| `.doc`, `.xls`, `.ppt` | LibreOffice conversion, then Office text extraction |

Office extraction runs locally without a vision model. Embedded pictures and chart graphics are not OCR-processed. Excel formulas are indexed as formulas rather than recalculated values. The existing 15 MB upload limit and approval workflow apply to Office files too.

Install Office parsing packages with `uv pip install -r backend/requirements.txt` in the activated backend environment. For legacy `.doc`, `.xls`, and `.ppt` files on Ubuntu/Debian, also run:

```bash
sudo apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress
```

LibreOffice is included in the backend Docker image. Modern `.docx`, `.xlsx`, and `.pptx` files do not require LibreOffice.


## API Endpoints


| Method   | Endpoint                       | Purpose                                   |
| -------- | ------------------------------ | ----------------------------------------- |
| `POST`   | `/upload`                      | Upload a document for approval (15 MB max) |
| `GET` | `/pending-documents` | List uploads awaiting approval |
| `POST` | `/approve-document/{document_id}` | Approve upload and queue ingestion |
| `POST` | `/reject-document/{document_id}` | Reject pending upload |
| `GET` | `/nexconn/session` | Issue an authenticated Nexconn SDK bootstrap for the active workspace |
| `GET`    | `/job-progress/{job_id}`       | SSE stream of ingestion job progress      |
| `GET`    | `/job-status/{job_id}`         | Check ingestion job status                |
| `GET`    | `/health`                      | API + Chroma health summary               |
| `GET`    | `/health/chroma`               | Chroma heartbeat and collection stats     |
| `GET`    | `/retriveAllDocuments`         | List indexed documents                    |
| `DELETE` | `/deleteDocument/{sourceName}` | Remove an indexed document by source name |
| `POST`   | `/get-answer`                  | Ask a question against shared knowledge   |
| `POST`   | `/get-answer/stream`           | Ask a question and receive streamed tokens (SSE) |
| `POST`   | `/get-history/{sessionId}`     | Fetch message history for a session       |
| `GET`    | `/chat-sessions`               | List sessions                             |
| `POST`   | `/chat-sessions`               | Create a session                          |
| `PATCH`  | `/chat-sessions/{sessionId}`   | Update session metadata                   |
| `POST`   | `/delete-chat/{sessionId}`     | Delete a session and its messages         |
| `POST`   | `/slack/events`                | Slack events ingestion webhook            |

| `POST`   | `/`                            | Basic API root / liveness check           |


## Environment Variables

Configure backend values in `backend/.env` (or your runtime environment):

```env
# Required
GROQ_API_KEY=your_groq_api_key
GROQ_CHAT_MODEL=openai/gpt-oss-20b
GROQ_VISION_MODEL=qwen/qwen3.8-27b
# Optional: override the model used for meeting summaries; defaults to chat model.
GROQ_MEETING_MODEL=openai/gpt-oss-20b

# Optional (Slack ingestion)
SLACK_BOT_TOKEN=your_slack_bot_token

# Optional (real Nexconn Chat channel)
# Use the data-center API base URL shown in the Nexconn Console.
NEXCONN_API_BASE_URL=https://api.sg-light-api.com
NEXCONN_APP_KEY=
NEXCONN_APP_SECRET=
# Copy the active workspace ID from GET /auth/me.
NEXCONN_WORKSPACE_ID=
# direct | group | open | community
NEXCONN_CHANNEL_TYPE=group
NEXCONN_CHANNEL_ID=
# Required only when NEXCONN_CHANNEL_TYPE=community.
NEXCONN_SUBCHANNEL_ID=
NEXCONN_CHANNEL_NAME=Nexconn Channel
# sg | bj | na | sa | om
NEXCONN_AREA_CODE=sg

# Chroma connection (must match across API + Celery worker)
CHROMA_HOST=localhost
CHROMA_PORT=8001
CHROMA_SSL=false
CHROMA_COLLECTION_NAME=deepcontext_v2

# Optional Chroma startup tuning
CHROMA_STARTUP_RETRIES=30
CHROMA_STARTUP_RETRY_DELAY=2

# Retrieval tuning
RETRIEVAL_SEMANTIC_K=20
RETRIEVAL_BM25_K=20
RETRIEVAL_SEMANTIC_DISTANCE_MAX=6.2
RERANK_ENABLED=true
RERANK_MODEL=cross-encoder/ms-marco-MiniLM-L-6-v2
RERANK_CANDIDATE_K=20
RERANK_TOP_K=5
RERANK_MAX_CHUNK_CHARS=1500

# Celery/Redis
REDIS_URL=redis://localhost:6379/0

# Embedding loader behavior
HUGGINGFACE_LOCAL_FILES_ONLY=false
```

### Enable the Nexconn channel

1. Create a Nexconn application and copy its environment-specific App Key, App Secret, and data-center API base URL into `backend/.env` using the variables above.
2. Sign in to DeepContext and copy `user.workspace_id` from `GET /auth/me` into `NEXCONN_WORKSPACE_ID`.
3. Choose a channel type and ID. A group ID must contain only letters and numbers and be at most 64 characters. For a community channel, also provide its subchannel ID.
4. Restart the FastAPI backend, select **Nexconn** in the center-panel switcher, and connect as the DeepContext workspace owner first.

For a group channel, that first owner connection creates the configured Nexconn group if necessary. Later workspace members are registered with opaque Nexconn user IDs and added to the group automatically. Open and community channels must already exist in Nexconn; direct mode treats `NEXCONN_CHANNEL_ID` as the other user's Nexconn ID. The Nexconn SDK is loaded only when the Nexconn tab is opened, so it does not slow the initial AI-assistant page load.

Nexconn chat is available to every authenticated workspace role because it is a collaboration channel, not a document-retrieval path. The backend binds the session to `NEXCONN_WORKSPACE_ID`, returns no App Secret, and permits only the DeepContext owner to create a missing group. Nexconn messages do not bypass Chroma document clearance or the AI query guardrail.

Frontend base URL:

```env
VITE_API_BASE_URL=http://localhost:2020
# Optional: URL of your deployed Nexconn Call/huddle experience.
VITE_NEXCONN_HUDDLE_URL=https://your-call-app.example.com/room
```

If `VITE_API_BASE_URL` is not set, frontend falls back to `http://<browser-hostname>:2020`.
The **Huddle** button opens `VITE_NEXCONN_HUDDLE_URL` with the current workspace ID as
the `workspace` query parameter. When it is not configured, the UI displays setup guidance
instead of pretending that a call was connected.

### Chroma environment matrix

Use the **same** `CHROMA_*` values for the FastAPI process and the Celery worker. A host/port/collection mismatch causes uploads to succeed while chat retrieval stays empty.

| Runtime | `CHROMA_HOST` | `CHROMA_PORT` | `CHROMA_COLLECTION_NAME` |
|---------|---------------|---------------|--------------------------|
| Local dev (`start_chroma.sh`) | `localhost` | `8001` | `deepcontext_v2` |
| Docker Compose | `chromadb` | `8000` | `deepcontext_v2` |

Health endpoints after startup:

- `GET /health` — API + Chroma summary
- `GET /health/chroma` — Chroma heartbeat, collection name, document count

## Local Development Setup

### Prerequisites

- Python 3.11 (matches the backend Docker image and runtime file)
- Node.js 22.12+ (or 20.19+), as required by the installed Vite 7 package
- Redis
- Poppler (required by `pdf2image`)
- Docker optional (if you prefer containerized run)

Run the commands below from the repository root unless a terminal block says otherwise. These instructions use Bash on Linux/macOS. Keep each service terminal running.

On Ubuntu/Debian, install system dependencies first:

```bash
sudo apt-get update
sudo apt-get install -y python3-venv python3-dev build-essential poppler-utils redis-server
```

### 1) Configure environment files

Create or edit `backend/.env`; preserve any existing credentials. For local development, the minimum settings are:

```env
GROQ_API_KEY=replace_with_your_groq_api_key
CHROMA_HOST=localhost
CHROMA_PORT=8001
CHROMA_SSL=false
CHROMA_COLLECTION_NAME=deepcontext_v2
REDIS_URL=redis://localhost:6379/0
HUGGINGFACE_LOCAL_FILES_ONLY=false
```

Create or edit `frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:2020
# Optional; opens the configured room from the Huddle button.
VITE_NEXCONN_HUDDLE_URL=https://your-call-app.example.com/room
```

The first API/worker startup downloads Hugging Face embedding models and can take several minutes. Groq credentials and network access are needed for answer generation, vision extraction, and meeting summaries.

### 2) Install backend dependencies

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
mkdir -p data
python3 -c "from database import initDB; initDB()"
```

### 3) Start required services

Terminal A (Chroma):

```bash
cd backend
source .venv/bin/activate
bash start_chroma.sh
```

Terminal B (Redis; skip this if Redis is already running):

```bash
redis-server
```

Terminal C (API, after Chroma and Redis are running):

```bash
cd backend
source .venv/bin/activate
uvicorn MainApplicationRunner:app --host 0.0.0.0 --port 2020 --reload
```

Terminal D (Celery worker):

```bash
cd backend
source .venv/bin/activate
celery -A celery_worker.app worker --loglevel=info
```

### 4) Frontend setup (another terminal)

```bash
cd frontend
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Frontend QA notes

- Delete flows: document and chat deletions now use a token-styled, accessible confirmation modal (`ConfirmModal`). Confirmations no longer use `window.confirm()`; test keyboard interactions (Esc to cancel, Enter to confirm, Tab cycles focus).
- Message input: chat input uses a `textarea` where Enter sends the message and Shift+Enter inserts a newline. This is intentional — adjust in `src/components/ChatWindow.jsx` if you'd like the old behavior.
- Design tokens: visual styles are centralized in `src/styles/tokens.css`; to change colors or radii, edit that file and the change propagates across components.


## Run With Docker

Requires Docker Engine and the Docker Compose plugin. Run from the repository root.

1. Create or edit `backend/.env` and set a valid `GROQ_API_KEY`. Compose supplies the internal Chroma and Redis addresses for both API and worker.
2. In the `frontend.environment` section of `docker-compose.yml`, replace `VITE_API_BASE_URL=http://10.121.162.162:2020` with `VITE_API_BASE_URL=http://localhost:2020`. For access from another machine, use the backend host's reachable IP instead of localhost. This setting overrides `frontend/.env`.
3. Build and start the stack:

```bash
docker compose up --build -d
docker compose logs -f backend celery_worker frontend
```

Check status or stop the stack:

```bash
docker compose ps
docker compose down
```

`down` retains named volumes. Uploads and SQLite remain in `backend/data`. The Compose stack also starts MongoDB and a PlantUML server, but the current backend persists metadata in SQLite and generates public PlantUML image URLs; these extra services are not required for the core local workflow.

Optional Nexconn settings in Compose use `${NEXCONN_*}` interpolation: set them in your shell or a root `.env` file. The Compose environment entries override values in `backend/.env`.

Default access:

- Frontend: [http://localhost:5173](http://localhost:5173)
- Backend: [http://localhost:2020](http://localhost:2020)

Notes:

- In `docker-compose.yml`, frontend currently sets `VITE_API_BASE_URL` to a hardcoded LAN IP. Update it for your machine/environment.
- Docker uses Chroma internal service port `8000`, while local `start_chroma.sh` defaults to `8001`. This is expected because they are different runtime contexts.
- Both API and Celery must use the same `CHROMA_COLLECTION_NAME` (`deepcontext_v2` by default). Backend and worker wait for Chroma on startup and fail fast if it is unreachable.
- Retrieval now supports a cross-encoder reranker. Leave `RERANK_ENABLED=true` for best answer quality, or set it to `false` to fall back to the hybrid-only path.

## Verify startup and ingest your first document

Open the frontend at [http://localhost:5173](http://localhost:5173) and the interactive API docs at [http://localhost:2020/docs](http://localhost:2020/docs).

```bash
curl -fsS http://localhost:2020/health
curl -fsS http://localhost:2020/health/chroma
```

The health endpoints check the API and Chroma, not Redis, the worker, or Groq. Verify ingestion separately:

```bash
# Replace the file path with an existing document.
curl -fsS -F 'file=@/absolute/path/to/document.pdf' http://localhost:2020/upload
curl -fsS http://localhost:2020/pending-documents

# Replace DOCUMENT_ID with the document_id returned by the upload.
curl -fsS -X POST http://localhost:2020/approve-document/DOCUMENT_ID

# Replace JOB_ID with the job_id returned by approval.
curl -fsS http://localhost:2020/job-status/JOB_ID
curl -fsS http://localhost:2020/retriveAllDocuments
```

A successful upload alone does not index the document. Approve it through the API docs or the command above, wait for the worker to finish, then refresh the document list in the UI and ask a question about its contents.

## Troubleshooting

- **Frontend cannot reach the API:** check `VITE_API_BASE_URL`, especially the hardcoded address in Compose. Restart Vite after changing environment settings.
- **API fails during startup:** start Chroma first and check the API logs. API and worker must share the same Chroma host, port, and collection. Local ports are `8001`; inside Compose use `chromadb:8000`.
- **Upload is absent from search:** check pending approval first, then job status and worker logs. Redis and Celery must both be running.
- **Redis port is already in use:** use the running Redis instance instead of launching another one.
- **Models fail to load:** allow the initial model download and leave `HUGGINGFACE_LOCAL_FILES_ONLY=false` until the models are cached.
- **Scanned PDF extraction fails:** confirm Poppler is installed and the configured Groq account can access the vision model used in `backend/ingestor.py`.

Frontend production build check:

```bash
cd frontend
npm run build
```

## Meeting Transcript Workflow

When a filename includes `meeting` or `transcript`, ingestion follows a dedicated path:

- full text is aggregated
- `MeetingAgent` generates a structured summary
- summary is stored as a high-value record in Chroma

## Diagram Behavior

- Mermaid is rendered client-side in the frontend
- PlantUML is rendered via generated PlantUML server URLs
- Diagram records are stored separately and can be returned directly when diagram intent is detected

## Current Limitations

- Workspace access uses roles and minimum document roles; custom per-person document allowlists are not implemented
- SQLite is suitable for local/lightweight usage, not high concurrency production
- PlantUML rendering depends on external PlantUML image hosting
- Upload validation and operational hardening can be improved
- Endpoint naming includes legacy typo: `/retriveAllDocuments`

## License

Add your project license here.
