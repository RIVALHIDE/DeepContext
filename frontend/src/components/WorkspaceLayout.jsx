import { useCallback, useState } from 'react';
import { RefreshCw, GitBranch, FileCheck, BarChart3, Bot, MessagesSquare } from 'lucide-react';
import DocCard from './docs/DocCard';
import IngestSidebarRow from './IngestSidebarRow';
import NexconnChat from './NexconnChat';
import AICanvas from './AICanvas';
import DocumentPullRequest from './DocumentPullRequest';
import CitationMetrics from './CitationMetrics';
import KnowledgeLeaderboard from './KnowledgeLeaderboard';
import LogoLockup from './brand/LogoLockup';

const RIGHT_TABS = [
  { key: 'pullrequests', label: 'Pull Requests', icon: FileCheck },
  { key: 'metrics', label: 'Citations', icon: BarChart3 },
];

/**
 * WorkspaceLayout — 3-panel CSS Grid layout for the multiplayer workspace.
 *
 *  ┌──────────┬─────────────────┬──────────────────┐
 *  │  Left    │   Center         │   Right (split)   │
 *  │ Sidebar  │   Nexconn Chat   │   ┌──────────┐    │
 *  │ + Board  │   + slash cmds   │   │ AICanvas │    │
 *  │          │                  │   ├──────────┤    │
 *  │          │                  │   │ Tabs     │    │
 *  │          │                  │   └──────────┘    │
 *  └──────────┴─────────────────┴──────────────────┘
 */
export default function WorkspaceLayout({
  user,
  docs,
  docActionMessage,
  ingestState,
  isIngestActive,
  deletingDocName,
  isRefreshingDocs,
  onDelete,
  onAccessChange,
  onRefresh,
  onIngestStart,
  onIngestEvent,
  onIngestComplete,
  onIngestFailed,
  onDismissIngest,
}) {
  // Shared state between center chat and right panel
  const [flowData, setFlowData] = useState(null);
  const [lastSources, setLastSources] = useState([]);
  const [activeTab, setActiveTab] = useState('pullrequests');
  const [chatMode, setChatMode] = useState('ai');
  const showIngestSidebar = ['uploading', 'processing', 'pending_approval', 'failed'].includes(ingestState?.status);

  const handleChatResponse = useCallback((data) => {
    if (!data) return;
    // Update AICanvas with latest diagram flow data
    if (data.diagrams?.length) {
      const firstWithFlow = data.diagrams.find((d) => d.flow);
      if (firstWithFlow?.flow) {
        setFlowData(firstWithFlow.flow);
      } else {
        setFlowData(null);
      }
    } else {
      setFlowData(null);
    }
    // Update CitationMetrics with latest sources
    setLastSources(data.sources || []);
  }, []);

  return (
    <div
      className="dc-workspace-grid grid h-screen"
      style={{
        gridTemplateColumns: '235px minmax(520px, 1fr) 390px',
        gap: '12px',
        padding: '12px',
        background: 'var(--dc-bg)',
        color: 'var(--dc-text-primary)',
      }}
    >
      {/* ═══════════════════════════════════════════════════════
          LEFT PANEL — Sidebar + Knowledge Leaderboard
          ═══════════════════════════════════════════════════════ */}
      <aside
        className="flex flex-col overflow-hidden"
        style={{
          background: 'var(--dc-surface-0)',
          border: '1px solid var(--dc-border)',
          borderRadius: '14px',
          boxShadow: 'var(--dc-shadow-card)',
        }}
      >
        {/* Brand */}
        <div
          className="px-4 py-4 border-b flex items-center"
          style={{ borderColor: 'var(--dc-border)' }}
        >
          <LogoLockup state="idle" size={32} />
        </div>

        {/* Document list */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
          <h2
            className="text-[10px] font-semibold mb-4 uppercase tracking-widest"
            style={{ color: 'var(--dc-text-muted)' }}
          >
            Knowledge Base
          </h2>

          {docActionMessage && (
            <p
              className="mb-3 text-[11px]"
              style={{ color: 'var(--dc-text-secondary)' }}
            >
              {docActionMessage}
            </p>
          )}

          <div className="space-y-2">
            {showIngestSidebar && <IngestSidebarRow ingestState={ingestState} />}

            {(!docs || docs.length === 0) && !isIngestActive && (
              <div
                className="rounded-xl border border-dashed p-4 text-xs"
                style={{
                  borderColor: 'var(--dc-border-strong)',
                  color: 'var(--dc-text-muted)',
                }}
              >
                No documents available.
              </div>
            )}

            {docs?.map((doc, i) => (
              <DocCard
                key={i}
                doc={doc}
                onDelete={['owner', 'admin', 'editor'].includes(user.role) ? onDelete : null}
                onAccessChange={['owner', 'admin', 'editor'].includes(user.role) ? onAccessChange : null}
                userRole={user.role}
                isDeleting={deletingDocName === doc.name}
              />
            ))}
          </div>

          {/* Knowledge Leaderboard */}
          <div
            className="mt-6 pt-4 border-t"
            style={{ borderTop: '1px solid var(--dc-border)' }}
          >
            <KnowledgeLeaderboard />
          </div>
        </div>

        {/* Refresh button */}
        <button
          onClick={() => onRefresh?.()}
          disabled={isRefreshingDocs}
          type="button"
          title={isRefreshingDocs ? 'Refreshing document list' : 'Refresh document list'}
          aria-label={isRefreshingDocs ? 'Refreshing knowledge base' : 'Refresh knowledge base'}
          className="p-4 border-t flex items-center gap-2 transition shrink-0 disabled:opacity-60"
          style={{
            borderColor: 'var(--dc-border)',
            color: 'var(--dc-text-secondary)',
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = 'var(--dc-text-primary)')
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = 'var(--dc-text-secondary)')
          }
        >
          <RefreshCw size={16} className={isRefreshingDocs ? 'animate-spin' : ''} />
          <span className="text-xs">{isRefreshingDocs ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </aside>

      {/* ═══════════════════════════════════════════════════════
          CENTER PANEL — Nexconn Chat
          ═══════════════════════════════════════════════════════ */}
      <main
        className="flex flex-col overflow-hidden"
        style={{
          background: 'var(--dc-surface-0)',
          border: '1px solid var(--dc-border)',
          borderRadius: '14px',
          boxShadow: 'var(--dc-shadow-card)',
        }}
      >
        {/* Chat header */}
        <div
          className="flex items-center justify-between gap-3 px-6 py-2 border-b shrink-0"
          style={{ borderColor: 'var(--dc-border)' }}
        >
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ background: 'var(--dc-green)', boxShadow: '0 0 8px var(--dc-green)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--dc-text-secondary)' }}>{chatMode === 'ai' ? 'DeepContext AI' : 'Nexconn Channel'}</span>
            <span className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>· {user?.name ?? 'User'}</span>
          </div>
          <div className="flex rounded-lg p-1" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}>
            <button type="button" onClick={() => setChatMode('ai')} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px]" style={{ background: chatMode === 'ai' ? 'var(--dc-brand-dim)' : 'transparent', color: chatMode === 'ai' ? 'var(--dc-brand-glow)' : 'var(--dc-text-muted)' }}><Bot size={13} />AI assistant</button>
            <button type="button" onClick={() => setChatMode('nexconn')} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px]" style={{ background: chatMode === 'nexconn' ? 'var(--dc-brand-dim)' : 'transparent', color: chatMode === 'nexconn' ? 'var(--dc-brand-glow)' : 'var(--dc-text-muted)' }}><MessagesSquare size={13} />Nexconn</button>
          </div>
        </div>

        {/* Chat body */}
        <div className="flex-1 overflow-hidden">
          <NexconnChat
            mode={chatMode}
            user={user}
            ingestState={ingestState}
            onIngestStart={onIngestStart}
            onIngestEvent={onIngestEvent}
            onIngestComplete={onIngestComplete}
            onIngestFailed={onIngestFailed}
            onDismissIngest={onDismissIngest}
            onResponse={handleChatResponse}
          />
        </div>
      </main>

      {/* ═══════════════════════════════════════════════════════
          RIGHT PANEL — Interactive Workspace (split top/bottom)
          ═══════════════════════════════════════════════════════ */}
      <aside
        className="flex flex-col overflow-hidden gap-3"
      >
        {/* Top half — AI Canvas */}
        <section className="flex flex-col overflow-hidden" style={{ height: '55%', minHeight: '260px', background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border)', borderRadius: '14px', boxShadow: 'var(--dc-shadow-card)' }}>
        <div
          className="flex items-center justify-between px-4 py-3 border-b shrink-0"
          style={{ borderColor: 'var(--dc-border)' }}
        >
          <div className="flex items-center gap-2">
            <GitBranch size={14} style={{ color: 'var(--dc-brand)' }} />
            <div><span className="block text-xs font-semibold" style={{ color: 'var(--dc-text-primary)' }}>Live Context Board</span><span className="block text-[9px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>AI Canvas powered by React Flow</span></div>
          </div>
        </div>

        <div className="flex-1 p-3 overflow-hidden" style={{ minHeight: 0 }}>
          <AICanvas flowData={flowData} />
        </div>
        </section>

        {/* Bottom half — Tabbed area */}
        <section
          className="flex-1 overflow-hidden"
          style={{
            minHeight: '180px',
            background: 'var(--dc-surface-0)',
            border: '1px solid var(--dc-border)',
            borderRadius: '14px',
            boxShadow: 'var(--dc-shadow-card)',
          }}
        >
          {/* Tab bar */}
          <div
            className="flex border-b shrink-0"
            style={{ borderColor: 'var(--dc-border)' }}
          >
            {RIGHT_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className="flex items-center gap-1.5 px-4 py-2.5 transition-all"
                  style={{
                    borderBottom: isActive
                      ? '2px solid var(--dc-brand)'
                      : '2px solid transparent',
                    color: isActive
                      ? 'var(--dc-text-primary)'
                      : 'var(--dc-text-muted)',
                  }}
                >
                  <Icon size={12} />
                  <span className="text-[11px] font-medium">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div style={{ height: 'calc(100% - 38px)' }}>
            {activeTab === 'pullrequests' && <DocumentPullRequest user={user} onComplete={onRefresh} />}
            {activeTab === 'metrics' && <CitationMetrics sources={lastSources} />}
          </div>
        </section>
      </aside>
    </div>
  );
}
