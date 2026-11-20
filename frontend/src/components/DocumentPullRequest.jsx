import { useCallback, useEffect, useState } from 'react';
import { Check, X, FileText, Clock, RefreshCw, Inbox, ShieldCheck, LoaderCircle } from 'lucide-react';
import api from '../utils/api.util';
import { waitForIngestProgress } from '../utils/ingestProgress.util';

/**
 * DocumentPullRequest — lists pending uploads awaiting approval.
 * Admins can Approve (triggers ChromaDB ingestion) or Reject.
 */
export default function DocumentPullRequest({ user, onComplete, onCountChange }) {
  const canApprove = ['editor', 'admin', 'owner'].includes(user?.role);
  const [pendingDocs, setPendingDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const fetchPending = useCallback(async (announce = false) => {
    setLoading(true);
    try {
      const res = await api.get('/pending-documents', {
        params: { refresh: Date.now() },
        headers: { 'Cache-Control': 'no-cache' },
      });
      const documents = res.data?.documents ?? [];
      setPendingDocs(documents);
      onCountChange?.(documents.length);
      if (announce) setFeedback({ type: 'success', message: 'Pull requests refreshed.' });
    } catch (err) {
      console.error('Failed to fetch pending documents', err);
      setFeedback({ type: 'error', message: err?.response?.data?.detail || 'Could not refresh pull requests.' });
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    fetchPending(false);
    const refreshFromUpload = () => fetchPending(false);
    window.addEventListener('documents-pending', refreshFromUpload);
    return () => window.removeEventListener('documents-pending', refreshFromUpload);
  }, [fetchPending]);

  const handleApprove = async (documentId) => {
    setActioningId(documentId);
    setFeedback(null);
    try {
      const res = await api.post(`/approve-document/${documentId}`);
      setFeedback({
        type: 'success',
        message: res.data?.message || 'Document approved. Ingestion started.',
      });
      await fetchPending(false);
      if (res.data?.job_id) {
        const progress = await waitForIngestProgress(res.data.job_id, {
          onEvent: (event) => setFeedback({ type: event.stage === 'failed' ? 'error' : 'success', message: event.message || 'Processing document…' }),
        });
        if (progress.ok) {
          await onComplete?.();
          window.dispatchEvent(new Event('document-indexed'));
        } else if (progress.fallback) {
          setFeedback({ type: 'success', message: 'Ingestion is running. Refresh the knowledge base when processing finishes.' });
        }
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err?.response?.data?.detail || 'Failed to approve document.',
      });
    } finally {
      setActioningId(null);
    }
  };

  const handleReject = async (documentId) => {
    setActioningId(documentId);
    setFeedback(null);
    try {
      const res = await api.post(`/reject-document/${documentId}`);
      setFeedback({
        type: 'success',
        message: res.data?.message || 'Document rejected.',
      });
      await fetchPending(false);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err?.response?.data?.detail || 'Failed to reject document.',
      });
    } finally {
      setActioningId(null);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 shrink-0">
        <p className="text-xs" style={{ color: 'var(--dc-text-muted)' }}>{loading ? 'Checking review queue…' : pendingDocs.length ? `${pendingDocs.length} upload${pendingDocs.length === 1 ? '' : 's'} waiting for review` : 'No uploads waiting for review'}</p>
        <button
          onClick={() => fetchPending(true)}
          disabled={loading}
          type="button"
          aria-label={loading ? 'Refreshing pull requests' : 'Refresh pull requests'}
          title={loading ? 'Refreshing pull requests' : 'Refresh pull requests'}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition disabled:opacity-60"
          style={{ color: 'var(--dc-text-secondary)' }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = 'var(--dc-text-primary)')
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = 'var(--dc-text-muted)')
          }
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Feedback */}
      {feedback && (
        <div
          className="mx-4 flex items-start gap-2 px-3 py-2 rounded-lg text-xs leading-relaxed shrink-0"
          style={{
            background:
              feedback.type === 'success'
                ? 'rgba(16, 185, 129, 0.1)'
                : 'rgba(244, 63, 94, 0.1)',
            color:
              feedback.type === 'success'
                ? 'var(--dc-green)'
                : 'var(--dc-red)',
          }}
        >
          {feedback.type === 'success' ? <Check size={14} className="mt-0.5 shrink-0" /> : <X size={14} className="mt-0.5 shrink-0" />}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-3">
        {loading && pendingDocs.length === 0 ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-xs" style={{ color: 'var(--dc-text-muted)' }}>
            <LoaderCircle size={20} className="animate-spin" style={{ color: 'var(--dc-brand)' }} />
            <span>Checking for new requests…</span>
          </div>
        ) : pendingDocs.length === 0 ? (
          <div className="flex h-full min-h-28 flex-col items-center justify-center px-5 pb-3 text-center">
            <span className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--dc-green)' }}>
              <Inbox size={19} />
            </span>
            <p className="text-sm font-semibold" style={{ color: 'var(--dc-text-primary)' }}>You’re all caught up</p>
            <p className="mt-1 max-w-64 text-xs leading-relaxed" style={{ color: 'var(--dc-text-muted)' }}>New uploads will appear here automatically.</p>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--dc-border)' }}>
          {pendingDocs.map((doc) => (
            <div
              key={doc.document_id}
              className="py-3.5 first:pt-1"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}><FileText size={17} /></span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: 'var(--dc-text-primary)' }} title={doc.display_name || doc.source_name}>
                    {doc.display_name || doc.source_name}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1" style={{ color: 'var(--dc-text-muted)' }}>
                    <span className="text-[11px]">{formatSize(doc.file_size)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-[11px] flex items-center gap-1">
                      <Clock size={11} />
                      {doc.uploaded_at
                        ? new Date(doc.uploaded_at).toLocaleDateString()
                        : '—'}
                    </span>
                  </div>
                  <div className="mt-2 flex w-fit items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: 'var(--dc-violet-dim)', color: 'var(--dc-violet)' }}>
                    <ShieldCheck size={12} />
                    {doc.access_role || 'viewer'} and above
                  </div>
                </div>
              </div>

              {canApprove ? <div className="flex gap-2 mt-3 pl-12">
                <button
                  onClick={() => handleApprove(doc.document_id)}
                  disabled={actioningId === doc.document_id}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-50"
                  style={{
                    background: 'var(--dc-green)',
                    color: 'white',
                  }}
                  onMouseEnter={(e) => {
                    if (actioningId !== doc.document_id) {
                      e.currentTarget.style.background = '#059669';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--dc-green)';
                  }}
                >
                  {actioningId === doc.document_id ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
                  Approve & index
                </button>
                <button
                  onClick={() => handleReject(doc.document_id)}
                  disabled={actioningId === doc.document_id}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
                  style={{
                    background: 'var(--dc-surface-1)',
                    color: 'var(--dc-red)',
                  }}
                  onMouseEnter={(e) => {
                    if (actioningId !== doc.document_id) {
                      e.currentTarget.style.background = 'rgba(244, 63, 94, 0.18)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--dc-surface-1)';
                  }}
                >
                  <X size={12} />
                  Reject
                </button>
              </div> : <p className="mt-3 pl-12 text-xs" style={{ color: 'var(--dc-text-muted)' }}>Waiting for an editor or admin to review</p>}
            </div>
          ))}
          </div>
        )}
      </div>
    </div>
  );
}
