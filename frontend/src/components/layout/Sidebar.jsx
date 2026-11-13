import { RefreshCw } from 'lucide-react';
import LogoLockup from '../brand/LogoLockup';
import DocCard from '../docs/DocCard';
import IngestSidebarRow from '../IngestSidebarRow';

export default function Sidebar({
  docs,
  docActionMessage,
  ingestState,
  isIngestActive,
  deletingDocName,
  onDelete,
  onRefresh,
}) {
  const showEmptyDocs = (!docs || docs.length === 0) && !isIngestActive;

  return (
    <>
      <div
        className="p-6 border-b flex items-center"
        style={{ borderColor: 'var(--dc-border)' }}
      >
        <LogoLockup state="idle" size={32} />
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <h2
          className="text-[10px] font-semibold mb-4 uppercase tracking-widest"
          style={{ color: 'var(--dc-text-muted)' }}
        >
          Knowledge Base
        </h2>

        {docActionMessage && (
          <p className="mb-3 text-[11px]" style={{ color: 'var(--dc-text-secondary)' }}>
            {docActionMessage}
          </p>
        )}

        <div className="space-y-2">
          {isIngestActive && <IngestSidebarRow ingestState={ingestState} />}

          {showEmptyDocs && (
            <div
              className="rounded-xl border border-dashed p-4 text-xs"
              style={{ borderColor: 'var(--dc-border-strong)', color: 'var(--dc-text-muted)' }}
            >
              No documents available.
            </div>
          )}

          {docs?.map((doc, i) => (
            <DocCard
              key={i}
              doc={doc}
              onDelete={onDelete}
              isDeleting={deletingDocName === doc.name}
            />
          ))}
        </div>
      </div>

      <button
        onClick={onRefresh}
        type="button"
        title="Refresh document list"
        className="p-4 border-t flex items-center gap-2 transition"
        style={{ borderColor: 'var(--dc-border)', color: 'var(--dc-text-secondary)' }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--dc-text-primary)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--dc-text-secondary)'}
      >
        <RefreshCw size={16} /> <span className="text-xs">Refresh</span>
      </button>
    </>
  );
}
