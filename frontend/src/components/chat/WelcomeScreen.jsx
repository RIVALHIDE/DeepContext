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
