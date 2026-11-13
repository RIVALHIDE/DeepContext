import React, { useCallback, useEffect, useRef, useState } from 'react';
import WorkspaceLayout from './components/WorkspaceLayout';
import api from './utils/api.util';
import {
  buildIngestStatePatch,
  INITIAL_INGEST_STATE,
  STAGE_LABELS,
} from './utils/ingestProgress.util';
import ConfirmModal from './components/ui/ConfirmModal';

function App({ user }) {
  const [docs, setDocs] = useState([]);
  const [deletingDocName, setDeletingDocName] = useState(null);
  const [pendingDeleteName, setPendingDeleteName] = useState(null);
  const [docActionMessage, setDocActionMessage] = useState('');
  const [isRefreshingDocs, setIsRefreshingDocs] = useState(false);
  const [ingestState, setIngestState] = useState(INITIAL_INGEST_STATE);
  const dismissTimerRef = useRef(null);

  const clearDismissTimer = () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  };

  const scheduleDismiss = (delayMs = 3000) => {
    clearDismissTimer();
    dismissTimerRef.current = setTimeout(() => {
      setIngestState(INITIAL_INGEST_STATE);
    }, delayMs);
  };

  useEffect(() => () => clearDismissTimer(), []);

  const fetchDocs = useCallback(async ({ announce = false } = {}) => {
    setIsRefreshingDocs(true);
    try {
      const res = await api.get('/retriveAllDocuments', {
        params: { refresh: Date.now() },
        headers: { 'Cache-Control': 'no-cache' },
      });
      const nextDocs = res.data?.files ?? [];
      setDocs(nextDocs);
      if (announce) {
        setDocActionMessage(`Knowledge base refreshed · ${nextDocs.length} ${nextDocs.length === 1 ? 'document' : 'documents'}.`);
      }
      return nextDocs;
    } catch (err) {
      console.error('Failed to fetch documents', err);
      setDocActionMessage(err?.response?.data?.detail || 'Refresh failed. Check that the API is running and try again.');
      return null;
    } finally {
      setIsRefreshingDocs(false);
    }
  }, []);

  const handleManualRefresh = useCallback(() => fetchDocs({ announce: true }), [fetchDocs]);

  const handleAccessChange = async (sourceName, accessRole) => {
    try {
      await api.patch(`/documents/${encodeURIComponent(sourceName)}/access`, { access_role: accessRole });
      setDocActionMessage('Document access updated.');
      await fetchDocs();
    } catch (error) {
      setDocActionMessage(error?.response?.data?.detail || 'Could not update document access.');
    }
  };

  const handleDeleteDocument = (sourceName) => {
    if (!sourceName || deletingDocName) return;
    setPendingDeleteName(sourceName);
  };

  const confirmDeleteDocument = async () => {
    const sourceName = pendingDeleteName;
    if (!sourceName) return;
    setPendingDeleteName(null);

    try {
      setDeletingDocName(sourceName);
      setDocActionMessage('');
      const res = await api.delete(`/deleteDocument/${encodeURIComponent(sourceName)}`);
      const message = res?.data?.message || 'Document deleted successfully.';
      setDocActionMessage(message);
      await fetchDocs();
    } catch (err) {
      console.error('Failed to delete document', err);
      setDocActionMessage('Failed to delete document.');
    } finally {
      setDeletingDocName(null);
    }
  };

  const handleIngestStart = (fileName) => {
    clearDismissTimer();
    setIngestState({
      status: 'uploading',
      fileName,
      stage: null,
      message: 'Uploading to server…',
      percent: 5,
      meta: {},
    });
  };

  const handleIngestEvent = (event) => {
    setIngestState((prev) => {
      const patch = buildIngestStatePatch(event, prev.fileName);
      const nextStatus =
        event?.stage === 'pending_approval'
          ? 'pending_approval'
          : event?.stage === 'completed'
          ? 'completed'
          : event?.stage === 'failed'
            ? 'failed'
            : 'processing';

      return {
        ...prev,
        status: nextStatus,
        ...patch,
      };
    });
  };

  useEffect(() => {
    const indexed = () => {
      fetchDocs();
      setIngestState(INITIAL_INGEST_STATE);
    };
    window.addEventListener('document-indexed', indexed);
    return () => window.removeEventListener('document-indexed', indexed);
  }, [fetchDocs]);

  const handleIngestComplete = async () => {
    await fetchDocs();
    setDocActionMessage('');
    scheduleDismiss(1800);
  };

  const handleIngestFailed = (event) => {
    setIngestState((prev) => ({
      ...prev,
      status: 'failed',
      message: event?.message || STAGE_LABELS.failed,
    }));
    scheduleDismiss(6000);
  };

  const handleDismissIngest = () => {
    clearDismissTimer();
    setIngestState(INITIAL_INGEST_STATE);
  };

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  const isIngestActive = ingestState.status !== 'idle';

  return (
    <>
      <WorkspaceLayout
        user={user}
        docs={docs}
        docActionMessage={docActionMessage}
        ingestState={ingestState}
        isIngestActive={isIngestActive}
        deletingDocName={deletingDocName}
        isRefreshingDocs={isRefreshingDocs}
        onDelete={handleDeleteDocument}
        onAccessChange={handleAccessChange}
        onRefresh={handleManualRefresh}
        onIngestStart={handleIngestStart}
        onIngestEvent={handleIngestEvent}
        onIngestComplete={handleIngestComplete}
        onIngestFailed={handleIngestFailed}
        onDismissIngest={handleDismissIngest}
      />

      <ConfirmModal
        isOpen={!!pendingDeleteName}
        title="Delete document?"
        description={pendingDeleteName ? `Delete "${pendingDeleteName}" — this cannot be undone.` : ''}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger={true}
        onConfirm={confirmDeleteDocument}
        onCancel={() => setPendingDeleteName(null)}
      />
    </>
  );
}

export default App;
