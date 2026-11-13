import { useCallback, useState } from 'react';
import { RefreshCw, GitBranch, FileCheck, BarChart3 } from 'lucide-react';
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
      className="grid h-screen"
      style={{
        gridTemplateColumns: '280px 1fr 400px',
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
          borderRight: '1px solid var(--dc-border)',
        }}
      >
        {/* Brand */}
        <div
          className="p-6 border-b flex items-center"
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
            {isIngestActive && <IngestSidebarRow ingestState={ingestState} />}

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
                onDelete={['owner', 'admin'].includes(user.role) ? onDelete : null}
                onAccessChange={['owner', 'admin'].includes(user.role) ? onAccessChange : null}
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
          onClick={onRefresh}
          type="button"
          title="Refresh document list"
          className="p-4 border-t flex items-center gap-2 transition shrink-0"
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
          <RefreshCw size={16} /> <span className="text-xs">Refresh</span>
        </button>
      </aside>

      {/* ═══════════════════════════════════════════════════════
          CENTER PANEL — Nexconn Chat
          ═══════════════════════════════════════════════════════ */}
      <main
        className="flex flex-col overflow-hidden"
        style={{
          background:
            'linear-gradient(to bottom, var(--dc-surface-0), var(--dc-surface-3))',
        }}
      >
        {/* Chat header */}
        <div
          className="flex items-center gap-2 px-6 py-3 border-b shrink-0"
          style={{ borderColor: 'var(--dc-border)' }}
        >
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: 'var(--dc-green)', boxShadow: '0 0 8px var(--dc-green)' }}
          />
          <span
            className="text-xs font-semibold"
            style={{ color: 'var(--dc-text-secondary)' }}
          >
            Nexconn Channel
          </span>
          <span className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>
            · {user?.name ?? 'User'}
          </span>
        </div>

        {/* Chat body */}
        <div className="flex-1 overflow-hidden">
          <NexconnChat
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
        className="flex flex-col overflow-hidden"
        style={{
          background: 'var(--dc-surface-0)',
          borderLeft: '1px solid var(--dc-border)',
        }}
      >
        {/* Top half — AI Canvas */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b shrink-0"
          style={{ borderColor: 'var(--dc-border)' }}
        >
          <div className="flex items-center gap-2">
            <GitBranch size={14} style={{ color: 'var(--dc-brand)' }} />
            <span
              className="text-xs font-semibold"
              style={{ color: 'var(--dc-text-secondary)' }}
            >
              AI Canvas
            </span>
          </div>
        </div>

        <div className="flex-1 p-3 overflow-hidden" style={{ minHeight: 0 }}>
          <AICanvas flowData={flowData} />
        </div>

        {/* Bottom half — Tabbed area */}
        <div
          className="border-t"
          style={{
            borderColor: 'var(--dc-border)',
            height: '45%',
            minHeight: '180px',
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
          <div className="h-[calc(100%-37px)]">
            {activeTab === 'pullrequests' && <DocumentPullRequest user={user} onComplete={onRefresh} />}
            {activeTab === 'metrics' && <CitationMetrics sources={lastSources} />}
          </div>
        </div>
      </aside>
    </div>
  );
}
