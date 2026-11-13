# DeepContext — Frontend Enhancement Implementation Plan (Web Only)

**Scope lock-in for this plan:**
- Web (desktop browser) only. No mobile-specific components, no PWA, no responsive drawer logic.
- Zero backend changes. Every file touched lives under `frontend/`. No API contract, route, payload shape, or `backend/` file is modified.
- Zero new npm dependencies. Fonts are loaded via a CDN `@import`, animation is hand-rolled CSS/SVG — no animation libraries, no icon-pack additions beyond the `lucide-react` you already have.
- This document is the single source of truth for the redesign. Hand it to whoever implements it (human or agent) — it contains every file to touch, every file to leave alone, full code for new components, and the order of work.

---

## 1. Brand Direction

**Name of the visual identity:** *Deep Signal* — a sonar metaphor (sending a pulse deep into your documents, getting signal back). This deliberately does **not** copy Claude's warm-orange breathing dot. It uses a cool, precise teal/violet palette that reads as "enterprise intelligence tool," not "consumer chatbot."

| Element | Choice |
|---|---|
| Primary brand color | `#00C9B1` (Spectral Teal) |
| Glow / active accent | `#00F5D4` |
| Secondary accent | `#7C3AED` (violet — used for version badges, citation highlights) |
| Background | `#090E1A` → `#1C2A4E` surface scale (darker than your current `#0f172a`/`#1e293b`, more depth) |
| Logo concept | "SonarGlyph" — concentric rings + core dot, idle when resting, animated sonar pulse while thinking/generating |

---

## 2. Fonts (decided)

| Use | Font | Why |
|---|---|---|
| UI text (body, headings, buttons) | **Inter** (variable weight) | Industry-standard for enterprise SaaS UI, excellent legibility at small sizes, free, loads fast, huge glyph coverage |
| Code blocks / mono content (diagram code, citations, IDs) | **JetBrains Mono** | Distinct from body text, designed for code readability, pairs well with Inter, free |

**Loading method:** one `@import` line at the very top of `src/index.css`, before the Tailwind import. No `package.json` changes, no Vite config changes, no build step changes.

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@import "tailwindcss";
```

Then set the font family once, globally, in the same file:

```css
:root {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

code, pre, kbd {
  font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
}
```

If your network policy blocks external font CDNs in production, the fallback is to `npm install @fontsource/inter @fontsource/jetbrains-mono` later — flagged here as a decision point, not required for this plan.

---

## 3. Design Tokens — `src/styles/tokens.css` (NEW FILE)

This file is imported once into `index.css`. Every other component reads colors from these CSS variables — nothing is hardcoded again after this.

```css
/* ═══════════════════════════════════════════════════
   DEEPCONTEXT — Design Token System
═══════════════════════════════════════════════════ */

:root {
  /* Brand */
  --dc-brand:        #00C9B1;
  --dc-brand-glow:   #00F5D4;
  --dc-brand-dim:    rgba(0, 201, 177, 0.12);
  --dc-brand-border: rgba(0, 201, 177, 0.28);

  --dc-violet:       #7C3AED;
  --dc-violet-dim:   rgba(124, 58, 237, 0.12);

  --dc-red:          #F43F5E;
  --dc-green:        #10B981;
  --dc-amber:        #F59E0B;

  /* Surfaces */
  --dc-bg:           #090E1A;
  --dc-surface-0:    #0D1526;
  --dc-surface-1:    #111D35;
  --dc-surface-2:    #162140;
  --dc-surface-3:    #1C2A4E;

  /* Text */
  --dc-text-primary:   #E2EAF4;
  --dc-text-secondary: #8FA3BF;
  --dc-text-muted:     #4A6180;
  --dc-text-inverse:   #090E1A;

  /* Borders */
  --dc-border:         rgba(255,255,255,0.07);
  --dc-border-strong:  rgba(255,255,255,0.13);

  /* Radii */
  --dc-radius-sm:  8px;
  --dc-radius-md:  12px;
  --dc-radius-lg:  18px;
  --dc-radius-xl:  24px;
  --dc-radius-full: 9999px;

  /* Motion */
  --dc-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --dc-ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
  --dc-duration-fast: 120ms;
  --dc-duration-base: 200ms;
  --dc-duration-slow: 350ms;

  /* Glow shadows */
  --dc-glow-brand:  0 0 24px rgba(0, 201, 177, 0.35), 0 0 8px rgba(0, 201, 177, 0.2);
  --dc-glow-violet: 0 0 20px rgba(124, 58, 237, 0.4);
  --dc-shadow-card: 0 4px 24px rgba(0, 0, 0, 0.4);
}
```

---

## 4. The Animated Logo — `src/components/brand/SonarGlyph.jsx` (NEW FILE)

This is the unique visual signature replacing the generic `Loader2` spinner everywhere. Three states: `idle`, `thinking`, `generating`. Pure SVG + CSS keyframes — no animation library.

```jsx
import React from 'react';

const BRAND = '#00C9B1';
const GLOW  = '#00F5D4';
const DIM   = 'rgba(0, 201, 177, 0.18)';

export default function SonarGlyph({ state = 'idle', size = 40, className = '' }) {
  const r    = size / 2;
  const cx   = r;
  const cy   = r;
  const core = size * 0.13;
  const arc1 = size * 0.24;
  const arc2 = size * 0.36;
  const arc3 = size * 0.46;

  const isThinking   = state === 'thinking';
  const isGenerating = state === 'generating';
  const isActive     = isThinking || isGenerating;

  const stateClass = isGenerating
    ? 'dc-sonar--generating'
    : isThinking
      ? 'dc-sonar--thinking'
      : '';

  return (
    <>
      <style>{`
        @keyframes dc-pulse-1 { 0%,100% { opacity:.85; r:${arc1}px; } 50% { opacity:.40; r:${arc1*1.12}px; } }
        @keyframes dc-pulse-2 { 0%,100% { opacity:.55; r:${arc2}px; } 50% { opacity:.20; r:${arc2*1.10}px; } }
        @keyframes dc-pulse-3 { 0%,100% { opacity:.30; r:${arc3}px; } 50% { opacity:.08; r:${arc3*1.08}px; } }
        @keyframes dc-sonar-ping { 0% { opacity:.9; r:${core}px; } 60% { opacity:.4; r:${arc3*0.85}px; } 100% { opacity:0; r:${arc3}px; } }
        @keyframes dc-core-breathe { 0%,100% { opacity:1; r:${core}px; } 50% { opacity:.6; r:${core*0.8}px; } }
        @keyframes dc-core-ping    { 0%,100% { opacity:1; r:${core}px; } 40% { opacity:.5; r:${core*0.7}px; } }

        .dc-sonar--thinking .dc-arc-1 { animation: dc-pulse-1 2.2s ease-in-out infinite; }
        .dc-sonar--thinking .dc-arc-2 { animation: dc-pulse-2 2.2s ease-in-out .3s infinite; }
        .dc-sonar--thinking .dc-core  { animation: dc-core-breathe 2.2s ease-in-out infinite; }

        .dc-sonar--generating .dc-arc-1 { animation: dc-pulse-1 1.4s ease-in-out infinite; }
        .dc-sonar--generating .dc-arc-2 { animation: dc-pulse-2 1.4s ease-in-out .22s infinite; }
        .dc-sonar--generating .dc-arc-3 { animation: dc-pulse-3 1.4s ease-in-out .44s infinite; }
        .dc-sonar--generating .dc-ping  { animation: dc-sonar-ping 1.4s ease-out infinite; }
        .dc-sonar--generating .dc-core  { animation: dc-core-ping 1.4s ease-in-out infinite; }
      `}</style>

      <svg
        width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        fill="none" className={`${stateClass} ${className}`}
        style={{ flexShrink: 0 }} aria-hidden="true"
      >
        {isActive && <circle cx={cx} cy={cy} r={r} fill={DIM} />}

        {isGenerating && (
          <circle className="dc-arc-3" cx={cx} cy={cy} r={arc3}
            stroke={BRAND} strokeWidth={size * 0.025} opacity={0.28} />
        )}

        <circle className="dc-arc-2" cx={cx} cy={cy} r={arc2}
          stroke={BRAND} strokeWidth={size * 0.03} opacity={isActive ? 0.5 : 0.22} />

        <circle className="dc-arc-1" cx={cx} cy={cy} r={arc1}
          stroke={BRAND} strokeWidth={size * 0.04} opacity={isActive ? 0.75 : 0.45} />

        {isGenerating && (
          <circle className="dc-ping" cx={cx} cy={cy} r={core} fill={GLOW} opacity={0} />
        )}

        <circle
          className="dc-core" cx={cx} cy={cy} r={core}
          fill={isActive ? GLOW : BRAND}
          style={{ filter: isActive ? `drop-shadow(0 0 ${size * 0.12}px ${GLOW})` : 'none' }}
        />

        <path
          d={`M ${cx} ${cy - arc2 * 0.9} A ${arc2 * 0.9} ${arc2 * 0.9} 0 0 1 ${cx} ${cy + arc2 * 0.9}`}
          stroke={GLOW} strokeWidth={size * 0.045} strokeLinecap="round"
          opacity={isActive ? 0.6 : 0.35} fill="none"
        />
      </svg>
    </>
  );
}
```

**Where each state is used:**
- `idle` → sidebar header logo, AI avatar next to completed messages, empty-state hero
- `thinking` → the moment a request is sent, before the first token arrives
- `generating` → while tokens are actively streaming in

---

## 5. File Inventory

### 5.1 New files to create

| File | Purpose |
|---|---|
| `src/styles/tokens.css` | Design tokens (Section 3) |
| `src/components/brand/SonarGlyph.jsx` | Animated logo (Section 4) |
| `src/components/brand/LogoLockup.jsx` | Logo + wordmark, used in sidebar header |
| `src/components/layout/Sidebar.jsx` | Extracted sidebar (logo, doc list, refresh) — desktop only |
| `src/components/chat/MessageBubble.jsx` | Redesigned human + AI chat bubble |
| `src/components/chat/ThinkingIndicator.jsx` | Replaces `Loader2` while waiting for first token |
| `src/components/chat/WelcomeScreen.jsx` | Empty-state screen shown when a session has zero messages |
| `src/components/docs/DocCard.jsx` | Redesigned document row for the sidebar |

### 5.2 Existing files to modify (logic untouched, only markup/styling/imports change)

| File | What changes |
|---|---|
| `src/index.css` | Add font `@import`, import `tokens.css`, rewrite `.markdown-content` rules with token-based styling |
| `src/App.jsx` | Replace inline Tailwind-only color classes with token-based styles; extract sidebar markup into `Sidebar.jsx`; use `LogoLockup` in the header; keep all existing state/handlers (`fetchDocs`, `handleDeleteDocument`, `handleIngestStart`, etc.) exactly as-is |
| `src/components/ChatWindow.jsx` | Swap the loose `<Loader2>` for `<ThinkingIndicator>`; render messages through `<MessageBubble>` instead of the inline `<div>` block; show `<WelcomeScreen>` when `messages.length === 0`; redesign the input bar (auto-grow textarea, glow border, Shift+Enter support) — **all streaming/fetch/session logic stays identical, this is a render-layer change only** |
| `src/components/IngestProgressBanner.jsx` | Replace hardcoded Tailwind color classes (`emerald-500`, `blue-500`, etc.) with `var(--dc-*)` tokens; swap step-dot colors to brand teal |
| `src/components/IngestSidebarRow.jsx` | Restyle using tokens; visually align with `DocCard` |
| `src/components/MarkdownRenderer.jsx` | No logic change — only relies on the new `.markdown-content` CSS rules added in `index.css` |
| `src/components/SourcePanel.jsx` | Swap hardcoded slate/blue Tailwind classes for `var(--dc-*)` tokens |
| `src/components/CitationBadge.jsx` | Swap highlight color to `var(--dc-violet)` instead of plain blue, for visual distinction from the brand teal |
| `src/components/DiagramRenderer.jsx` | Cosmetic only: header label color and border tokens updated; **zero change to Mermaid/PlantUML rendering logic** |

### 5.3 Files to NOT touch (frontend, but leave exactly as-is)

`src/main.jsx`, `src/utils/api.util.js`, `src/utils/chatSessions.util.js`, `src/utils/ingestProgress.util.js`, `src/utils/useCitationHighlight.js`, `src/components/ChatHistoryDrawer.jsx` (visual token pass only if time allows — not required for v1), `vite.config.js`, `eslint.config.js`, `package.json`, `package-lock.json`.

### 5.4 Backend — explicitly out of scope

No file under `backend/` is touched by this plan. No endpoint, payload, or response shape changes. Confirmed zero backend impact.

---

## 6. Component Code

### 6.1 `src/components/brand/LogoLockup.jsx` (NEW)

```jsx
import SonarGlyph from './SonarGlyph';

export default function LogoLockup({ state = 'idle', size = 34 }) {
  return (
    <div className="flex items-center gap-3 select-none">
      <SonarGlyph state={state} size={size} />
      <div className="flex flex-col leading-none">
        <span
          className="font-bold tracking-tight text-sm"
          style={{ color: 'var(--dc-text-primary)', letterSpacing: '-0.02em' }}
        >
          DeepContext
        </span>
        <span
          className="text-[10px] uppercase tracking-[0.16em] font-medium mt-0.5"
          style={{ color: 'var(--dc-brand)', opacity: 0.8 }}
        >
          Knowledge Engine
        </span>
      </div>
    </div>
  );
}
```

### 6.2 `src/components/chat/ThinkingIndicator.jsx` (NEW)

```jsx
import SonarGlyph from '../brand/SonarGlyph';

export default function ThinkingIndicator() {
  return (
    <div className="flex items-start gap-3 py-1">
      <SonarGlyph state="generating" size={32} />
      <div
        className="rounded-2xl rounded-tl-sm px-4 py-3 text-sm flex items-center gap-3"
        style={{
          background: 'var(--dc-surface-1)',
          border: '1px solid var(--dc-brand-border)',
          color: 'var(--dc-text-secondary)',
        }}
      >
        <span className="flex gap-1">
          {[0, 1, 2].map(i => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: 'var(--dc-brand)',
                animation: `dc-dot-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </span>
        <span style={{ color: 'var(--dc-text-muted)', fontSize: '12px' }}>
          Searching knowledge base…
        </span>
      </div>
      <style>{`
        @keyframes dc-dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%            { transform: translateY(-5px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
```

### 6.3 `src/components/chat/MessageBubble.jsx` (NEW)

```jsx
import MarkdownRenderer from '../MarkdownRenderer';
import SonarGlyph from '../brand/SonarGlyph';

export default function MessageBubble({ message }) {
  const isHuman = message.role === 'human';
  const isStreaming = message.streaming;

  if (isHuman) {
    return (
      <div className="flex justify-end mb-4">
        <div
          className="max-w-[78%] px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap rounded-2xl rounded-br-sm"
          style={{
            background: 'linear-gradient(135deg, #0E7966 0%, #0A6358 100%)',
            color: '#E2F7F4',
            boxShadow: '0 2px 12px rgba(0,201,177,0.15)',
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 mb-5">
      <div className="shrink-0 mt-0.5">
        <SonarGlyph state={isStreaming ? 'generating' : 'idle'} size={28} />
      </div>

      <div
        className="flex-1 max-w-[84%] rounded-2xl rounded-tl-sm px-4 py-3 overflow-hidden"
        style={{
          background: 'var(--dc-surface-1)',
          border: `1px solid ${isStreaming ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
          boxShadow: isStreaming ? '0 2px 16px rgba(0,201,177,0.08)' : 'none',
          transition: 'border-color 0.3s, box-shadow 0.3s',
        }}
      >
        <MarkdownRenderer
          content={message.content}
          diagrams={message.diagrams || []}
          sources={message.sources || []}
        />
        {isStreaming && (
          <span
            className="inline-block w-0.5 h-4 ml-0.5 rounded-full align-text-bottom"
            style={{ background: 'var(--dc-brand)', animation: 'dc-cursor-blink 0.9s ease-in-out infinite' }}
          />
        )}
      </div>

      <style>{`
        @keyframes dc-cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}
```

**Integration note for `ChatWindow.jsx`:** replace the existing inline message-rendering block —

```jsx
{messages.map((m, i) => (
  <div key={i} className={`flex ${m.role === 'human' ? 'justify-end' : 'justify-start'}`}>
    ...
  </div>
))}
{isTyping && <Loader2 className="animate-spin text-blue-500" />}
```

— with —

```jsx
{messages.length === 0 && !isTyping
  ? <WelcomeScreen onSuggestion={(text) => { setInput(text); }} />
  : messages.map((m) => <MessageBubble key={m.id ?? `${m.role}_${m.content?.slice(0,20)}`} message={m} />)
}
{isTyping && <ThinkingIndicator />}
```

No other state, fetch, or streaming logic in `ChatWindow.jsx` changes.

### 6.4 `src/components/chat/WelcomeScreen.jsx` (NEW)

```jsx
import SonarGlyph from '../brand/SonarGlyph';

const SUGGESTIONS = [
  'Summarize the Q3 audit report',
  'Show me the system architecture diagram',
  "What were the action items from last week's meeting?",
  'Compare the old and new product requirements',
];

export default function WelcomeScreen({ onSuggestion }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
      <SonarGlyph state="idle" size={64} className="mb-6" />
      <h2 className="text-2xl font-bold mb-2 tracking-tight" style={{ color: 'var(--dc-text-primary)' }}>
        What do you need to know?
      </h2>
      <p className="text-sm mb-8 max-w-sm leading-relaxed" style={{ color: 'var(--dc-text-muted)' }}>
        Ask anything about your organization's uploaded documents.
        DeepContext searches your knowledge base and answers precisely.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl">
        {SUGGESTIONS.map((text, i) => (
          <button
            key={i}
            onClick={() => onSuggestion?.(text)}
            className="text-left text-xs px-4 py-3 rounded-xl transition-all"
            style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)', color: 'var(--dc-text-secondary)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--dc-brand-border)'; e.currentTarget.style.background = 'var(--dc-brand-dim)'; e.currentTarget.style.color = 'var(--dc-brand)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--dc-border)'; e.currentTarget.style.background = 'var(--dc-surface-1)'; e.currentTarget.style.color = 'var(--dc-text-secondary)'; }}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
```

### 6.5 `src/components/docs/DocCard.jsx` (NEW)

```jsx
import { Trash2, Loader2 } from 'lucide-react';

export default function DocCard({ doc, onDelete, isDeleting }) {
  const statusColor = doc.status === 'active' ? 'var(--dc-green)' : 'var(--dc-amber)';

  return (
    <div
      className="group relative rounded-xl px-3 py-2.5 transition-all"
      style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--dc-border-strong)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--dc-border)'}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium truncate flex-1" style={{ color: 'var(--dc-text-primary)' }}>
          {doc.name}
        </span>
        {doc.version && (
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded-md shrink-0"
            style={{ background: 'var(--dc-violet-dim)', color: 'var(--dc-violet)', border: '1px solid rgba(124,58,237,0.25)' }}
          >
            v{doc.version}
          </span>
        )}
        <button
          onClick={() => onDelete(doc.name)}
          disabled={isDeleting}
          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          style={{ color: 'var(--dc-text-muted)' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--dc-red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--dc-text-muted)'}
          aria-label={`Delete ${doc.name}`}
        >
          {isDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor }} />
          <span className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>{doc.status}</span>
        </div>
        <span className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>
          {doc.time ? String(doc.time).split(' ')[0] : '—'}
        </span>
      </div>
    </div>
  );
}
```

### 6.6 `src/components/layout/Sidebar.jsx` (NEW — extracted from `App.jsx`)

This wraps the **exact same** doc-list markup currently inline in `App.jsx`, just using `DocCard` and `LogoLockup`. `App.jsx` keeps every piece of state (`docs`, `deletingDocName`, `docActionMessage`, `fetchDocs`, `handleDeleteDocument`) — it just passes them down as props instead of inlining JSX.

```jsx
import { RefreshCw } from 'lucide-react';
import LogoLockup from '../brand/LogoLockup';
import DocCard from '../docs/DocCard';
import IngestSidebarRow from '../IngestSidebarRow';

export default function Sidebar({
  docs,
  docActionMessage,
  ingestState,
  isIngestActive,
  deletingDocName,
  onDelete,
  onRefresh,
}) {
  const showEmptyDocs = (!docs || docs.length === 0) && !isIngestActive;

  return (
    <>
      <div
        className="p-6 border-b flex items-center"
        style={{ borderColor: 'var(--dc-border)' }}
      >
        <LogoLockup state="idle" size={32} />
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <h2
          className="text-[10px] font-semibold mb-4 uppercase tracking-widest"
          style={{ color: 'var(--dc-text-muted)' }}
        >
          Knowledge Base
        </h2>

        {docActionMessage && (
          <p className="mb-3 text-[11px]" style={{ color: 'var(--dc-text-secondary)' }}>
            {docActionMessage}
          </p>
        )}

        <div className="space-y-2">
          {isIngestActive && <IngestSidebarRow ingestState={ingestState} />}

          {showEmptyDocs && (
            <div
              className="rounded-xl border border-dashed p-4 text-xs"
              style={{ borderColor: 'var(--dc-border-strong)', color: 'var(--dc-text-muted)' }}
            >
              No documents available.
            </div>
          )}

          {docs?.map((doc, i) => (
            <DocCard
              key={i}
              doc={doc}
              onDelete={onDelete}
              isDeleting={deletingDocName === doc.name}
            />
          ))}
        </div>
      </div>

      <button
        onClick={onRefresh}
        type="button"
        title="Refresh document list"
        className="p-4 border-t flex items-center gap-2 transition"
        style={{ borderColor: 'var(--dc-border)', color: 'var(--dc-text-secondary)' }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--dc-text-primary)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--dc-text-secondary)'}
      >
        <RefreshCw size={16} /> <span className="text-xs">Refresh</span>
      </button>
    </>
  );
}
```

**`App.jsx` change:** replace the entire `<aside className="w-72 ...">...</aside>` block with:

```jsx
<aside
  className="w-64 flex-shrink-0 flex flex-col"
  style={{ background: 'var(--dc-surface-0)', borderRight: '1px solid var(--dc-border)' }}
>
  <Sidebar
    docs={docs}
    docActionMessage={docActionMessage}
    ingestState={ingestState}
    isIngestActive={isIngestActive}
    deletingDocName={deletingDocName}
    onDelete={handleDeleteDocument}
    onRefresh={fetchDocs}
  />
</aside>
```

Everything else in `App.jsx` (`useState`, `useEffect`, `fetchDocs`, `handleDeleteDocument`, `handleIngestStart/Event/Complete/Failed`, `<ChatWindow>` usage) is unchanged.

### 6.7 Redesigned input bar (inside `ChatWindow.jsx`, replaces the current `<div className="relative">` block)

```jsx
<div
  className="relative flex items-end gap-3 rounded-2xl p-2"
  style={{
    background: 'var(--dc-surface-1)',
    border: `1px solid ${input.trim() || isTyping ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
    boxShadow: input.trim() ? '0 0 0 3px rgba(0,201,177,0.08)' : 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  }}
>
  <textarea
    value={input}
    onChange={(e) => {
      setInput(e.target.value);
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
    }}
    onKeyDown={(e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      if (e.key === 'Escape' && isTyping) {
        cancelStreaming();
      }
    }}
    placeholder={
      isIngesting ? 'Document ingestion in progress…'
      : isTyping  ? 'Press Esc to stop…'
                  : 'Ask your knowledge base…  (Shift+Enter for new line)'
    }
    disabled={isIngesting}
    rows={1}
    className="flex-1 resize-none bg-transparent text-sm leading-relaxed focus:outline-none custom-scrollbar"
    style={{ color: 'var(--dc-text-primary)', minHeight: '36px', maxHeight: '140px' }}
  />

  <button
    type="button"
    onClick={isTyping ? cancelStreaming : sendMessage}
    disabled={isIngesting || (!isTyping && !input.trim())}
    className="shrink-0 flex items-center justify-center w-9 h-9 rounded-xl transition-all"
    style={{
      background: isTyping ? 'var(--dc-red)' : (input.trim() && !isIngesting) ? 'var(--dc-brand)' : 'var(--dc-surface-2)',
      color: (isTyping || (input.trim() && !isIngesting)) ? 'var(--dc-text-inverse)' : 'var(--dc-text-muted)',
      boxShadow: isTyping ? '0 0 16px rgba(244,63,94,0.4)' : (input.trim() ? 'var(--dc-glow-brand)' : 'none'),
    }}
    aria-label={isTyping ? 'Stop' : 'Send'}
  >
    {isTyping ? <Square size={15} strokeWidth={2.5} /> : <SendHorizontal size={15} strokeWidth={2.5} />}
  </button>
</div>
```

Note: switching from `<input>` to `<textarea>` changes the `onKeyDown` `Enter` behavior intentionally — Enter now sends, Shift+Enter inserts a newline. This is the one small UX-behavior change in this plan; flag it for sign-off if you want strict `Enter`-only-send parity instead.

---

## 7. Markdown Typography — additions to `src/index.css`

Add below the existing `.markdown-content` rules (do not delete the existing scrollbar/table rules — these are additive):

```css
.markdown-content {
  overflow-wrap: anywhere;
  line-height: 1.65;
  color: var(--dc-text-primary);
}

.markdown-content h1, .markdown-content h2, .markdown-content h3 {
  color: var(--dc-text-primary);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-top: 1.25em;
  margin-bottom: 0.5em;
}
.markdown-content h1 { font-size: 1.15rem; }
.markdown-content h2 { font-size: 1.05rem; }
.markdown-content h3 { font-size: 0.95rem; }

.markdown-content p { margin-bottom: 0.85em; }
.markdown-content p:last-child { margin-bottom: 0; }

.markdown-content code:not(pre code) {
  font-size: 0.82em;
  padding: 0.15em 0.45em;
  border-radius: 5px;
  background: rgba(0, 201, 177, 0.1);
  color: var(--dc-brand-glow);
  border: 1px solid rgba(0, 201, 177, 0.2);
}

.markdown-content pre {
  border-radius: 12px;
  background: var(--dc-surface-0) !important;
  border: 1px solid var(--dc-border-strong);
  padding: 1rem 1.15rem;
  overflow-x: auto;
  margin: 0.85em 0;
}
.markdown-content pre code {
  font-size: 0.8rem;
  color: var(--dc-text-primary);
  background: none;
  border: none;
  padding: 0;
}

.markdown-content table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin: 0.85em 0; }
.markdown-content th {
  background: var(--dc-surface-2);
  color: var(--dc-brand);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--dc-border-strong);
  text-align: left;
}
.markdown-content td {
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--dc-border);
  color: var(--dc-text-secondary);
  vertical-align: top;
}
.markdown-content tr:nth-child(even) td { background: var(--dc-surface-1); }

.markdown-content ul, .markdown-content ol { padding-left: 1.4em; margin-bottom: 0.85em; }
.markdown-content li { margin-bottom: 0.3em; color: var(--dc-text-secondary); }
.markdown-content li::marker { color: var(--dc-brand); }

.markdown-content blockquote {
  border-left: 3px solid var(--dc-brand);
  padding: 0.5em 1em;
  margin: 0.85em 0;
  background: var(--dc-brand-dim);
  border-radius: 0 8px 8px 0;
  color: var(--dc-text-secondary);
  font-style: italic;
}
```

---

## 8. Implementation Sequence

Work in this exact order — each phase is independently testable before moving to the next, and nothing in a later phase depends on skipping an earlier one.

### Phase 1 — Foundation (no visual change yet, just plumbing)
1. Create `src/styles/tokens.css` (Section 3).
2. Add the font `@import` + `import "./styles/tokens.css"` to the top of `src/index.css` (Section 2).
3. Build `SonarGlyph.jsx` and `LogoLockup.jsx` (Sections 4, 6.1).
4. Sanity check: drop `<LogoLockup state="generating" />` anywhere temporarily and confirm the sonar animation renders and the font looks like Inter, not the system default.

### Phase 2 — Sidebar
5. Build `DocCard.jsx` (Section 6.5).
6. Build `Sidebar.jsx` (Section 6.6), wire it into `App.jsx` per the snippet given.
7. Restyle `IngestSidebarRow.jsx` to use tokens (swap `bg-slate-800/50`, `border-slate-700`, etc. for `var(--dc-surface-1)`, `var(--dc-border)`).
8. Verify: upload a doc, confirm the ingest row and the resulting `DocCard` both render correctly, delete still works, refresh still works.

### Phase 3 — Chat surface
9. Build `MessageBubble.jsx`, `ThinkingIndicator.jsx`, `WelcomeScreen.jsx` (Sections 6.2–6.4).
10. In `ChatWindow.jsx`: swap the message-rendering block and the `Loader2` reference per Section 6.3's integration note.
11. Replace the input bar block per Section 6.7.
12. Verify: empty session shows `WelcomeScreen`, clicking a suggestion fills the input, sending a message shows `ThinkingIndicator` then streams into a `MessageBubble`, Escape still cancels streaming, Shift+Enter adds a newline instead of sending.

### Phase 4 — Supporting panels
13. Restyle `IngestProgressBanner.jsx`, `SourcePanel.jsx`, `CitationBadge.jsx`, `DiagramRenderer.jsx` headers using tokens (cosmetic only — no logic touched).
14. Apply the markdown typography CSS from Section 7.
15. Verify: a response with a diagram, a response with sources/citations, and a response with a markdown table all render with the new look and zero functional regressions.

### Phase 5 — Polish pass
16. Audit every remaining hardcoded Tailwind color class (`slate-`, `blue-`, `emerald-`, `rose-`) across the touched files and replace with the matching `var(--dc-*)` token for full visual consistency.
17. Final pass: confirm no `Loader2` from `lucide-react` remains anywhere it was previously used as the "AI is working" indicator — it should now only appear on small per-row spinners (delete button, refresh) where a tiny inline spinner is still appropriate.

---

## 9. Acceptance Checklist (use before calling this "done")

- [ ] No file under `backend/` was modified
- [ ] No new entries in `package.json` dependencies
- [ ] App still builds and runs with `npm run dev` with zero console errors
- [ ] Upload → ingest progress → document appears in sidebar still works end to end
- [ ] Send message → streaming tokens → final answer with sources/diagrams still works end to end
- [ ] Delete document still works
- [ ] New chat / chat history switching still works
- [ ] SonarGlyph shows `idle` at rest, `thinking`/`generating` only while waiting on or streaming a response
- [ ] Fonts visibly changed to Inter (UI) and JetBrains Mono (code blocks) in the browser
- [ ] No mobile-specific code, breakpoints, or PWA artifacts were introduced

---

## 10. Open Decision Logged (resolved per your last message)

| Decision | Resolution |
|---|---|
| Mobile/PWA work | Dropped entirely from this phase — desktop web only |
| Font choice | Inter (UI) + JetBrains Mono (code), loaded via Google Fonts CDN, zero new npm packages |
| Backend changes | None — explicitly out of scope, confirmed in Section 5.4 |
| Sidebar width | `w-64` (256px), down from current `w-72` (288px), to give the chat column more room |
| Enter-to-send behavior | Changed to Enter = send, Shift+Enter = newline (flagged in Section 6.7 if you want this reverted) |
