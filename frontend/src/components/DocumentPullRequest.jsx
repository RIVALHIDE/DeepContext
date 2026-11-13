import { useCallback, useEffect, useState } from 'react';
import { Check, X, FileText, Clock, RefreshCw } from 'lucide-react';
import api from '../utils/api.util';

/**
 * DocumentPullRequest — lists pending uploads awaiting approval.
 * Admins can Approve (triggers ChromaDB ingestion) or Reject.
 */
export default function DocumentPullRequest() {
  const [pendingDocs, setPendingDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/pending-documents');
      setPendingDocs(res.data?.documents ?? []);
    } catch (err) {
      console.error('Failed to fetch pending documents', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPending();
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
      await fetchPending();
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
      await fetchPending();
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
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--dc-border)' }}
      >
        <span
          className="text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: 'var(--dc-text-muted)' }}
        >
          Document Pull Requests
        </span>
        <button
          onClick={fetchPending}
          className="p-1 rounded transition"
          style={{ color: 'var(--dc-text-muted)' }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = 'var(--dc-text-primary)')
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = 'var(--dc-text-muted)')
          }
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Feedback */}
      {feedback && (
        <div
          className="mx-3 mt-2 px-3 py-2 rounded-lg text-[11px] shrink-0"
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
          {feedback.message}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2 py-2 space-y-2">
        {loading && pendingDocs.length === 0 ? (
          <div
            className="text-center py-6 text-xs"
            style={{ color: 'var(--dc-text-muted)' }}
          >
            Loading…
          </div>
        ) : pendingDocs.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-8 gap-2"
            style={{ color: 'var(--dc-text-muted)' }}
          >
            <FileText size={20} style={{ opacity: 0.4 }} />
            <p className="text-[11px]">No pending documents</p>
          </div>
        ) : (
          pendingDocs.map((doc) => (
            <div
              key={doc.document_id}
              className="rounded-lg p-2.5 space-y-2"
              style={{
                background: 'var(--dc-surface-1)',
                border: '1px solid var(--dc-border)',
              }}
            >
              <div className="flex items-start gap-2">
                <FileText
                  size={14}
                  className="mt-0.5 shrink-0"
                  style={{ color: 'var(--dc-brand)' }}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className="text-xs font-medium truncate"
                    style={{ color: 'var(--dc-text-primary)' }}
                  >
                    {doc.source_name}
                  </p>
                  <div
                    className="flex items-center gap-2 mt-0.5"
                    style={{ color: 'var(--dc-text-muted)' }}
                  >
                    <span className="text-[10px]">{formatSize(doc.file_size)}</span>
                    <span className="text-[10px]">·</span>
                    <span className="text-[10px] flex items-center gap-0.5">
                      <Clock size={9} />
                      {doc.uploaded_at
                        ? new Date(doc.uploaded_at).toLocaleDateString()
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex gap-1.5">
                <button
                  onClick={() => handleApprove(doc.document_id)}
                  disabled={actioningId === doc.document_id}
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-medium transition-all disabled:opacity-50"
                  style={{
                    background: 'rgba(16, 185, 129, 0.12)',
                    color: 'var(--dc-green)',
                    border: '1px solid rgba(16, 185, 129, 0.2)',
                  }}
                  onMouseEnter={(e) => {
                    if (actioningId !== doc.document_id) {
                      e.currentTarget.style.background = 'rgba(16, 185, 129, 0.2)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(16, 185, 129, 0.12)';
                  }}
                >
                  <Check size={12} />
                  Approve
                </button>
                <button
                  onClick={() => handleReject(doc.document_id)}
                  disabled={actioningId === doc.document_id}
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-medium transition-all disabled:opacity-50"
                  style={{
                    background: 'rgba(244, 63, 94, 0.1)',
                    color: 'var(--dc-red)',
                    border: '1px solid rgba(244, 63, 94, 0.18)',
                  }}
                  onMouseEnter={(e) => {
                    if (actioningId !== doc.document_id) {
                      e.currentTarget.style.background = 'rgba(244, 63, 94, 0.18)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(244, 63, 94, 0.1)';
                  }}
                >
                  <X size={12} />
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
