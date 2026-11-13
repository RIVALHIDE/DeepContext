import React from 'react';
import { FileText } from 'lucide-react';

export default function SourcePanel({ sources = [], highlightedIndex = null }) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--dc-border)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--dc-text-muted)' }}>
        Sources
      </p>
      <div className="space-y-2">
        {sources.map((src) => (
          <div
            key={src.index}
            className={`flex gap-3 rounded-lg border p-3 transition-all`}
            style={highlightedIndex === src.index ? { borderColor: 'var(--dc-brand)', background: 'var(--dc-brand-dim)' } : { borderColor: 'var(--dc-border)', background: 'var(--dc-surface-1)' }}
          >
            <div className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold mt-0.5" style={{ background: 'var(--dc-surface-2)', color: 'var(--dc-brand)' }}>
              {src.index}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <FileText size={12} className="" style={{ color: 'var(--dc-text-muted)' }} />
                <span className="text-xs font-medium truncate" style={{ color: 'var(--dc-text-primary)' }}>
                  {src.sourceName}
                </span>
                {src.page != null && (
                  <span className="text-[10px] shrink-0" style={{ color: 'var(--dc-text-muted)' }}>p.{src.page}</span>
                )}
              </div>
              <p className="text-[11px] leading-relaxed line-clamp-2" style={{ color: 'var(--dc-text-muted)' }}>
                {src.preview}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
