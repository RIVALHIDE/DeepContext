import MarkdownRenderer from '../MarkdownRenderer';
import SonarGlyph from '../brand/SonarGlyph';

export default function MessageBubble({ message }) {
  const isHuman = message.role === 'human';
  const isStreaming = message.streaming;

  if (isHuman) {
    return (
      <div className="flex justify-end mb-4">
        <div
          className="max-w-[78%] px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap rounded-2xl rounded-br-sm"
          style={{
            background: 'linear-gradient(135deg, #0E7966 0%, #0A6358 100%)',
            color: '#E2F7F4',
            boxShadow: '0 2px 12px rgba(0,201,177,0.15)',
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 mb-5">
      <div className="shrink-0 mt-0.5">
        <SonarGlyph state={isStreaming ? 'generating' : 'idle'} size={28} />
      </div>

      <div
        className="flex-1 max-w-[84%] rounded-2xl rounded-tl-sm px-4 py-3 overflow-hidden"
        style={{
          background: 'var(--dc-surface-1)',
          border: `1px solid ${isStreaming ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
          boxShadow: isStreaming ? '0 2px 16px rgba(0,201,177,0.08)' : 'none',
          transition: 'border-color 0.3s, box-shadow 0.3s',
        }}
      >
        <MarkdownRenderer
          content={message.content}
          diagrams={message.diagrams || []}
          sources={message.sources || []}
        />
        {isStreaming && (
          <span
            className="inline-block w-0.5 h-4 ml-0.5 rounded-full align-text-bottom"
            style={{ background: 'var(--dc-brand)', animation: 'dc-cursor-blink 0.9s ease-in-out infinite' }}
          />
        )}
      </div>

      <style>{`
        @keyframes dc-cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}
