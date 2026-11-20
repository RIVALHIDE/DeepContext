import { useEffect, useRef, useState } from 'react';
import MarkdownRenderer from '../MarkdownRenderer';
import SonarGlyph from '../brand/SonarGlyph';
import { AtSign, Check, Pencil, RefreshCw, ShieldAlert, X } from 'lucide-react';

function renderHumanContent(content) {
  return String(content || '').split(/(@\[[^\]]+\])/g).map((part, index) => {
    if (!part.startsWith('@[') || !part.endsWith(']')) return part;
    return (
      <span key={`${part}-${index}`} className="mx-0.5 inline-flex max-w-64 items-center gap-1 rounded-full px-2 py-0.5 align-middle text-xs font-semibold" style={{ background: 'rgba(37, 99, 235, 0.12)', color: 'var(--dc-brand)' }}>
        <AtSign size={11} className="shrink-0" />
        <span className="truncate">{part.slice(2, -1)}</span>
      </span>
    );
  });
}

export default function MessageBubble({ message, documents = [], disabled = false, onEdit, onRetry }) {
  const isHuman = message.role === 'human';
  const isStreaming = message.streaming;
  const isBlocked = Boolean(message.blocked);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content || '');
  const editRef = useRef(null);

  useEffect(() => {
    if (isEditing) {
      editRef.current?.focus();
    }
  }, [isEditing]);

  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === String(message.content || '').trim()) {
      setIsEditing(false);
      return;
    }
    setIsEditing(false);
    onEdit?.(message.id, next);
  };

  if (isHuman) {
    return (
      <div className="group flex justify-end mb-4">
        <div className="flex max-w-[78%] flex-col items-end gap-1.5">
          <div
          className="w-full px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap rounded-2xl rounded-br-sm"
          style={{
            background: 'linear-gradient(135deg, #EFF6FF 0%, #E8F0FE 100%)',
            color: 'var(--dc-text-primary)',
            border: '1px solid var(--dc-brand-border)',
            boxShadow: '0 4px 14px rgba(37,99,235,0.08)',
          }}
        >
          {isEditing ? (
            <form onSubmit={(event) => { event.preventDefault(); saveEdit(); }} className="min-w-[260px]">
              <textarea
                ref={editRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setIsEditing(false);
                  } else if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    saveEdit();
                  }
                }}
                rows={Math.min(5, Math.max(1, draft.split('\n').length))}
                maxLength={4096}
                className="block max-h-36 min-h-10 w-full resize-none bg-transparent text-sm outline-none"
                aria-label="Edit your message"
              />
              <div className="mt-2 flex items-center justify-end gap-1.5 border-t pt-2" style={{ borderColor: 'var(--dc-brand-border)' }}>
                <span className="mr-auto text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>Enter to send · Shift+Enter for a new line</span>
                <button type="button" onClick={() => setIsEditing(false)} className="flex h-7 w-7 items-center justify-center rounded-lg" aria-label="Cancel editing"><X size={14} /></button>
                <button type="submit" disabled={!draft.trim()} className="flex h-7 w-7 items-center justify-center rounded-lg disabled:opacity-40" style={{ background: 'var(--dc-brand)', color: 'white' }} aria-label="Send edited message"><Check size={14} /></button>
              </div>
            </form>
          ) : renderHumanContent(message.content)}
          </div>
          {!isEditing && onEdit ? (
            <button
              type="button"
              onClick={() => {
                setDraft(message.content || '');
                setIsEditing(true);
              }}
              disabled={disabled}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] opacity-0 transition group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
              style={{ color: 'var(--dc-text-muted)' }}
              aria-label="Edit message"
            >
              <Pencil size={11} /> Edit
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-start gap-3 mb-5">
      <div className="shrink-0 mt-0.5">
        <SonarGlyph state={isStreaming ? 'generating' : 'idle'} size={28} />
      </div>

      <div className="group min-w-0 w-fit max-w-[92%]">
        <div
          className="rounded-2xl rounded-tl-sm px-4 py-3 overflow-hidden"
          style={{
            background: isBlocked ? 'rgba(245, 158, 11, 0.07)' : 'var(--dc-surface-1)',
            border: `1px solid ${isBlocked ? 'rgba(245, 158, 11, 0.32)' : isStreaming ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
            boxShadow: isStreaming ? '0 2px 16px rgba(0,201,177,0.08)' : 'none',
            transition: 'border-color 0.3s, box-shadow 0.3s',
          }}
        >
        {isBlocked && (
          <div className="flex items-center gap-2 mb-2 pb-2 border-b" style={{ color: '#b45309', borderColor: 'rgba(245, 158, 11, 0.22)' }}>
            <ShieldAlert size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">Access policy</span>
            {message.guardrail?.minimum_role && <span className="ml-auto text-[9px] font-semibold">Requires {message.guardrail.minimum_role}</span>}
          </div>
        )}
        <MarkdownRenderer
          content={message.content}
          diagrams={message.diagrams || []}
          sources={message.sources || []}
          documents={documents}
        />
        {isStreaming && (
          <span
            className="inline-block w-0.5 h-4 ml-0.5 rounded-full align-text-bottom"
            style={{ background: 'var(--dc-brand)', animation: 'dc-cursor-blink 0.9s ease-in-out infinite' }}
          />
        )}
        </div>
        {onRetry && !isStreaming ? (
          <button
            type="button"
            onClick={() => onRetry(message.id)}
            disabled={disabled}
            className="mt-1.5 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] opacity-0 transition group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
            style={{ color: 'var(--dc-text-muted)' }}
            aria-label="Retry AI response"
          >
            <RefreshCw size={11} /> Retry
          </button>
        ) : null}
      </div>

      <style>{`
        @keyframes dc-cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}
