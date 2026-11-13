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
