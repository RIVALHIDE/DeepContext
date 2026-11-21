# DeepContext judge video script

## Before recording

1. Open the deployed backend `/health` endpoint to wake the free Render service.
2. Create a fresh workspace named `Acme Knowledge Demo`.
3. Upload the files as described in `demo_data/README.md` and wait for **active**.
4. Keep two browser profiles ready: one Owner and one Viewer.
5. Run each prompt once before recording to warm the model and verify credentials.

## Suggested 3-minute flow

### 0:00–0:30 — Workspace and governance

Show JWT sign-in, the active workspace, document access labels, and the dynamic
leaderboard. Explain that every vector query is trimmed by workspace and ACL
before top-K ranking.

### 0:30–1:10 — Grounded answer and evidence

Ask: `Summarize the Q3 audit report and list every open action with its owner.`
Open Review → Citations and show the exact source and retrieved passages.

### 1:10–1:40 — Context map

Type `@`, select `04_system_architecture.md`, and send
`/extract_diagram architecture`. Open **Context map**, zoom or drag a node, then
open **History**. Send `/extract_diagram secure ingestion flow` to demonstrate a
second saved map.

### 1:40–2:20 — Approval and contributions

Upload a small file as a Member, approve it as an Editor, then refresh. Show that
the uploader receives points and the leaderboard is scoped to this workspace.

### 2:20–3:00 — Security proof

Show `05_executive_compensation_private.md` as Owner only. Ask about it as the
Owner, then repeat as Viewer. The second user must receive a policy refusal
without learning that the private file exists.

## Context map behavior

The Context map renders Mermaid or PlantUML blocks that were extracted during
ingestion. It does not turn arbitrary prose into a graph. Use one of the two
diagram commands above; each successful result is stored with that chat and can
be reopened from **History**.
