# Enhanced Implementation Features Document for DeepContext

**Last updated:** June 2026  
**Companion doc:** [DeepContext_Limitations.md](./DeepContext_Limitations.md) — current failure modes and gaps (use together for leadership reviews).

---

## 1. Executive Summary

DeepContext is an internal **retrieval-augmented** knowledge assistant: it ingests business documents asynchronously, searches with **semantic + keyword (BM25) hybrid retrieval**, and generates **markdown answers** from retrieved text using Groq-hosted LLaMA models. It also supports diagram-aware responses (Mermaid / PlantUML), multi-session chat history in SQLite, meeting transcript summarization, and Slack-triggered ingestion.

**What it does well today:** Fast prototype for “ask questions over uploaded docs” with a modern React UI and Docker Compose stack (API, Celery, Redis, Chroma HTTP).

**What it does not yet provide (common misconceptions):**

- **Inline source citations** in API or UI (answers are not linked to chunk/page provenance today).
- **Multimodal embeddings** (images are OCR’d to text; PDFs are text or full-document OCR, not per-page image+text fusion).
- **Multi-user security** (shared `anonymous` identity, one global Chroma collection).
- **Automatic document replacement** on re-upload (duplicate chunks can exist in the vector DB while the file list shows one name).

The enhancements below move DeepContext from a useful shared prototype toward a **production-ready, trustworthy, multi-user platform**: identity, workspace scoping, document versioning, citations, retrieval fixes, operational visibility, streaming UX, and answer evaluation.

---

## 2. Current System Overview

| Area | Current implementation | Known limitation |
|------|------------------------|------------------|
| Authentication and access control | No login; backend and sessions use hardcoded `anonymous` ([`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`App.jsx`](../frontend/src/App.jsx)). | No user isolation, route protection, or upload/delete policy by role. |
| Document ingestion | FastAPI upload → Celery → [`supervisor.py`](../backend/supervisor.py) → [`ingestor.py`](../backend/ingestor.py). Supports `.txt`, `.md`, text PDFs, scanned PDFs (vision OCR), `.jpg`/`.jpeg`/`.png`, `.puml`, `.mmd`, `.mermaid`. | Single file per upload; coarse job status; text PDFs do not OCR embedded figures; images are not stored as image vectors. |
| Meeting transcripts | Filename contains `meeting` or `transcript` → [`meeting_agent.py`](../backend/meeting_agent.py) summary stored as one Chroma record. | Detail loss vs full transcript; same shared corpus. |
| Vector storage | Chroma **HTTP** client ([`rag_engine.py`](../backend/rag_engine.py)); Docker service in [`docker-compose.yml`](../docker-compose.yml). Embeddings: `sentence-transformers/all-MiniLM-L6-v2` (text only). | Small embedding model ceiling on jargon/synonyms; collection shared by all users; re-upload appends chunks (see versioning). |
| Retrieval | [`_hybrid_search`](../backend/rag_engine.py): semantic (top 10, distance filter) + BM25 over full corpus + RRF; top **5** chunks to LLM; sibling expansion from top `source_name`. | Retrieval runs on **raw** user question before standalone rewrite (follow-ups weak); no cross-encoder reranker; no workspace filter. |
| Answer generation | Groq `llama-3.1-8b-instant`; strict context-only prompt; up to 3 retries on weak “don’t know” phrasing. | No confidence score; can hallucinate or merge chunks; full response wait (no streaming). |
| Citations / provenance | **Not implemented** end-to-end. API returns `answer` + `diagrams` only. | Users cannot verify claims; see planned §3.11. |
| Diagram support | Diagram chunks in Chroma; keyword intent in [`diagram_utils.py`](../backend/diagram_utils.py); Mermaid client-side; PlantUML via public `plantuml.com`. | Wrong diagram if retrieval wrong; external PlantUML dependency. |
| Document list API | `GET /retriveAllDocuments` deduplicates by `source_name` in a `set`. | UI shows one row per filename; **Chroma may still hold multiple chunk sets** for repeated uploads until delete. |
| Chat sessions | SQLite sessions/history; upload via [`ChatHistoryDrawer.jsx`](../frontend/src/components/ChatHistoryDrawer.jsx); polls `/job-status` ~2s. | Not scoped by real user; SQLite not ideal for high concurrency. |
| Slack integration | `file_shared` → Celery ingestion ([`MainApplicationRunner.py`](../backend/MainApplicationRunner.py)). | No Slack user/workspace mapping. |
| Vector DB operations | `get_vector_db(refresh=True)` before reads; `NoOpProductTelemetry` in `rag_engine.py`. | Needs health checks and env consistency (local `8001` vs Docker `8000` / `deepcontext_v2`). |

For narrative detail on failures (hallucination, duplicate vectors, OCR, PDF hybrid, etc.), see [DeepContext_Limitations.md](./DeepContext_Limitations.md).

---

## 3. Enhanced Features — Detailed Specification

### 3.1 Multi-User Authentication with Role-Based Access

| Aspect | Specification |
|--------|----------------|
| What it is | Account-based auth: signup/login, hashed passwords, JWT access tokens, roles `admin`, `editor`, `viewer`. |
| Why it is needed | Shared anonymous access blocks accountability and confidential use. |
| What the current system does instead | No login; all API actions reachable without identity. |
| How it should work after implementation | Auth endpoints issue JWTs; frontend attaches tokens; route guards enforce role policies (upload/delete vs query-only). |
| Files or components involved | [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`database.py`](../backend/database.py), [`chat_session_manager.py`](../backend/chat_session_manager.py), [`main.jsx`](../frontend/src/main.jsx), [`App.jsx`](../frontend/src/App.jsx), [`api.util.js`](../frontend/src/utils/api.util.js), new auth pages. |
| Dependencies or prerequisites | User/role tables, JWT secrets, migration from `anonymous` session ownership. |

---

### 3.2 Department or Workspace Scoping

| Aspect | Specification |
|--------|----------------|
| What it is | Workspaces/departments scope documents, sessions, and retrieval. |
| Why it is needed | Largest product gap: confidential bleed and retrieval noise in one global index. |
| What the current system does instead | One Chroma collection; all users search everything. |
| How it should work after implementation | Upload, chat, and `/get-answer` carry `workspace_id`; Chroma metadata filters on query. |
| Files or components involved | [`rag_engine.py`](../backend/rag_engine.py), [`supervisor.py`](../backend/supervisor.py), [`ingestor.py`](../backend/ingestor.py), [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`chat_session_manager.py`](../backend/chat_session_manager.py). |
| Dependencies or prerequisites | Membership schema, token claims or session context, UI workspace selector. |

---

### 3.3 Real-Time Ingestion Progress via WebSockets or SSE

| Aspect | Specification |
|--------|----------------|
| What it is | Push-based ingestion stages instead of polling-only status. |
| Why it is needed | Users cannot see whether OCR, chunking, or indexing is active or stuck. |
| What the current system does instead | [`ChatHistoryDrawer.jsx`](../frontend/src/components/ChatHistoryDrawer.jsx) polls `/job-status/{job_id}`; Celery returns only `processing` / `completed` / `failed`. |
| How it should work after implementation | Worker emits `uploaded`, `extracting`, `ocr_processing`, `chunking`, `indexing`, `completed`, `failed`; UI subscribes by `job_id`. |
| Files or components involved | [`ChatHistoryDrawer.jsx`](../frontend/src/components/ChatHistoryDrawer.jsx), [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`celery_worker.py`](../backend/celery_worker.py), [`supervisor.py`](../backend/supervisor.py), [`ingestor.py`](../backend/ingestor.py). |
| Dependencies or prerequisites | SSE or WebSocket transport, Redis pub/sub (or equivalent), shared progress event schema. |

---

### 3.4 ChromaDB HTTP Server Architecture (Hardening)

| Aspect | Specification |
|--------|----------------|
| What it is | Formalize Chroma HTTP as the only vector persistence path with ops guardrails. |
| Why it is needed | API and Celery must see the same collection; misconfiguration causes “upload OK, query empty.” |
| What the current system does instead | `chromadb.HttpClient` in [`rag_engine.py`](../backend/rag_engine.py); [`docker-compose.yml`](../docker-compose.yml) runs `chromadb/chroma:0.5.23`; local dev may use [`start_chroma.sh`](../backend/start_chroma.sh) on port `8001` with a different collection name than Docker (`deepcontext_v2`). |
| How it should work after implementation | Startup health checks, retry policy, collection bootstrap, documented env matrix (host/port/collection), optional `/health` dependency in compose. |
| Files or components involved | [`rag_engine.py`](../backend/rag_engine.py), [`docker-compose.yml`](../docker-compose.yml), [`start_chroma.sh`](../backend/start_chroma.sh). |
| Dependencies or prerequisites | Same `CHROMA_*` env for API and worker; persistent `chroma_data` volume in production. |

---

### 3.5 Document Versioning and Update Support

| Aspect | Specification |
|--------|----------------|
| What it is | Re-upload **replaces** (or archives) prior chunks for the same logical document; track version and `ingested_at`. |
| Why it is needed | Today `supervisor` calls `add_documents` without deleting old chunks. `/retriveAllDocuments` hides duplicate **names** but retrieval still searches **all** chunk versions. |
| What the current system does instead | Metadata has `version: 1.0` on chunks but no replacement workflow; `deleteDocument` removes all chunks for a `source_name`. |
| How it should work after implementation | Registry of document identity per workspace; on supersede, delete or archive old vector IDs before index; retrieval defaults to `is_active=true`. |
| Files or components involved | [`supervisor.py`](../backend/supervisor.py), [`ingestor.py`](../backend/ingestor.py), [`rag_engine.py`](../backend/rag_engine.py), [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py). |
| Dependencies or prerequisites | Document registry table, identity rule (hash or canonical name), optional cleanup job for legacy duplicates. |

---

### 3.6 Hybrid Reranking with Cross-Encoder

| Aspect | Specification |
|--------|----------------|
| What it is | Second-stage reranker after RRF (e.g. `cross-encoder/ms-marco-MiniLM-L-6-v2`). |
| Why it is needed | First-pass MiniLM + BM25 misses hard enterprise queries; errors propagate to the LLM. |
| What the current system does instead | [`_hybrid_search`](../backend/rag_engine.py) → top 5 directly to answer chain. |
| How it should work after implementation | Fetch larger candidate set (e.g. 20), rerank, pass top `k` to LLM; feature-flag for low-resource envs. |
| Files or components involved | [`rag_engine.py`](../backend/rag_engine.py). |
| Dependencies or prerequisites | `sentence-transformers` cross-encoder, latency budget, benchmark set. |

---

### 3.7 Answer Streaming to Frontend

| Aspect | Specification |
|--------|----------------|
| What it is | Stream tokens to the chat UI via SSE or WebSockets. |
| Why it is needed | `/get-answer` blocks until complete; poor perceived latency on long answers. |
| What the current system does instead | [`ChatWindow.jsx`](../frontend/src/components/ChatWindow.jsx) waits for full JSON response. |
| How it should work after implementation | Streaming endpoint; partial assistant bubble; attach diagrams/sources on complete. |
| Files or components involved | [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`rag_engine.py`](../backend/rag_engine.py), [`ChatWindow.jsx`](../frontend/src/components/ChatWindow.jsx), [`MarkdownRenderer.jsx`](../frontend/src/components/MarkdownRenderer.jsx). |
| Dependencies or prerequisites | Groq streaming via LangChain, cancellation, non-streaming fallback endpoint during migration. |

---

### 3.8 Document Management UI

| Aspect | Specification |
|--------|----------------|
| What it is | Dedicated admin page: versions, workspace, size, ingest state, preview, delete/archive. |
| Why it is needed | Sidebar list in [`App.jsx`](../frontend/src/App.jsx) cannot show duplicate vectors, version history, or extracted preview. |
| What the current system does instead | Simple name/status/time list from `/retriveAllDocuments`; upload in drawer. |
| How it should work after implementation | Paginated table, role-gated actions, re-upload as new version, preview API for extracted text. |
| Files or components involved | [`App.jsx`](../frontend/src/App.jsx), [`api.util.js`](../frontend/src/utils/api.util.js), [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`rag_engine.py`](../backend/rag_engine.py). |
| Dependencies or prerequisites | §3.1 auth, §3.2 workspace, §3.5 versioning metadata. |

---

### 3.9 Evaluation and Hallucination Detection

| Aspect | Specification |
|--------|----------------|
| What it is | Post-answer grounding score vs retrieved chunks; low-confidence flag in UI and logs. |
| Why it is needed | Context-only prompting does not prevent wrong or over-confident answers. |
| What the current system does instead | Prompt rules + retry on “don’t know” phrasing; **no** embedding similarity check on answer vs evidence. |
| How it should work after implementation | Score answer (or claim spans) against retrieved set; threshold → `confidence: low` + badge; optional review queue. |
| Files or components involved | [`rag_engine.py`](../backend/rag_engine.py), [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`ChatWindow.jsx`](../frontend/src/components/ChatWindow.jsx). |
| Dependencies or prerequisites | Threshold calibration on internal Q&A set; works best after §3.6 reranking stabilizes retrieval. |

---

### 3.10 Inline Source Citations and Provenance (New)

| Aspect | Specification |
|--------|----------------|
| What it is | Every factual answer returns structured `sources[]` (chunk id, `source_name`, page, snippet, score) and the UI shows footnotes or source cards. |
| Why it is needed | **Gap vs older docs/README:** citations were described as current but are **not** in code. Trust and compliance require traceability. |
| What the current system does instead | Markdown answer only; optional diagrams; no chunk linkage in response or [`MarkdownRenderer.jsx`](../frontend/src/components/MarkdownRenderer.jsx). |
| How it should work after implementation | Return retrieval candidates (or matched spans) from `get_answer`; map sentences to chunks via semantic match or LLM cite-id protocol; render in chat. |
| Files or components involved | [`rag_engine.py`](../backend/rag_engine.py), [`MainApplicationRunner.py`](../backend/MainApplicationRunner.py), [`ChatWindow.jsx`](../frontend/src/components/ChatWindow.jsx), [`MarkdownRenderer.jsx`](../frontend/src/components/MarkdownRenderer.jsx). |
| Dependencies or prerequisites | Stable chunk metadata (`source_name`, `chunk_index`, `page`); can ship incrementally before §3.10 automation. |

---

### 3.11 Follow-Up Retrieval Fix (New)

| Aspect | Specification |
|--------|----------------|
| What it is | Run `_hybrid_search` using the **standalone** rewritten question (when chat history exists), not only the raw last user message. |
| Why it is needed | Documented in [DeepContext_Limitations.md §2.2](./DeepContext_Limitations.md): today retrieval precedes `_get_standalone_question`, hurting pronoun follow-ups (“What about their deadline?”). |
| What the current system does instead | [`get_answer`](../backend/rag_engine.py) calls `_hybrid_search(user_question)` then later builds `standalone_q` for the LLM only. |
| How it should work after implementation | Reorder: build `standalone_q` first (cheap when no history), then `_hybrid_search(standalone_q)`; fallback to raw question if rewrite fails. |
| Files or components involved | [`rag_engine.py`](../backend/rag_engine.py) only (small change, high impact). |
| Dependencies or prerequisites | None; should be done early alongside retrieval tuning. |

---

### 3.12 Stronger Embeddings (Optional)

| Aspect | Specification |
|--------|----------------|
| What it is | Upgrade from `all-MiniLM-L6-v2` to a larger or domain-fine-tuned text embedding model. |
| Why it is needed | Jargon, acronyms, and paraphrased questions underperform with the small general model (see limitations §3.2). |
| What the current system does instead | CPU-friendly MiniLM for all Chroma vectors. |
| How it should work after implementation | Configurable `EMBEDDING_MODEL`; background re-index job; optional dual-write during migration. |
| Files or components involved | [`rag_engine.py`](../backend/rag_engine.py), ingest path (re-embed on upload). |
| Dependencies or prerequisites | GPU or latency acceptance; full corpus re-embed. |

---

## 4. Technology Additions Required

| Group | Additions |
|-------|-----------|
| Backend | JWT (`python-jose` / `PyJWT`), `passlib`/`bcrypt`, SQLAlchemy + Alembic (optional), workspace schema, SSE/WebSockets, Redis pub/sub for ingest progress, `sentence-transformers` cross-encoder, citation payload on `/get-answer`, grounding evaluator, document registry, optional stronger embedding model config. |
| Frontend | Auth screens, protected routes, workspace selector, SSE/WebSocket client, streaming chat state, document management page, **source cards / footnotes**, confidence badge. |
| Infrastructure | Chroma HTTP with health probes; Redis; secrets for JWT and Slack; proxy for SSE/WebSockets; align `CHROMA_*` across local and Docker; optional PostgreSQL; observability for Celery, Chroma, and retrieval metrics. |

---

## 5. Migration and Backward Compatibility Notes

Identity and scoping require data migration. Sessions under `anonymous` need a legacy owner or `legacy-shared` workspace. Chroma documents lack `workspace_id` today—default workspace assignment for existing metadata.

| Enhancement | Compatibility impact |
|-------------|----------------------|
| Authentication and RBAC | Schema + session ownership; needs legacy user strategy. |
| Workspace scoping | Metadata migration or default workspace for all existing chunks. |
| Real-time ingestion progress | Additive; polling can remain temporarily. |
| Chroma HTTP hardening | Additive; enforce same env for API and worker. |
| Document versioning | Requires cleanup of duplicate chunk sets per `source_name`. |
| Follow-up retrieval fix (§3.12) | Behavior change only; low risk, no schema change. |
| Citations (§3.11) | Additive fields on API response; UI can ignore until ready. |
| Cross-encoder reranking | Additive; feature-flag recommended. |
| Stronger embeddings (§3.12) | Requires re-embedding entire corpus. |
| Answer streaming | Additive if non-streaming endpoint kept. |
| Document management UI | Additive; most valuable after §3.5. |
| Hallucination detection | Additive warning metadata on responses. |

---

## 6. Suggested Implementation Order

Priorities reflect [DeepContext_Limitations.md](./DeepContext_Limitations.md): **trust and retrieval fixes before polish**.

| Phase | Recommendation | Reason |
|-------|----------------|--------|
| Phase 1 | Multi-user authentication with RBAC | Foundation for upload/delete policy and session ownership. |
| Phase 2 | Workspace scoping | Stops cross-team corpus bleed before more documents accumulate. |
| Phase 3 | ChromaDB HTTP hardening | Reliable shared index for workers and API. |
| Phase 4 | Document versioning (§3.5) | Stops hidden duplicate vectors on re-upload. |
| Phase 5 | **Follow-up retrieval fix (§3.12)** | Small code change; improves chat quality immediately. |
| Phase 6 | **Inline citations (§3.11)** | Addresses biggest trust gap vs user expectations. |
| Phase 7 | Document management UI | Useful once versioning and workspace metadata exist. |
| Phase 8 | Real-time ingestion progress | Better ops UX on stable ingest pipeline. |
| Phase 9 | Answer streaming | Visible UX win after auth/transport patterns exist. |
| Phase 10 | Hybrid reranking (§3.6) | Measure on internal Q&A set after scoping is stable. |
| Phase 11 | Evaluation / hallucination detection (§3.9) | Calibrate thresholds after rerank + citations exist. |
| Optional | Stronger embeddings (§3.12) | If benchmarks show MiniLM ceiling on domain jargon. |

---

## 7. Limitations → Enhancement Mapping

Quick map for planning discussions with leadership:

| Limitation (see companion doc) | Primary enhancement |
|--------------------------------|---------------------|
| No citations / verification | §3.11 |
| Follow-up questions fail retrieval | §3.12 |
| Re-upload duplicate vectors | §3.5 |
| Shared corpus / no auth | §3.1, §3.2 |
| Weak semantic match (MiniLM) | §3.6, §3.13 |
| Hallucination / over-confidence | §3.10, §3.11 |
| Coarse ingest status | §3.3 |
| Meeting summary-only index | Future: dual-index raw + summary (not yet specced in §3—consider Phase 11+ ingest extension) |

---

This rollout sequence builds **security and data boundaries** first, then **trust (citations + retrieval fix)**, then **scale and quality** (streaming, reranking, enrichment, evaluation).
