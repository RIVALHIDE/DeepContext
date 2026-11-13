import React from 'react';

export default function CitationBadge({ number, onHover, onLeave, isHighlighted }) {
  const baseStyle = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', margin: '0 0.125rem', padding: '0.125rem 0.375rem', borderRadius: 6,
    fontSize: '10px', fontWeight: 600, lineHeight: 1, border: '1px solid', verticalAlign: 'super'
  };

  const highlightedStyle = isHighlighted
    ? { background: 'var(--dc-violet)', color: '#fff', borderColor: 'rgba(124,58,237,0.4)' }
    : { background: 'var(--dc-surface-1)', color: 'var(--dc-violet)', borderColor: 'var(--dc-border)' };

  return (
    <span
      onMouseEnter={() => onHover?.(number)}
      onMouseLeave={() => onLeave?.()}
      style={{ ...baseStyle, ...highlightedStyle }}
      title={`Source ${number}`}
    >
      {number}
    </span>
  );
}
