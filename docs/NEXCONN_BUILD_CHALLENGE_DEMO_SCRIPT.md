# DeepContext — Nexconn Build Challenge Demo Script

Target length: **2 minutes 58 seconds** at roughly **135 spoken words per minute**. Speak naturally, avoid rushing, and leave a short pause after each major UI result appears. Keep two isolated browser sessions ready: sign in as the **Owner** in a normal Chrome/Firefox window and as the **Viewer** in an Incognito/Private window. Two ordinary windows of the same browser will not work because they share the same authentication cookie. A second browser or a separate browser profile is also suitable. Use an HTTPS deployment or `localhost` so microphone access works.

## Before recording

- Activate both **Chat Subscription** and **Call Subscription** for the Nexconn application.
- Open the same workspace in two isolated sessions. Recommended options:
  - Owner in normal Chrome and Viewer in Chrome Incognito (`Ctrl+Shift+N`).
  - Owner in Chrome and Viewer in Firefox Private Browsing (`Ctrl+Shift+P`).
  - Two separate Chrome profiles.
- Confirm that the top-right account label shows **Owner** in one session and **Viewer** in the other before recording.
- Upload and finish indexing `01_q3_audit_report.md`, `03_product_requirements.md`, and `04_system_architecture.md`.
- Upload `05_executive_compensation_private.md` as **Admins and owner**.
- Keep the Viewer session on the Nexconn tab and the Owner session on the AI assistant tab.
- Test the prompts once so Render is awake and the model is warm.

## Timed recording

### 0:00–0:18 — The problem and solution

**On screen:** Show the landing page, sign in, and pause on the three-panel workspace.

**Say:**

“Company knowledge is scattered across files and conversations, but sensitive information cannot be searchable by everyone. DeepContext is a secure knowledge workspace combining permission-aware AI with Nexconn real-time collaboration. Teams can upload trusted material, ask grounded questions, inspect the evidence, and immediately discuss the result without leaving the workspace.”

### 0:18–0:40 — What we built it with

**On screen:** Slowly point across the document sidebar, AI chat, and Workspace Tools panel. Optionally overlay the architecture diagram.

**Say:**

“The interface is React and Vite, deployed on Vercel. FastAPI runs on Render. Neon PostgreSQL stores accounts, workspaces, audit data, and pgvector embeddings; Neon Object Storage keeps original files private; and Upstash Redis tracks background progress. Groq-hosted Llama models and LangGraph power generation and fact-check reflection.”

### 0:40–1:02 — Authentication, workspaces, and access

**On screen:** Open Settings. Show invitation, members, roles, and the access selector on a document.

**Say:**

“A signed JWT session identifies both the user and active workspace. Owners invite viewers, members, editors, or admins. Every document receives normalized user, group, and role ACL tokens. Those permissions are applied inside the pgvector query before top-K retrieval, so unauthorized chunks, titles, and file existence never reach the model.”

### 1:02–1:26 — Secure ingestion and review

**On screen:** Select two different files, start upload, show independent progress, then open the Review queue.

**Say:**

“The multi-file uploader supports documents, Office files, images, and diagrams, with a separate result for every file. FastAPI validates and stores each original, then the ingestion pipeline extracts text, chunks it, creates embeddings, and replicates its ACL onto every chunk. Member uploads require review; editor, admin, and owner uploads can index immediately.”

### 1:26–1:55 — RAG, reflection, citations, and security

**On screen:** Ask `Summarize the Q3 audit findings and cite the evidence.` Let the loading steps appear, then open Citations. In the Viewer session ask `What is the executive compensation?`

**Say:**

“For each question, DeepContext combines semantic pgvector search with BM25 keyword ranking. The LangGraph flow retrieves permitted evidence, drafts with Groq, verifies the answer, and streams it to the UI. Citations show the exact source files and passages. Users can also at-mention specific files. Here the viewer receives a uniform refusal for compensation data, proving retrieval security rather than prompt-only filtering.”

### 1:55–2:12 — Context map and contribution scoring

**On screen:** Send `/extract_diagram show the system architecture`, open Context map and History, then point to the leaderboard.

**Say:**

“Mermaid and PlantUML stored in documents become an interactive React Flow context map with saved history. The workspace leaderboard is also real: approved uploads earn points, and cited chunks reward the original contributor.”

### 2:12–2:40 — Nexconn Chat SDK

**On screen:** Switch both isolated sessions to Nexconn. Show online members. Type as Viewer, mention Owner, send, edit, and attach a file.

**Say:**

“Nexconn is deeply integrated, not embedded as a separate page. The backend uses the App Secret to issue safe SDK sessions and derives one stable Nexconn group per workspace; the secret never reaches the browser. Nexconn Chat provides live presence, typing indicators, named senders, mentions, editable messages, and file sharing. A shared knowledge file becomes a governed proposal that an editor can approve for ingestion.”

### 2:40–2:53 — Nexconn Call SDK

**On screen:** Start **Huddle** as Owner and join from Viewer. Pause briefly with both participants visible.

**Say:**

“Nexconn Call adds an audio Huddle tied to that same authenticated workspace. The owner starts one active room, and teammates join it directly from the knowledge workflow.”

### 2:53–2:59 — Close

**On screen:** Return to the complete workspace view.

**Say:**

“DeepContext turns trusted knowledge into secure answers, visible evidence, and immediate team action—all powered by Nexconn.”

## Recording fallback

If a network service is slow, do not wait silently. Say, “This job continues safely in the background,” and move to an already indexed document. If Call Subscription is not active, show the Huddle control and explain that Nexconn error code `80006` means the subscription must be activated; do not present a simulated call as a working one.

