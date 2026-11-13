import React from 'react';
import { AlertCircle, CheckCircle2, FileUp, Loader2, X } from 'lucide-react';
import { getStageIndex, INGEST_STEPS } from '../utils/ingestProgress.util';

function StepDot({ index, currentIndex, isFailed, isComplete }) {
  const isDone = isComplete || (!isFailed && currentIndex > index);
  const isActive = !isFailed && !isComplete && currentIndex === index;

  const dotStyle = isFailed && index === currentIndex
    ? { borderColor: 'var(--dc-red)', background: 'var(--dc-red)', boxShadow: '0 0 8px rgba(244,63,94,0.35)' }
    : isDone
      ? { borderColor: 'var(--dc-green)', background: 'var(--dc-green)' }
      : isActive
        ? { borderColor: 'var(--dc-brand)', background: 'var(--dc-brand)', boxShadow: '0 0 8px rgba(0,201,177,0.35)' }
        : { borderColor: 'var(--dc-border)', background: 'var(--dc-surface-2)' };

  const labelStyle = isActive ? { color: 'var(--dc-brand)', fontWeight: 600 } : isDone ? { color: 'var(--dc-green)' } : { color: 'var(--dc-text-muted)' };

  return (
    <div className="flex flex-col items-center gap-1.5 min-w-0 flex-1 relative z-10">
      <div style={{ height: 10, width: 10, borderRadius: 9999, border: '1px solid', transition: 'all .12s', ...dotStyle }} />
      <span className="text-[9px] uppercase tracking-wide truncate max-w-full" style={labelStyle}>
        {INGEST_STEPS[index]?.label}
      </span>
    </div>
  );
}

export default function IngestProgressBanner({ ingestState, onDismiss }) {
  const { status, fileName, stage, message, percent } = ingestState;

  if (status === 'idle') return null;

  const isUploading = status === 'uploading';
  const isProcessing = status === 'processing';
  const isComplete = status === 'completed';
  const isFailed = status === 'failed';
  const isActive = isUploading || isProcessing;

  const currentIndex = isUploading ? -1 : getStageIndex(stage);
  const displayPercent = isComplete ? 100 : isFailed ? 0 : isUploading ? 5 : percent;

  const borderStyle = isComplete
    ? { borderColor: 'rgba(16,185,129,0.16)', background: 'rgba(16,185,129,0.03)' }
    : isFailed
      ? { borderColor: 'rgba(244,63,94,0.16)', background: 'rgba(244,63,94,0.03)' }
      : { borderColor: 'rgba(0,122,103,0.12)', background: 'var(--dc-surface-1)' };

  const barStyle = isComplete ? { background: 'var(--dc-green)' } : isFailed ? { background: 'var(--dc-red)' } : { background: 'var(--dc-brand)' };

  const title = isComplete
    ? 'Document added to knowledge base'
    : isFailed
      ? 'Ingestion failed'
      : `Ingesting: ${fileName || 'document'}`;

  const StatusIcon = isComplete ? CheckCircle2 : isFailed ? AlertCircle : isActive ? Loader2 : FileUp;
  const iconStyle = isComplete ? { color: 'var(--dc-green)' } : isFailed ? { color: 'var(--dc-red)' } : { color: 'var(--dc-brand)' };

  return (
    <div
      className={`mb-4 rounded-xl p-4 shadow-lg backdrop-blur-sm transition-all`}
      role="status"
      aria-live="polite"
      style={{ ...borderStyle, borderWidth: '1px', borderStyle: 'solid' }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon
            size={18}
            className={`shrink-0 ${isActive ? 'animate-spin' : ''}`}
            style={iconStyle}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate" style={{ color: 'var(--dc-text-primary)' }}>{title}</p>
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--dc-text-muted)' }}>
              {message || (isUploading ? 'Uploading to server…' : 'Processing…')}
            </p>
          </div>
        </div>

        {(isComplete || isFailed) && (
          <button
            type="button"
            onClick={onDismiss}
            className="p-1 rounded-lg transition shrink-0"
            aria-label="Dismiss"
            style={{ color: 'var(--dc-text-muted)' }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {!isFailed && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: 'var(--dc-text-muted)' }}>
            <span>Progress</span>
            <span>{displayPercent}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'var(--dc-surface-2)' }}>
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out`}
              style={{ width: `${displayPercent}%`, ...barStyle }}
            />
          </div>
        </div>
      )}

      {!isFailed && (
        <div className="flex items-center justify-between gap-1 pt-1">
              {INGEST_STEPS.map((step, index) => (
            <React.Fragment key={step.id}>
              <StepDot
                index={index}
                currentIndex={currentIndex}
                isFailed={isFailed}
                isComplete={isComplete}
              />
              {index < INGEST_STEPS.length - 1 && (
                <div
                  className={"h-px flex-1 mb-4 transition-colors"}
                  style={{
                    background: isComplete || currentIndex > index ? 'rgba(16,185,129,0.5)' : 'var(--dc-border)'
                  }}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
