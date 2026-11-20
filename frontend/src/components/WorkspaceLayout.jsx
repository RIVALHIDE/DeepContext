import { useCallback, useMemo, useState } from 'react';
import { RefreshCw, GitBranch, FileCheck, BarChart3, Bot, MessagesSquare, ShieldCheck, History, Network, ArrowLeft } from 'lucide-react';
import DocCard from './docs/DocCard';
import IngestSidebarRow from './IngestSidebarRow';
import NexconnChat from './NexconnChat';
import AICanvas from './AICanvas';
import DocumentPullRequest from './DocumentPullRequest';
import CitationMetrics from './CitationMetrics';
import KnowledgeLeaderboard from './KnowledgeLeaderboard';
import LogoLockup from './brand/LogoLockup';
import { sourcesForDocuments } from '../utils/sourceName.util';

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
  const [pendingCount, setPendingCount] = useState(0);
  const [activeTab, setActiveTab] = useState('pullrequests');
  const [rightPanelView, setRightPanelView] = useState('activity');
  const [diagramHistory, setDiagramHistory] = useState([]);
  const [showMapHistory, setShowMapHistory] = useState(false);
  const [activeMapId, setActiveMapId] = useState(null);
  const [chatMode, setChatMode] = useState('ai');
  const showIngestSidebar = ['uploading', 'processing', 'pending_approval', 'failed'].includes(ingestState?.status);
  const workspaceSources = useMemo(
    () => sourcesForDocuments(lastSources, docs),
    [lastSources, docs]
  );

  const handleChatResponse = useCallback((data) => {
    if (!data) return;
    const suppliedHistory = Array.isArray(data.diagramHistory) ? data.diagramHistory : null;
    if (suppliedHistory) {
      setDiagramHistory(suppliedHistory);
      setActiveMapId(suppliedHistory.at(-1)?.id || null);
      setShowMapHistory(false);
    }

    // Update AICanvas with latest diagram flow data
    if (data.diagrams?.length) {
      const firstWithFlow = data.diagrams.find((d) => d.flow);
      if (firstWithFlow?.flow) {
        setFlowData(firstWithFlow.flow);
        setRightPanelView('context');
        if (!suppliedHistory) {
          const nextEntry = {
            id: `map-${Date.now()}`,
            title: firstWithFlow.title || firstWithFlow.name || 'Generated context map',
            summary: String(data.answer || '').replace(/\s+/g, ' ').trim().slice(0, 100),
            flow: firstWithFlow.flow,
          };
          setDiagramHistory((current) => [...current, nextEntry]);
          setActiveMapId(nextEntry.id);
          setShowMapHistory(false);
        }
      } else {
        setFlowData(null);
      }
    } else if (suppliedHistory) {
      // Loading a chat restores its most recently generated map. A normal
      // text-only answer should not make the current map disappear.
      setFlowData(suppliedHistory.at(-1)?.flow || null);
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
            docs={docs}
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

      {/* RIGHT PANEL — one workspace with switchable tools */}
      <aside className="min-h-0 overflow-hidden">
        <section
          className="flex h-full min-h-0 flex-col overflow-hidden"
          style={{
            background: 'var(--dc-surface-0)',
            border: '1px solid var(--dc-border)',
            borderRadius: '14px',
            boxShadow: 'var(--dc-shadow-card)',
          }}
        >
          <div className="shrink-0 p-2" style={{ background: 'var(--dc-surface-1)' }}>
            <h2 className="sr-only">Workspace tools</h2>
            <div className="grid grid-cols-2 gap-1 rounded-lg p-1" role="tablist" aria-label="Workspace tools" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border)' }}>
              <button
                type="button"
                role="tab"
                aria-selected={rightPanelView === 'activity'}
                onClick={() => setRightPanelView('activity')}
                aria-label="Review and evidence"
                className="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11px] font-semibold transition-all"
                style={{
                  background: rightPanelView === 'activity' ? 'var(--dc-surface-0)' : 'transparent',
                  boxShadow: rightPanelView === 'activity' ? '0 2px 8px rgba(30,52,78,.09)' : 'none',
                  color: rightPanelView === 'activity' ? 'var(--dc-violet)' : 'var(--dc-text-muted)',
                }}
              >
                <ShieldCheck size={14} />
                <span className="truncate">Review</span>
                {pendingCount > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px]" style={{ background: 'rgba(245,158,11,.13)', color: 'var(--dc-amber)' }}>{pendingCount}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightPanelView === 'context'}
                onClick={() => setRightPanelView('context')}
                className="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11px] font-semibold transition-all"
                style={{
                  background: rightPanelView === 'context' ? 'var(--dc-surface-0)' : 'transparent',
                  boxShadow: rightPanelView === 'context' ? '0 2px 8px rgba(30,52,78,.09)' : 'none',
                  color: rightPanelView === 'context' ? 'var(--dc-brand)' : 'var(--dc-text-muted)',
                }}
              >
                <GitBranch size={14} />
                <span className="truncate">Context map</span>
                {flowData?.nodes?.length ? <span className="h-2 w-2 shrink-0 rounded-full" title="Context map ready" style={{ background: 'var(--dc-green)', boxShadow: '0 0 0 3px rgba(16,185,129,.12)' }} /> : null}
              </button>
            </div>
          </div>

          {rightPanelView === 'activity' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="grid grid-cols-2 border-y px-2 shrink-0" role="tablist" aria-label="Review and evidence" style={{ borderColor: 'var(--dc-border)' }}>
                {RIGHT_TABS.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.key;
                  const count = tab.key === 'pullrequests' ? pendingCount : workspaceSources.length;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveTab(tab.key)}
                      className="relative flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold transition-all"
                      style={{ color: isActive ? 'var(--dc-brand)' : 'var(--dc-text-muted)', borderBottom: isActive ? '2px solid var(--dc-brand)' : '2px solid transparent' }}
                    >
                      <Icon size={14} />
                      <span>{tab.label}</span>
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px]" style={{ background: isActive ? 'var(--dc-brand-dim)' : 'var(--dc-surface-2)', color: isActive ? 'var(--dc-brand)' : 'var(--dc-text-muted)' }}>{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="min-h-0 flex-1">
                {activeTab === 'pullrequests' && <DocumentPullRequest user={user} onComplete={onRefresh} onCountChange={setPendingCount} />}
                {activeTab === 'metrics' && <CitationMetrics sources={workspaceSources} documents={docs} />}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-2 border-y px-3 py-2" style={{ borderColor: 'var(--dc-border)' }}>
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-semibold" style={{ color: 'var(--dc-text-primary)' }}>
                    {showMapHistory ? 'Map history' : 'Current map'}
                  </p>
                  <p className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>
                    {diagramHistory.length} saved in this chat
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowMapHistory((visible) => !visible)}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition"
                  style={{ background: 'var(--dc-surface-2)', color: 'var(--dc-text-secondary)', border: '1px solid var(--dc-border)' }}
                  aria-label={showMapHistory ? 'Return to current context map' : 'View context map history'}
                >
                  {showMapHistory ? <ArrowLeft size={13} /> : <History size={13} />}
                  {showMapHistory ? 'Back to map' : 'History'}
                </button>
              </div>

              <div className="min-h-0 flex-1">
                {showMapHistory ? (
                  <div className="h-full overflow-y-auto p-3 custom-scrollbar">
                    {diagramHistory.length ? (
                      <div className="space-y-2">
                        {[...diagramHistory].reverse().map((entry, reverseIndex) => {
                          const isActive = entry.id === activeMapId;
                          const mapNumber = diagramHistory.length - reverseIndex;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              onClick={() => {
                                setFlowData(entry.flow);
                                setActiveMapId(entry.id);
                                setShowMapHistory(false);
                              }}
                              className="flex w-full items-start gap-3 rounded-xl p-3 text-left transition"
                              style={{
                                background: isActive ? 'var(--dc-brand-dim)' : 'var(--dc-surface-1)',
                                border: `1px solid ${isActive ? 'var(--dc-brand)' : 'var(--dc-border)'}`,
                              }}
                            >
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--dc-surface-0)', color: 'var(--dc-brand)' }}>
                                <Network size={15} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-semibold" style={{ color: 'var(--dc-text-primary)' }}>
                                  {entry.title || `Context map ${mapNumber}`}
                                </span>
                                <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>
                                  {entry.flow?.nodes?.length || 0} nodes · {entry.flow?.edges?.length || 0} connections
                                </span>
                                {entry.summary ? (
                                  <span className="mt-1.5 block overflow-hidden text-[10px] leading-4" style={{ color: 'var(--dc-text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                                    {entry.summary}
                                  </span>
                                ) : null}
                              </span>
                              {isActive ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--dc-green)' }} /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}><History size={18} /></span>
                        <p className="text-xs font-semibold" style={{ color: 'var(--dc-text-primary)' }}>No saved maps in this chat</p>
                        <p className="mt-1 text-[11px] leading-4" style={{ color: 'var(--dc-text-muted)' }}>Generate a context map and it will appear here automatically.</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <AICanvas flowData={flowData} embedded />
                )}
              </div>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
