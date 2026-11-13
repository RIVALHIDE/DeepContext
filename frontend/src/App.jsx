import React, { useCallback, useEffect, useRef, useState } from 'react';
import WorkspaceLayout from './components/WorkspaceLayout';
import api from './utils/api.util';
import {
  buildIngestStatePatch,
  INITIAL_INGEST_STATE,
  STAGE_LABELS,
} from './utils/ingestProgress.util';
import ConfirmModal from './components/ui/ConfirmModal';

function App() {
  const [docs, setDocs] = useState([]);
  const [user] = useState({ username: 'anonymous', department: 'general' });
  const [deletingDocName, setDeletingDocName] = useState(null);
  const [pendingDeleteName, setPendingDeleteName] = useState(null);
  const [docActionMessage, setDocActionMessage] = useState('');
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

  const fetchDocs = useCallback(async () => {
    try {
      const res = await api.get('/retriveAllDocuments');
      setDocs(res.data.files);
    } catch (err) {
      console.error('Failed to fetch documents', err);
    }
  }, []);

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
        event?.stage === 'completed'
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

  const handleIngestComplete = async () => {
    await fetchDocs();
    setDocActionMessage('');
    scheduleDismiss(3500);
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
        onDelete={handleDeleteDocument}
        onRefresh={fetchDocs}
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
