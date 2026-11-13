import MarkdownRenderer from '../MarkdownRenderer';
import SonarGlyph from '../brand/SonarGlyph';
import { ShieldAlert } from 'lucide-react';

export default function MessageBubble({ message }) {
  const isHuman = message.role === 'human';
  const isStreaming = message.streaming;
  const isBlocked = Boolean(message.blocked);

  if (isHuman) {
    return (
      <div className="flex justify-end mb-4">
        <div
          className="max-w-[78%] px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap rounded-2xl rounded-br-sm"
          style={{
            background: 'linear-gradient(135deg, #EFF6FF 0%, #E8F0FE 100%)',
            color: 'var(--dc-text-primary)',
            border: '1px solid var(--dc-brand-border)',
            boxShadow: '0 4px 14px rgba(37,99,235,0.08)',
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
          background: isBlocked ? 'rgba(245, 158, 11, 0.07)' : 'var(--dc-surface-1)',
          border: `1px solid ${isBlocked ? 'rgba(245, 158, 11, 0.32)' : isStreaming ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
          boxShadow: isStreaming ? '0 2px 16px rgba(0,201,177,0.08)' : 'none',
          transition: 'border-color 0.3s, box-shadow 0.3s',
        }}
      >
        {isBlocked && (
          <div className="flex items-center gap-2 mb-2 pb-2 border-b" style={{ color: '#b45309', borderColor: 'rgba(245, 158, 11, 0.22)' }}>
            <ShieldAlert size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">Access policy</span>
            {message.guardrail?.minimum_role && <span className="ml-auto text-[9px] font-semibold">Requires {message.guardrail.minimum_role}</span>}
          </div>
        )}
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
