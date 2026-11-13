import { AlertCircle, CheckCircle2, Clock3, FileUp, Loader2, X } from 'lucide-react';

export default function IngestProgressBanner({ ingestState, onDismiss }) {
  const { status, fileName, message, percent } = ingestState;

  if (status === 'idle') return null;

  const isUploading = status === 'uploading';
  const isProcessing = status === 'processing';
  const isComplete = status === 'completed';
  const isFailed = status === 'failed';
  const isPending = status === 'pending_approval';
  const isActive = isUploading || isProcessing;
  const displayPercent = isComplete ? 100 : isFailed ? 0 : isUploading ? 5 : percent;

  const panelStyle = isComplete
    ? { borderColor: 'rgba(16,185,129,.24)', background: 'rgba(16,185,129,.05)' }
    : isFailed
      ? { borderColor: 'rgba(244,63,94,.24)', background: 'rgba(244,63,94,.05)' }
      : { borderColor: 'var(--dc-border)', background: 'var(--dc-surface-1)' };

  const accent = isComplete
    ? 'var(--dc-green)'
    : isFailed
      ? 'var(--dc-red)'
      : 'var(--dc-brand)';

  const title = isPending
    ? 'Waiting for approval'
    : isComplete
      ? 'Document ready'
      : isFailed
        ? 'Ingestion failed'
        : isUploading
          ? `Uploading ${fileName || 'document'}`
          : `Indexing ${fileName || 'document'}`;

  const StatusIcon = isComplete
    ? CheckCircle2
    : isFailed
      ? AlertCircle
      : isPending
        ? Clock3
        : isActive
          ? Loader2
          : FileUp;

  return (
    <div
      className="mb-3 rounded-xl px-3 py-2.5 transition-all"
      role="status"
      aria-live="polite"
      style={{ ...panelStyle, borderWidth: 1, borderStyle: 'solid' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <StatusIcon
            size={16}
            className={`shrink-0 ${isActive ? 'animate-spin' : ''}`}
            style={{ color: accent }}
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate" style={{ color: 'var(--dc-text-primary)' }}>
              {title}
            </p>
            <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--dc-text-muted)' }}>
              {message || (isUploading ? 'Sending file to server…' : 'Working in the background…')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!isFailed && !isPending && (
            <span className="text-[10px] tabular-nums" style={{ color: 'var(--dc-text-muted)' }}>
              {displayPercent}%
            </span>
          )}
          {(isComplete || isFailed || isPending) && (
            <button
              type="button"
              onClick={onDismiss}
              className="p-1 rounded-lg transition"
              aria-label="Dismiss upload status"
              style={{ color: 'var(--dc-text-muted)' }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {!isFailed && !isPending && (
        <div className="h-1 w-full rounded-full overflow-hidden mt-2" style={{ background: 'var(--dc-surface-2)' }}>
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{ width: `${displayPercent}%`, background: accent }}
          />
        </div>
      )}
    </div>
  );
}
