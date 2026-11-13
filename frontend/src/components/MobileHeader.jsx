import React from 'react';
import { Menu, MessageSquarePlus } from 'lucide-react';
import DeepContextLogo from './DeepContextLogo';

export default function MobileHeader({ onToggleSidebar, onNewChat }) {
  return (
    <header className="dc-mobile-only sticky top-0 z-40 flex items-center justify-between px-4 py-3 dc-glass border-b border-[var(--dc-glass-border-subtle)]">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="p-2 rounded-lg hover:bg-[var(--dc-bg-hover)] transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu size={20} className="text-[var(--dc-text-secondary)]" />
        </button>
        <div className="flex items-center gap-2.5">
          <DeepContextLogo size="sm" />
          <span className="font-semibold text-sm tracking-tight" style={{ fontFamily: 'var(--dc-font-display)' }}>
            DeepContext
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={onNewChat}
        className="p-2 rounded-lg hover:bg-[var(--dc-bg-hover)] transition-colors"
        aria-label="New chat"
      >
        <MessageSquarePlus size={20} className="text-[var(--dc-text-secondary)]" />
      </button>
    </header>
  );
}
