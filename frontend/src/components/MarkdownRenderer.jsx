import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DiagramRenderer from './DiagramRenderer';
import SourcePanel from './SourcePanel';
import CitationBadge from './CitationBadge';
import { useCitationHighlight } from '../utils/useCitationHighlight';

// Split text on [[N]] markers and return nodes replacing markers with CitationBadge
function renderWithCitations(text, onHover, onLeave, highlightedIndex) {
  const parts = String(text || '').split(/(\[\[\d+\]\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[\[(\d+)\]\]$/);
    if (m) {
      const num = parseInt(m[1], 10);
      return (
        <CitationBadge
          key={`cite_${i}`}
          number={num}
          onHover={onHover}
          onLeave={onLeave}
          isHighlighted={highlightedIndex === num}
        />
      );
    }
    return part;
  });
}

export default function MarkdownRenderer({ content, diagrams = [], sources = [] }) {
  const { highlightedIndex, onHover, onLeave } = useCitationHighlight();

  const text = String(content ?? '').trim();
  const hasText = Boolean(text);
  const hasDiagrams = Array.isArray(diagrams) && diagrams.length > 0;

  if (!hasText && !hasDiagrams && (!Array.isArray(sources) || sources.length === 0)) return null;

  return (
    <div className="markdown-content text-sm leading-relaxed" style={{ color: 'var(--dc-text-primary)' }}>
      {hasText && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => (
              <p className="mb-3 whitespace-pre-wrap last:mb-0">
                {React.Children.map(children, (child) => {
                  if (typeof child === 'string') {
                    return renderWithCitations(child, onHover, onLeave, highlightedIndex);
                  }
                  return child;
                })}
              </p>
            ),
            li: ({ children }) => (
              <li className="pl-1">
                {React.Children.map(children, (child) => {
                  if (typeof child === 'string') {
                    return renderWithCitations(child, onHover, onLeave, highlightedIndex);
                  }
                  return child;
                })}
              </li>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      )}

      <DiagramRenderer diagrams={diagrams} />

      <SourcePanel sources={sources} highlightedIndex={highlightedIndex} />
    </div>
  );
}
