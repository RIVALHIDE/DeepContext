import { FileSearch, Hash, Cpu, TrendingUp } from 'lucide-react';
import { sourceDisplayName } from '../utils/sourceName.util';

/**
 * CitationMetrics — displays LLM token usage and source citation stats.
 *
 * Props:
 *   sources — array of source objects from the last chat response
 *   tokenUsage — optional token usage object { prompt_tokens, completion_tokens, total_tokens }
 */
export default function CitationMetrics({ sources = [], tokenUsage = null }) {
  const sourceCount = sources?.length || 0;
  const totalChunks = sources?.reduce(
    (sum, s) => sum + (s?.chunk_count || 1),
    0
  );

  const metrics = [
    {
      icon: FileSearch,
      label: 'Sources Cited',
      value: sourceCount,
      color: 'var(--dc-brand)',
    },
    {
      icon: Hash,
      label: 'Chunks Retrieved',
      value: totalChunks,
      color: 'var(--dc-violet)',
    },
    {
      icon: Cpu,
      label: 'Prompt Tokens',
      value: tokenUsage?.prompt_tokens ?? '—',
      color: 'var(--dc-text-secondary)',
    },
    {
      icon: TrendingUp,
      label: 'Completion Tokens',
      value: tokenUsage?.completion_tokens ?? '—',
      color: 'var(--dc-text-secondary)',
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="px-3 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--dc-border)' }}
      >
        <span
          className="text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: 'var(--dc-text-muted)' }}
        >
          Citation Metrics
        </span>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-2 p-2 shrink-0">
        {metrics.map((m, idx) => {
          const Icon = m.icon;
          return (
            <div
              key={idx}
              className="rounded-lg p-2.5"
              style={{
                background: 'var(--dc-surface-1)',
                border: '1px solid var(--dc-border)',
              }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={11} style={{ color: m.color }} />
                <span
                  className="text-[9px] uppercase tracking-wider"
                  style={{ color: 'var(--dc-text-muted)' }}
                >
                  {m.label}
                </span>
              </div>
              <p
                className="text-lg font-bold"
                style={{ color: 'var(--dc-text-primary)' }}
              >
                {typeof m.value === 'number' ? m.value : m.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Source breakdown */}
      {sourceCount > 0 ? (
        <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2 space-y-1">
          <span
            className="text-[9px] uppercase tracking-wider px-1"
            style={{ color: 'var(--dc-text-muted)' }}
          >
            Sources
          </span>
          {sources.map((source, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 rounded-md px-2 py-1.5"
              style={{
                background: 'var(--dc-surface-1)',
                border: '1px solid var(--dc-border)',
              }}
            >
              <span
                className="flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold shrink-0"
                style={{
                  background: 'var(--dc-brand-dim)',
                  color: 'var(--dc-brand)',
                }}
              >
                {source.index ?? idx + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p
                  className="text-[11px] font-medium truncate"
                  style={{ color: 'var(--dc-text-primary)' }}
                >
                  {sourceDisplayName(source) || `Source ${idx + 1}`}
                </p>
                {source.preview && (
                  <p
                    className="text-[9px] truncate"
                    style={{ color: 'var(--dc-text-muted)' }}
                  >
                    {source.preview}
                  </p>
                )}
              </div>
              {source.chunk_count && source.chunk_count > 1 && (
                <span
                  className="text-[9px] shrink-0"
                  style={{ color: 'var(--dc-text-muted)' }}
                >
                  {source.chunk_count} chunks
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-2"
          style={{ color: 'var(--dc-text-muted)' }}
        >
          <FileSearch size={18} style={{ opacity: 0.4 }} />
          <p className="text-[11px] font-medium" style={{ color: 'var(--dc-text-secondary)' }}>No citations yet</p>
          <p className="text-[10px] max-w-[220px] text-center leading-relaxed">Ask a question to see the source documents used in the answer.</p>
        </div>
      )}
    </div>
  );
}
