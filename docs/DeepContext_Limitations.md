# DeepContext — Known Limitations & Failure Modes

**Purpose:** This document lists where DeepContext can fail, produce incomplete answers, or generate incorrect information. It is intended for review with leadership and for planning mitigations. Each section describes the **risk**, **how it shows up in practice**, and **directional mitigations** (many are expanded in [Enhanced_Implementation_Features.md](./Enhanced_Implementation_Features.md)).

**Audience:** AI Team Lead, product owners, engineers  
**Last updated:** June 2026  
**Scope:** Current production-style behavior (shared corpus, Groq LLM, Chroma HTTP, Celery ingestion)

---

## 1. Executive Summary

DeepContext is a **retrieval-augmented** assistant: it searches uploaded documents, then asks an LLM to answer **only from retrieved text**. That design reduces—but does **not eliminate**—wrong answers.

The largest risks today fall into five buckets:

| # | Category | Why it matters |
|---|----------|----------------|
| 1 | **Trust & verification** | Answers are not automatically tied to verifiable source spans in the UI; users can treat fluent text as fact. |
| 2 | **Retrieval quality** | If the wrong chunks are retrieved (or none), the answer will be wrong, vague, or “I don’t know” even when the document contains the answer. |
| 3 | **LLM behavior** | The model can still paraphrase incorrectly, merge facts, or omit list items even when context is present. |
| 4 | **Data & access model** | One shared knowledge base with no login means cross-team noise, stale duplicates, and no confidentiality boundary. |
| 5 | **Ingestion fidelity** | OCR, chunking, and meeting summarization can lose or distort source content before it ever reaches retrieval. |

Use this document in discussions as: **“Here is where we can fail today”** → pick mitigations → prioritize in the enhancement roadmap.

---

## 2. When DeepContext Can Give Wrong or Misleading Answers

### 2.1 Hallucination and over-confidence

**What happens:** The answer chain is instructed not to invent facts, but the LLM (`llama-3.1-8b-instant` via Groq) can still:

- State a plausible detail that is **not** in the retrieved chunks  
- Combine two chunks incorrectly (wrong person, date, amount, or decision)  
- Return a confident paragraph when only partial evidence exists  

**There is no automated check** after generation that compares the answer to retrieved text and flags low confidence.

**User-visible symptom:** A well-written markdown answer that **sounds** correct but cannot be traced to a specific passage.

**Mitigation direction:** Post-answer grounding score, claim-level citations, “low confidence” badge, human review queue (see Enhanced doc §3.10).

---

### 2.2 “I don’t know” when the document actually has the answer

**What happens:** Retrieval returns weak or empty chunks → the model says it has no information. The system retries up to three times when the answer *looks* like “don’t know,” but retries use the **same** retrieved context.

**User-visible symptom:** “I couldn’t find relevant information” for questions that are answerable from an uploaded file.

**Common causes:**

- Query wording does not match chunk wording (synonyms, acronyms, typos)  
- Answer buried in a chunk that ranked below top 5  
- Chunk split across boundaries (tables, long lists, appendices)  
- **Follow-up questions:** retrieval runs on the **raw** user message *before* the standalone rewritten question is built, so pronouns like “What about their deadline?” may retrieve poorly  

**Mitigation direction:** Cross-encoder reranking, retrieve-then-rerank with standalone question, larger `k`, evaluation set per domain.

---

### 2.3 Wrong answer because the wrong document was retrieved

**What happens:** All uploads share **one** Chroma collection. Hybrid search (embeddings + BM25) may rank a similar but **wrong** document higher—especially when filenames, headings, or terminology overlap across teams or projects.

**User-visible symptom:** Answer cites the wrong policy, wrong meeting, or wrong product—still fluent and structured.

**Mitigation direction:** Workspace/department scoping, metadata filters (team, product, date), document registry, deduplication on re-upload.

---

### 2.4 Meeting transcripts: summary replaces source detail

**What happens:** Files whose names contain `meeting` or `transcript` are **not** stored as fine-grained chunks. The pipeline:

1. Extracts full text  
2. Runs `MeetingAgent` (larger LLM) to produce **one** markdown summary  
3. Indexes only that summary in the vector DB  

**Failure modes:**

- Participants, action items, or decisions **omitted or invented** in the summary  
- Follow-up questions needing **exact quotes** or timestamps cannot be answered faithfully  
- Long transcripts may exceed practical context for summarization in one pass  

**User-visible symptom:** “Who said X?” or “What was the exact wording?” cannot be answered reliably.

**Mitigation direction:** Store both summary + chunked raw transcript; optional dual-index; evaluation on participant/action-item recall.

---

### 2.5 No inline source citations in the current product

**What happens:** The API returns `answer` and optional `diagrams` only. The UI renders markdown; it does **not** show which chunk or page supported each sentence.

**Risk:** Users and reviewers cannot quickly verify claims. Documentation that mentions “citations” describes a **target** capability, not the current end-to-end behavior.

**Mitigation direction:** Return structured `sources[]` from retrieval; render footnotes or source cards in the chat UI.

---

## 3. Retrieval & Ranking Limitations

### 3.1 Fixed small context window to the LLM

- Only **top 5** fused chunks are passed to the answer model (after optional expansion from the same `source_name`).  
- Large documents may need more than five fragments; relevant text outside those chunks is invisible to the LLM.

### 3.2 Embedding model ceiling

- Embeddings use `sentence-transformers/all-MiniLM-L6-v2` (compact, fast, CPU-friendly).  
- Enterprise jargon, rare acronyms, and cross-language nuance are weaker than larger embedding models.

### 3.3 Hybrid search design constraints

| Limitation | Impact |
|------------|--------|
| BM25 rebuilt over **entire collection** on each question | Latency and memory grow with corpus size; not ideal at large scale |
| Semantic results filtered by distance `< 3.2` | Arbitrary threshold may drop valid chunks or keep weak ones |
| Reciprocal Rank Fusion only (no cross-encoder) | First-stage ranking errors propagate to the LLM |
| No workspace / ACL filter in query | Cannot restrict search to “my team’s docs” |

### 3.4 Chunking strategy

- Chunks: **3000 characters**, **250 overlap** (`RecursiveCharacterTextSplitter`).  
- Tables, numbered procedures, and legal clauses may be **split mid-structure**, hurting both retrieval and comprehension.  
- Diagram code is stripped from prose chunks and stored separately—good for diagrams, but surrounding explanatory text may lose linkage.

### 3.5 Stale or duplicate knowledge

**Important distinction:** `GET /retriveAllDocuments` uses a `set` on `source_name`, so the **document list in the UI shows each filename only once**. That does **not** mean there is only one copy in the vector database.

What actually happens on re-upload:

1. **Ingestion** (`supervisor.py`) calls `vector_db.add_documents(...)` — it **never deletes** older chunks for that file first.  
2. **Chroma** then holds **two (or more) full sets of chunks** with the same `source_name` but different `ingested_at` timestamps and different vector IDs.  
3. **The list API** still shows one row per name because it deduplicates by `source_name` only (and may show `ingested_at` from whichever chunk metadata is seen first in the loop—not necessarily the latest upload).  
4. **`_hybrid_search`** searches **all chunks** in the collection, so retrieval can return text from **both** the old and new upload in the same answer.

**User-visible symptoms:**

- Sidebar shows **one** document name after re-upload, but answers may mix old and new policy text.  
- `deleteDocument` removes **all** chunks matching that `source_name` (good), but until then duplicates remain hidden from the list.  
- Users must know the exact indexed filename to delete.

**Mitigation direction:** On re-upload, detect same logical document and replace/archive old chunk IDs before indexing the new version (see Enhanced doc §3.5).

---

## 4. Ingestion & Document Processing Limitations

### 4.1 Supported formats only

Supported: `.txt`, `.md`, `.pdf`, images (`.jpg`, `.jpeg`, `.png`), `.puml`, `.mmd`, `.mermaid`.

**Not supported (today):** Word (`.docx`), PowerPoint, Excel, HTML, email archives, audio/video transcripts (unless pre-converted to text), encrypted PDFs.

### 4.2 PDF and image extraction failures

| Scenario | Failure mode |
|----------|----------------|
| Text PDF with &lt; 50 characters detected | Treated as “scanned” → per-page vision OCR (slower, costly) |
| Scanned / handwritten / low DPI | Vision model misreads text → garbage or `[unreadable]` in index |
| Multi-column or complex layouts | Reading order errors → wrong chunk content |
| Password-protected PDF | Ingestion error; empty return from ingestor |

OCR path uses a **different** Groq vision model than the Q&A model; quality and terminology handling may differ.

### 4.3 Silent or coarse ingestion errors

- Exceptions in `ingestion_documents` log and return `[]` → worker may surface as “no content extracted.”  
- Job status API only reports `processing` / `completed` / `failed`—not **which stage** failed (OCR, chunking, Chroma write).  
- Frontend polls every ~2 seconds; no granular progress.

### 4.4 Filename and storage quirks

- Upload path: `./data/{original_filename}` → **name collision** overwrites file on disk while old vectors may remain.  
- Meeting detection is **filename heuristic only** (`meeting` / `transcript` in name)—misnamed files skip or enter wrong pipeline.

### 4.5 Slack ingestion

- Same shared corpus; no mapping from Slack user/channel to workspace or ACL.  
- Download failures return `"Download Failed"` without rich operator diagnostics.

---

## 5. Security, Privacy, and Governance Limitations

### 5.1 No authentication or authorization

- All API usage is under a hardcoded **`anonymous`** user for sessions.  
- **Anyone** who can reach the API can upload, query, list, and delete documents (by source name).  
- No audit trail of *who* uploaded or asked what.

**Failure mode for the organization:** Confidential documents in a shared index visible to all users of the deployment.

### 5.2 Single shared corpus

- No department/workspace isolation.  
- Retrieval “noise” increases as unrelated documents accumulate.  
- Cannot enforce “HR docs only for HR role” without architectural change.

### 5.3 External dependencies and data egress

| Dependency | Risk |
|------------|------|
| **Groq API** | Questions, document chunks, and images sent to third-party LLM; outage = no answers / no OCR |
| **plantuml.com** | PlantUML diagram PNG URLs generated client-side; diagram **source code** leaves the network for rendering |
| **Slack API** | File content pulled into backend storage |

### 5.4 SQLite session store

- Chat history in SQLite suits dev/light use; **limited concurrent write** scalability for many users.

---

## 6. Conversation & UX Limitations

### 6.1 Limited chat history for context

- Only the **last 6** messages are used to rewrite follow-up questions.  
- Older thread context is ignored for disambiguation.

### 6.2 Standalone question rewrite can fail

- A separate LLM step rewrites follow-ups into standalone questions.  
- Known garbage patterns are filtered, but rewrite can still be wrong → retrieval uses the **original** question anyway (see §2.2).

### 6.3 Answer generation ignores chat history

- By design, the final answer uses **retrieved documents only** (reduces history-driven hallucination).  
- Trade-off: if retrieval fails on a follow-up, the model cannot “remember” facts from earlier turns unless they exist in retrieved chunks.

### 6.4 Small-talk vs document questions

- Short greetings map to canned responses (no retrieval).  
- Borderline phrases may be misclassified; longer “hello, can you summarize X” still goes through RAG.

### 6.5 No streaming

- Full answer generated before UI updates → long waits; users may assume a hang or retry (duplicate questions).

---

## 7. Diagram-Specific Limitations

### 7.1 Diagram intent detection is keyword-based

- Requests must mention diagram-related terms (`mermaid`, `plantuml`, `flowchart`, etc.).  
- Natural phrasing (“show me the onboarding flow from the architecture doc”) may not trigger diagram mode.

### 7.2 Wrong or empty diagram

- Diagrams are loaded from sources already retrieved for the text question—if retrieval picked the wrong file, the wrong diagram appears.  
- Title token matching can return **no** diagram when multiple exist with similar names, or the wrong one when titles overlap.

### 7.3 PlantUML operational dependency

- Rendering uses **public** PlantUML servers → unavailable offline, blocked networks, or policy restrictions break previews.  
- Sensitive architecture diagrams should be treated as **data leaving the perimeter** when rendered.

### 7.4 Mermaid client-side only

- Invalid mermaid syntax fails in the browser; no server-side validation or repair loop.

---

## 8. Infrastructure & Operational Limitations

### 8.1 Chroma visibility between processes

- API and Celery worker must share the same Chroma HTTP endpoint and collection name.  
- Misconfigured `CHROMA_HOST` / `CHROMA_PORT` / `CHROMA_COLLECTION_NAME` (e.g. local vs Docker defaults) → “upload succeeded but Q&A sees nothing.”  
- Engine refreshes Chroma handle before each answer; workers must complete writes before queries—race windows still possible under load.

### 8.2 Model and API volatility

- Answer model: `llama-3.1-8b-instant`  
- Ingestion OCR: `meta-llama/llama-4-scout-17b-16e-instruct`  
- Meeting summary: `llama-3.3-70b-versatile`  

Different models across stages → **inconsistent** extraction vs answering behavior. Groq rate limits or model deprecation affects production without code changes.

### 8.3 Resource limits

- Embeddings on **CPU**; large ingestion batches compete with query latency on same host.  
- Scanned PDF processing loads pages at 150 DPI—memory spikes on large files.

### 8.4 Observability gaps

- No centralized metrics for: retrieval hit rate, latency per stage, hallucination flags, ingestion failure reasons.  
- Debugging wrong answers requires log inspection (`standalone_q`, retrieved preview prints).

---

## 9. Failure Mode Quick Reference (For Discussion)

Use this table in meetings to connect **user report** → **likely root cause** → **roadmap item**.

| User says… | Likely cause | First mitigation to discuss |
|------------|--------------|-----------------------------|
| “It made up a number/name.” | LLM hallucination; no grounding check | Evaluation + confidence badge + citations |
| “The doc has it but the bot said no.” | Retrieval miss; chunking; wrong `k` | Reranker; standalone-q retrieval; reindex corpus |
| “It mixed two projects.” | Shared corpus; wrong top chunks | Workspace scoping |
| “Old and new policy blended.” | Duplicate versions in index | Document versioning on re-upload |
| “Meeting bot missed an action item.” | Summary-only index | Store raw transcript chunks + summary |
| “Follow-up question failed.” | Pronoun query + retrieval before rewrite | Retrieve using standalone question |
| “Diagram didn’t show.” | Keyword intent / title match / wrong source | Better intent model; tie diagram to source metadata |
| “We can’t use this for confidential HR.” | No auth / shared index | Auth + RBAC + workspace isolation |
| “Upload worked yesterday, not today.” | Chroma config / collection mismatch | Standardize Chroma ops + health checks |

---

## 10. Suggested Discussion Agenda (30 minutes)

1. **Risk appetite:** Which failure modes are unacceptable for pilot vs production? (confidentiality vs accuracy vs availability)  
2. **Top 3 mitigations:** e.g. workspace scoping + citations + hallucination flag  
3. **Evaluation:** Define 20–50 real internal questions with expected sources; measure retrieval hit rate before tuning prompts  
4. **Ownership:** Who approves documents for ingestion; who reviews flagged low-confidence answers  
5. **Timeline:** Align with phased plan in [Enhanced_Implementation_Features.md](./Enhanced_Implementation_Features.md)

---

## 11. Related Documents

| Document | Use |
|----------|-----|
| [Enhanced_Implementation_Features.md](./Enhanced_Implementation_Features.md) | Planned features that address many limitations above |
| [README.md](../README.md) | Setup, architecture, supported file types |
| `backend/rag_engine.py` | Retrieval, prompting, diagram branch |
| `backend/ingestor.py` | Chunking, OCR, diagram extraction |
| `backend/supervisor.py` | Standard vs meeting ingestion paths |

---

*This list reflects the codebase as of June 2026. Revisit after major releases (auth, workspaces, reranking, citations).*
