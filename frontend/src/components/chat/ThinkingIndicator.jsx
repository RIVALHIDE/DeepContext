import { Check, LoaderCircle, Search, ShieldCheck, Sparkles } from 'lucide-react';

const STEPS = [
  { id: 'retrieving', label: 'Retrieving documents', icon: Search },
  { id: 'drafting', label: 'Drafting response', icon: Sparkles },
  { id: 'verifying', label: 'Agent verifying facts', icon: ShieldCheck },
];

export default function ThinkingIndicator({ stage = 'retrieving' }) {
  const activeIndex = Math.max(0, STEPS.findIndex((step) => step.id === stage));

  return (
    <div className="flex items-start gap-3 py-1" role="status" aria-live="polite">
      <div
        className="w-full max-w-md rounded-2xl rounded-tl-sm px-4 py-3"
        style={{
          background: 'linear-gradient(135deg, var(--dc-brand-dim), var(--dc-surface-1))',
          border: '1px solid var(--dc-brand-border)',
          boxShadow: '0 8px 24px rgba(37, 99, 235, 0.08)',
        }}
      >
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--dc-text-primary)' }}>DeepContext agent</p>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>Grounding the answer before it appears</p>
          </div>
          <span className="text-[9px] font-semibold uppercase tracking-wider rounded-full px-2 py-1" style={{ color: 'var(--dc-brand)', background: 'var(--dc-surface-0)', border: '1px solid var(--dc-brand-border)' }}>LangGraph</span>
        </div>

        <div className="space-y-2">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            const isDone = index < activeIndex;
            const isActive = index === activeIndex;
            return <div key={step.id} className="flex items-center gap-2.5">
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                style={{
                  background: isDone ? 'rgba(16,185,129,.12)' : isActive ? 'var(--dc-brand-dim)' : 'var(--dc-surface-2)',
                  color: isDone ? 'var(--dc-green)' : isActive ? 'var(--dc-brand)' : 'var(--dc-text-muted)',
                  border: `1px solid ${isDone ? 'rgba(16,185,129,.25)' : isActive ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
                }}
              >
                {isDone ? <Check size={12} strokeWidth={3} /> : isActive ? <LoaderCircle size={12} className="animate-spin" /> : <Icon size={11} />}
              </span>
              <span className="text-[11px] font-medium" style={{ color: isDone || isActive ? 'var(--dc-text-primary)' : 'var(--dc-text-muted)' }}>
                {step.label}{isDone ? ' · complete' : isActive ? '…' : ''}
              </span>
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}
