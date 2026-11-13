import { useCallback, useState } from 'react';
import { Terminal, GitBranch, Search, FileText, Sparkles } from 'lucide-react';
import ChatWindow from './ChatWindow';

const SLASH_COMMANDS = [
  { command: '/extract_diagram', label: 'Extract Diagram', icon: GitBranch, desc: 'Generate a visual diagram from the knowledge base' },
  { command: '/search', label: 'Search', icon: Search, desc: 'Search across all uploaded documents' },
  { command: '/summarize', label: 'Summarize', icon: FileText, desc: 'Summarize the retrieved context' },
  { command: '/help', label: 'Help', icon: Sparkles, desc: 'Show available commands' },
];

function detectSlashCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  return SLASH_COMMANDS.find((c) => c.command === cmd) || null;
}

/**
 * NexconnChat — wraps the existing ChatWindow and adds:
 *  1. A slash command interceptor that detects commands like /extract_diagram
 *  2. Callbacks to bubble up diagrams and sources to the parent layout
 */
export default function NexconnChat({
  user,
  ingestState,
  onIngestStart,
  onIngestEvent,
  onIngestComplete,
  onIngestFailed,
  onDismissIngest,
  onResponse,
}) {
  const [inputText, setInputText] = useState('');
  const detectedCommand = detectSlashCommand(inputText);
  const showCommandHint = inputText.startsWith('/') && !inputText.includes(' ');

  const handleInputChange = useCallback((text) => {
    setInputText(text);
  }, []);

  const handleResponse = useCallback(
    (data) => {
      onResponse?.(data);
      // Clear the input tracking after response
      setInputText('');
    },
    [onResponse]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Slash command indicator bar */}
      {detectedCommand && (
        <div
          className="flex items-center gap-2 px-4 py-2 mx-6 mt-4 rounded-xl"
          style={{
            background: 'var(--dc-brand-dim)',
            border: '1px solid var(--dc-brand-border)',
          }}
        >
          <detectedCommand.icon size={14} style={{ color: 'var(--dc-brand-glow)' }} />
          <span
            className="text-xs font-semibold"
            style={{ color: 'var(--dc-brand-glow)' }}
          >
            {detectedCommand.command}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--dc-text-secondary)' }}>
            {detectedCommand.desc}
          </span>
        </div>
      )}

      {/* Command palette (shows when typing / with no space yet) */}
      {showCommandHint && !detectedCommand && (
        <div
          className="mx-6 mt-4 rounded-xl overflow-hidden"
          style={{
            background: 'var(--dc-surface-1)',
            border: '1px solid var(--dc-border-strong)',
          }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2 border-b"
            style={{ borderColor: 'var(--dc-border)' }}
          >
            <Terminal size={12} style={{ color: 'var(--dc-text-muted)' }} />
            <span
              className="text-[10px] uppercase tracking-widest font-semibold"
              style={{ color: 'var(--dc-text-muted)' }}
            >
              Slash Commands
            </span>
          </div>
          {SLASH_COMMANDS.map((cmd) => {
            const Icon = cmd.icon;
            return (
              <div
                key={cmd.command}
                className="flex items-center gap-2.5 px-3 py-2 transition cursor-pointer"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--dc-surface-2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <Icon size={13} style={{ color: 'var(--dc-brand)' }} />
                <div>
                  <span
                    className="text-xs font-medium"
                    style={{ color: 'var(--dc-text-primary)' }}
                  >
                    {cmd.command}
                  </span>
                  <span
                    className="text-[10px] ml-2"
                    style={{ color: 'var(--dc-text-muted)' }}
                  >
                    {cmd.desc}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Chat window */}
      <ChatWindow
        user={user}
        ingestState={ingestState}
        onIngestStart={onIngestStart}
        onIngestEvent={onIngestEvent}
        onIngestComplete={onIngestComplete}
        onIngestFailed={onIngestFailed}
        onDismissIngest={onDismissIngest}
        onResponse={handleResponse}
        onInputChange={handleInputChange}
      />
    </div>
  );
}
