import React from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2 } from 'lucide-react';

export default function IngestSidebarRow({ ingestState }) {
  const { status, fileName, message, percent } = ingestState;

  if (status === 'idle') return null;

  const isComplete = status === 'completed';
  const isFailed = status === 'failed';
  const isActive = status === 'uploading' || status === 'processing';
  const displayPercent = isComplete ? 100 : isFailed ? 0 : percent;

  const styleOverrides = isComplete
    ? { borderColor: 'var(--dc-green)', background: 'var(--dc-surface-1)' }
    : isFailed
      ? { borderColor: 'var(--dc-red)', background: 'var(--dc-surface-1)' }
      : { borderColor: 'var(--dc-brand-border)', background: 'var(--dc-brand-dim)' };

  const StatusIcon = isComplete ? CheckCircle2 : isFailed ? AlertCircle : Loader2;
  const iconColor = isComplete ? 'var(--dc-green)' : isFailed ? 'var(--dc-red)' : 'var(--dc-brand)';

  return (
    <div
      className="p-3 rounded-xl transition-all"
      style={{ border: '1px solid', ...styleOverrides }}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} style={{ color: 'var(--dc-text-muted)' }} className="shrink-0" />
          <span className="text-xs font-medium truncate" style={{ color: 'var(--dc-text-primary)' }}>
            {fileName || 'Document'}
          </span>
        </div>
        <StatusIcon
          size={14}
          className={`shrink-0 ${isActive ? 'animate-spin' : ''}`}
          style={{ color: iconColor }}
        />
      </div>

      <p className="text-[10px] mb-2 truncate" style={{ color: 'var(--dc-text-muted)' }}>
        {message || (isActive ? 'Processing…' : isComplete ? 'Ready' : 'Failed')}
      </p>

      {!isFailed && (
        <div className="h-1 w-full rounded-full overflow-hidden" style={{ background: 'var(--dc-surface-2)' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${displayPercent}%`, background: isComplete ? 'var(--dc-green)' : 'var(--dc-brand)' }}
          />
        </div>
      )}
    </div>
  );
}
