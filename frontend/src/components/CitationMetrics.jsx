import { FileSearch, Hash, Cpu, TrendingUp, Quote, FileText, Search } from 'lucide-react';
import { sourceDisplayName, sourcesForDocuments } from '../utils/sourceName.util';

/**
 * CitationMetrics — displays LLM token usage and source citation stats.
 *
 * Props:
 *   sources — array of source objects from the last chat response
 *   tokenUsage — optional token usage object { prompt_tokens, completion_tokens, total_tokens }
 */
export default function CitationMetrics({ sources = [], documents = [], tokenUsage = null }) {
  const workspaceSources = sourcesForDocuments(sources, documents);
  const sourceCount = workspaceSources.length;
  const totalChunks = workspaceSources.reduce(
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
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2.5 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold" style={{ color: 'var(--dc-text-secondary)' }}>Latest answer</h3>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--dc-text-muted)' }}>Files and passages used by the AI</p>
          </div>
          <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: sourceCount ? 'var(--dc-brand-dim)' : 'var(--dc-surface-2)', color: sourceCount ? 'var(--dc-brand)' : 'var(--dc-text-muted)' }}>
            <Quote size={11} /> {sourceCount} cited
          </span>
        </div>
      </div>

      {/* Compact metric strip */}
      <div className="mx-4 grid grid-cols-2 divide-x rounded-xl px-1 py-2.5 shrink-0" style={{ background: 'var(--dc-surface-1)', borderColor: 'var(--dc-border)' }}>
        {metrics.map((m, idx) => {
          const Icon = m.icon;
          return (
            <div
              key={idx}
              className="px-3"
              style={{ borderColor: 'var(--dc-border)' }}
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--dc-text-muted)' }}><Icon size={12} style={{ color: m.color }} />{m.label}</p>
              <p className="mt-0.5 text-lg font-bold" style={{ color: 'var(--dc-text-primary)' }}>{m.value}</p>
            </div>
          );
        })}
      </div>

      {tokenUsage && (
        <div className="mx-4 mt-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--dc-text-muted)' }}>
          <Cpu size={11} /><span>{tokenUsage.prompt_tokens ?? '—'} prompt</span><span>·</span><TrendingUp size={11} /><span>{tokenUsage.completion_tokens ?? '—'} completion</span>
        </div>
      )}

      {/* Source breakdown */}
      {sourceCount > 0 ? (
        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-4 pt-3">
          <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold" style={{ color: 'var(--dc-text-secondary)' }}>Referenced files</span><span className="text-[11px]" style={{ color: 'var(--dc-text-muted)' }}>{totalChunks} retrieved passages</span></div>
          <div className="divide-y" style={{ borderColor: 'var(--dc-border)' }}>
          {workspaceSources.map((source, idx) => (
            <div
              key={idx}
              className="flex items-start gap-3 py-3"
            >
              <span
                className="relative flex h-9 w-9 items-center justify-center rounded-xl shrink-0"
                style={{
                  background: 'var(--dc-brand-dim)',
                  color: 'var(--dc-brand)',
                }}
              >
                <FileText size={16} />
                <small className="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white" style={{ background: 'var(--dc-brand)' }}>{source.index ?? idx + 1}</small>
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate" style={{ color: 'var(--dc-text-primary)' }} title={sourceDisplayName(source) || `Source ${idx + 1}`}>
                  {sourceDisplayName(source) || `Source ${idx + 1}`}
                </p>
                {source.preview && (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed" style={{ color: 'var(--dc-text-muted)' }}>
                    {source.preview}
                  </p>
                )}
                <div className="mt-1.5 flex items-center gap-2 text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>
                  {source.page != null && <span>Page {source.page}</span>}
                  {source.page != null && source.chunk_count > 1 && <span>·</span>}
                  {source.chunk_count > 1 && <span>{source.chunk_count} passages</span>}
                </div>
              </div>
            </div>
          ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-8 pb-4 text-center">
          <span className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}><Search size={18} /></span>
          <p className="text-sm font-semibold" style={{ color: 'var(--dc-text-primary)' }}>No evidence to inspect yet</p>
          <p className="mt-1 max-w-64 text-xs leading-relaxed" style={{ color: 'var(--dc-text-muted)' }}>Ask the AI a question to see exactly which files support its answer.</p>
        </div>
      )}
    </div>
  );
}
