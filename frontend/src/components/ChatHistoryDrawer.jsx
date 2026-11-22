import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, FileCheck2, MessageSquarePlus, ShieldCheck, UploadCloud, Video, X } from 'lucide-react';
import api from '../utils/api.util';
import {
  STAGE_LABELS,
  waitForIngestProgress,
} from '../utils/ingestProgress.util';
import { ensureInitialChatSession, getChatSessions } from '../utils/chatSessions.util';
import ConfirmModal from './ui/ConfirmModal';
import NexconnHuddle from './NexconnHuddle';
import { knowledgeFileError } from '../utils/uploadFormats.util';

function uploadValidationError(file) {
  return knowledgeFileError(file);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ChatHistoryDrawer({
  user,
  activeSessionId,
  sessionsVersion,
  onSelectSession,
  onNewChat,
  onIngestStart,
  onIngestEvent,
  onIngestComplete,
  onIngestFailed,
  isUploading = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [accessRole, setAccessRole] = useState(user?.role || 'viewer');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [batchRows, setBatchRows] = useState([]);
  const [batchUploading, setBatchUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [huddleOpen, setHuddleOpen] = useState(false);
  const canUpload = ['member', 'editor', 'admin', 'owner'].includes(user?.role);
  const canSelfApprove = ['editor', 'admin', 'owner'].includes(user?.role);

  const username = user?.username ?? null;

  const openUploadModal = useCallback(() => {
    if (!canUpload || isUploading) return;
    setUploadError('');
    setSelectedFiles([]);
    setBatchRows([]);
    setUploadOpen(true);
  }, [canUpload, isUploading]);

  const sortedSessions = useMemo(() => {
    const arr = Array.isArray(sessions) ? [...sessions] : [];
    arr.sort((a, b) => {
      const at = a?.lastMessageAt || a?.createdAt || '';
      const bt = b?.lastMessageAt || b?.createdAt || '';
      return bt.localeCompare(at);
    });
    return arr;
  }, [sessions]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    const openFromComposer = () => openUploadModal();
    window.addEventListener('deepcontext-open-upload', openFromComposer);
    return () => window.removeEventListener('deepcontext-open-upload', openFromComposer);
  }, [openUploadModal]);

  useEffect(() => {
    if (!username) return;
    (async () => {
      await ensureInitialChatSession(username);
      const nextSessions = await getChatSessions();
      setSessions(nextSessions);
    })();
  }, [username, sessionsVersion, isOpen]);

  const pollJobStatus = async (jobId, fileName, batchLabel = fileName) => {
    const maxAttempts = 300;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await api.get(`/job-status/${jobId}`);
        const { status, stage, message } = res.data ?? {};

        if (stage) {
          onIngestEvent?.({
            stage,
            message,
            meta: { file_name: batchLabel },
          });
        }

        if (status === 'completed') {
          onIngestEvent?.({
            stage: 'completed',
            message: STAGE_LABELS.completed,
            meta: { file_name: batchLabel },
          });
          return { ok: true };
        }
        if (status === 'failed' || status === 'not_found') {
          onIngestEvent?.({
            stage: 'failed',
            message: message || STAGE_LABELS.failed,
            meta: { file_name: batchLabel },
          });
          return { ok: false, message: message || STAGE_LABELS.failed };
        }
      } catch {
        onIngestFailed?.({ message: 'Error while checking job status.' });
        return { ok: false };
      }
      await delay(2000);
    }

    onIngestFailed?.({ message: 'Processing is taking longer than expected.' });
    return { ok: false };
  };

  const updateBatchRow = (index, patch) => {
    setBatchRows((previous) => previous.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };

  const monitorBatchJobs = async (jobs, batchLabel) => {
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      updateBatchRow(job.index, { status: 'processing', detail: 'Indexing…' });
      const progressResult = await waitForIngestProgress(job.jobId, {
        onEvent: (event) => {
          updateBatchRow(job.index, { status: 'processing', detail: event?.message || 'Indexing…' });
          onIngestEvent?.({
            ...event,
            message: `${job.file.name}: ${event?.message || 'Indexing…'}`,
            meta: { ...(event?.meta || {}), file_name: batchLabel },
          });
        },
      });
      const result = progressResult.fallback
        ? await pollJobStatus(job.jobId, job.file.name, batchLabel)
        : { ok: progressResult.ok, message: progressResult.event?.message };
      if (result.ok) {
        completed += 1;
        updateBatchRow(job.index, { status: 'completed', detail: 'Ready in knowledge base' });
      } else {
        failed += 1;
        updateBatchRow(job.index, { status: 'failed', detail: result.message || STAGE_LABELS.failed });
      }
      onIngestEvent?.({
        stage: failed ? 'processing' : 'indexing',
        message: `${completed + failed} of ${jobs.length} files processed`,
        meta: { file_name: batchLabel },
      });
    }
    if (completed) await onIngestComplete?.();
    if (failed) onIngestFailed?.({ message: `${failed} file${failed === 1 ? '' : 's'} failed. Other files continued processing.` });
  };

  const handleUpload = async (files) => {
    const chosen = Array.from(files || []);
    if (!chosen.length || batchUploading) return;

    const rows = chosen.map((file) => {
      const error = uploadValidationError(file);
      return { file, status: error ? 'failed' : 'waiting', detail: error };
    });
    setBatchRows(rows);
    const valid = rows.map((row, index) => ({ ...row, index })).filter((row) => !row.detail);
    if (!valid.length) {
      setUploadError('None of the selected files can be uploaded. Check the per-file errors below.');
      return;
    }

    setUploadError('');
    setBatchUploading(true);
    const batchLabel = valid.length === 1 ? valid[0].file.name : `${valid.length} files`;
    onIngestStart?.(batchLabel);
    const jobs = [];
    let pendingCount = 0;
    let accepted = 0;
    let failed = rows.length - valid.length;
    let firstFailure = rows.find((row) => row.detail)?.detail || '';

    for (const item of valid) {
      updateBatchRow(item.index, { status: 'uploading', detail: 'Uploading to server…' });
      const formData = new FormData();
      formData.append('file', item.file);
      formData.append('access_role', accessRole);
      try {
        const response = await api.post('/upload', formData);
        accepted += 1;
        if (response.data?.status === 'pending_approval') {
          pendingCount += 1;
          updateBatchRow(item.index, { status: 'pending', detail: 'Waiting for approval' });
        } else if (response.data?.job_id) {
          jobs.push({ index: item.index, file: item.file, jobId: response.data.job_id });
          updateBatchRow(item.index, { status: 'queued', detail: 'Queued for indexing' });
        } else {
          updateBatchRow(item.index, { status: 'completed', detail: 'Upload complete' });
        }
      } catch (error) {
        failed += 1;
        const detail = error?.response?.data?.detail;
        const failureDetail = typeof detail === 'string'
          ? detail
          : error?.code === 'ECONNABORTED'
            ? 'Upload timed out while the API or storage service was waking up'
            : error?.message === 'Network Error'
              ? 'Network or CORS error while contacting the upload API'
              : `Upload failed${error?.response?.status ? ` (HTTP ${error.response.status})` : ''}`;
        if (!firstFailure) firstFailure = failureDetail;
        updateBatchRow(item.index, {
          status: 'failed',
          detail: failureDetail,
        });
      }
    }

    setBatchUploading(false);
    if (pendingCount) {
      onIngestEvent?.({
        stage: 'pending_approval',
        message: `${pendingCount} file${pendingCount === 1 ? '' : 's'} uploaded and waiting for approval.`,
        meta: { file_name: batchLabel },
      });
      window.dispatchEvent(new Event('documents-pending'));
    } else if (jobs.length) {
      onIngestEvent?.({ stage: 'indexing', message: `${jobs.length} files queued safely for indexing.`, meta: { file_name: batchLabel } });
    } else if (accepted) {
      await onIngestComplete?.();
    }
    if (failed) {
      setUploadError(`${failed} file${failed === 1 ? '' : 's'} could not be accepted.${firstFailure ? ` ${firstFailure}` : ''}`);
    }
    if (jobs.length) monitorBatchJobs(jobs, batchLabel);
  };

  const [pendingDeleteSession, setPendingDeleteSession] = useState(null);

  const deleteChatFunction = (sessionId) => {
    if (!sessionId) return;
    setPendingDeleteSession(sessionId);
  };

  const confirmDeleteChat = async () => {
    const sessionId = pendingDeleteSession;
    if (!sessionId) return setPendingDeleteSession(null);
    setPendingDeleteSession(null);
    try {
      await api.post(`/delete-chat/${sessionId}`);
      const nextSessions = await getChatSessions();
      setSessions(nextSessions);
    } catch (err) {
      console.log(err);
      alert('Failed to delete chat.');
    }
  };

  return (
    <div className="w-full flex justify-end gap-2 mb-3">
      <button
        type="button"
        onClick={() => typeof onNewChat === 'function' && onNewChat()}
        className="inline-flex items-center gap-2 text-xs rounded-xl px-3 py-2 transition"
        style={{ color: 'var(--dc-text-secondary)', background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--dc-text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--dc-text-secondary)'; }}
      >
        <MessageSquarePlus size={14} />
        New Chat
      </button>

      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-2 text-xs rounded-xl px-3 py-2 transition"
        style={{ color: 'var(--dc-text-secondary)', background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--dc-text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--dc-text-secondary)'; }}
      >
        <Clock size={14} />
        Chat History
      </button>

      {canUpload && <select aria-label="Document access level" value={accessRole} onChange={(event) => setAccessRole(event.target.value)} className="text-xs rounded-xl px-2" style={{ background: 'var(--dc-surface-1)', color: 'var(--dc-text-primary)' }}>
        <option value="viewer">Everyone in workspace</option>
        <option value="member">Members and above</option>
        {['editor', 'admin', 'owner'].includes(user.role) && <option value="editor">Editors and above</option>}
        {['admin', 'owner'].includes(user.role) && <option value="admin">Admins and owner</option>}
        {user.role === 'owner' && <option value="owner">Owner only</option>}
      </select>}
      <button
        type="button"
        onClick={() => setHuddleOpen(true)}
        className="inline-flex items-center gap-2 text-xs rounded-xl px-3 py-2 transition"
        style={{ color: '#08784f', background: 'rgba(16,185,129,.12)', border: '1px solid rgba(16,185,129,.28)' }}
      >
        <Video size={14} />
        Huddle
      </button>

      {canUpload && <button
        type="button"
        onClick={openUploadModal}
        disabled={isUploading}
        className="inline-flex items-center gap-2 text-xs border rounded-xl px-3 py-2 transition disabled:opacity-50"
        style={{ color: 'var(--dc-text-secondary)', background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)', cursor: isUploading ? 'not-allowed' : 'pointer' }}
      >
        <UploadCloud size={14} />
        {isUploading ? 'Uploading…' : 'Upload'}
      </button>}

      {uploadOpen && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-5" style={{ background: 'rgba(15,23,42,.36)', backdropFilter: 'blur(5px)' }} onClick={() => !batchUploading && setUploadOpen(false)}>
          <section className="w-full max-w-lg rounded-2xl p-5" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border)', boxShadow: '0 24px 70px rgba(15,23,42,.22)' }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex gap-3">
                <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}><UploadCloud size={19} /></span>
                <div><h2 className="text-sm font-semibold">Upload knowledge</h2><p className="text-[11px] mt-1" style={{ color: 'var(--dc-text-muted)' }}>{canSelfApprove ? 'Your role can index this file immediately.' : 'Files enter the approval queue before indexing.'}</p></div>
              </div>
              <button type="button" onClick={() => setUploadOpen(false)} disabled={batchUploading} className="p-1.5 rounded-lg" style={{ color: 'var(--dc-text-muted)' }} aria-label="Close upload dialog"><X size={16} /></button>
            </div>

            <div className="grid grid-cols-2 gap-2 my-4">
              <div className="rounded-xl p-3 flex gap-2" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}><ShieldCheck size={15} style={{ color: 'var(--dc-green)' }} /><div><p className="text-[11px] font-semibold">Maximum 15MB each</p><p className="text-[10px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>Files upload one at a time safely</p></div></div>
              <div className="rounded-xl p-3 flex gap-2" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}><FileCheck2 size={15} style={{ color: 'var(--dc-brand)' }} /><div><p className="text-[11px] font-semibold">Mixed formats</p><p className="text-[10px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>Documents, data, images and Office</p></div></div>
            </div>

            <label className="block rounded-xl border border-dashed p-5 text-center cursor-pointer" style={{ borderColor: selectedFiles.length ? 'var(--dc-brand)' : 'var(--dc-border-strong)', background: selectedFiles.length ? 'var(--dc-brand-dim)' : 'var(--dc-surface-1)' }}>
              <input type="file" multiple className="hidden" disabled={batchUploading} onChange={(event) => { const files = Array.from(event.target.files || []); setSelectedFiles(files); setBatchRows(files.map((file) => { const error = uploadValidationError(file); return { file, status: error ? 'failed' : 'waiting', detail: error || 'Ready to upload' }; })); setUploadError(''); }} />
              <UploadCloud size={22} className="mx-auto mb-2" style={{ color: 'var(--dc-brand)' }} />
              <p className="text-xs font-medium">{selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} selected` : 'Choose multiple files to upload'}</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--dc-text-muted)' }}>{selectedFiles.length ? `${(selectedFiles.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(2)} MB total` : 'You can mix PDF, text/data, images, Office and diagram files'}</p>
            </label>

            {batchRows.length > 0 && <div className="mt-3 max-h-44 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
              {batchRows.map((row, index) => <div key={`${row.file.name}-${index}`} className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: row.status === 'failed' ? 'var(--dc-red)' : row.status === 'completed' ? 'var(--dc-green)' : row.status === 'pending' ? '#f59e0b' : 'var(--dc-brand)' }} />
                <span className="min-w-0 flex-1 text-[11px] font-medium truncate">{row.file.name}</span>
                <span className="max-w-[55%] text-[9px] text-right leading-tight" title={row.detail} style={{ color: row.status === 'failed' ? 'var(--dc-red)' : 'var(--dc-text-muted)' }}>{row.detail}</span>
              </div>)}
            </div>}

            <label className="block text-[11px] font-medium mt-4">Minimum access level<select value={accessRole} onChange={(event) => setAccessRole(event.target.value)} className="w-full mt-1.5 rounded-lg px-3 py-2" style={{ background: 'var(--dc-surface-1)', color: 'var(--dc-text-primary)', border: '1px solid var(--dc-border)' }}><option value="viewer">Everyone in workspace</option><option value="member">Members and above</option>{['editor', 'admin', 'owner'].includes(user.role) && <option value="editor">Editors and above</option>}{['admin', 'owner'].includes(user.role) && <option value="admin">Admins and owner</option>}{user.role === 'owner' && <option value="owner">Owner only</option>}</select></label>
            {uploadError && <p className="text-[11px] mt-3 rounded-lg px-3 py-2" style={{ color: 'var(--dc-red)', background: 'rgba(244,63,94,.08)' }}>{uploadError}</p>}
            <div className="flex justify-end gap-2 mt-5"><button type="button" onClick={() => setUploadOpen(false)} disabled={batchUploading} className="px-4 py-2 rounded-lg text-xs" style={{ border: '1px solid var(--dc-border)' }}>{batchRows.some((row) => ['queued', 'pending', 'completed', 'failed'].includes(row.status)) ? 'Close' : 'Cancel'}</button><button type="button" onClick={() => handleUpload(selectedFiles)} disabled={!selectedFiles.length || batchUploading || batchRows.some((row) => ['uploading', 'queued', 'pending', 'completed'].includes(row.status))} className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50" style={{ background: 'var(--dc-brand)', color: 'white' }}>{batchUploading ? 'Uploading safely…' : canSelfApprove ? `Upload ${selectedFiles.length || ''} and index` : `Upload ${selectedFiles.length || ''} for approval`}</button></div>
          </section>
        </div>
      )}

      {huddleOpen && <NexconnHuddle onClose={() => setHuddleOpen(false)} />}

      {isOpen && (
        <div
          className="fixed inset-0 flex justify-end z-[90]"
          onClick={() => setIsOpen(false)}
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}
        >
          <div
            className="w-full max-w-md h-full p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'linear-gradient(to bottom, var(--dc-surface-0), var(--dc-surface-3))', borderLeft: '1px solid var(--dc-border)' }}
          >
            <div className="flex items-center justify-between pb-3" style={{ borderBottom: '1px solid var(--dc-border)' }}>
              <div className="flex items-center gap-2">
                <Clock size={16} className="" style={{ color: 'var(--dc-text-secondary)' }} />
                <h2 className="text-sm font-semibold" style={{ color: 'var(--dc-text-primary)' }}>
                  Chat History
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-2 rounded-lg transition"
                style={{ color: 'var(--dc-text-secondary)' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--dc-text-primary)'; e.currentTarget.style.background = 'var(--dc-surface-1)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--dc-text-secondary)'; e.currentTarget.style.background = 'transparent'; }}
                aria-label="Close chat history"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pt-4 space-y-2 pr-1 custom-scrollbar">
              {sortedSessions.length === 0 && (
                <div className="text-xs rounded-xl p-3" style={{ color: 'var(--dc-text-muted)', background: 'var(--dc-surface-2)', border: '1px solid var(--dc-border)' }}>
                  No chats yet. Click “New Chat” to start one.
                </div>
              )}

              {sortedSessions.map((s) => {
                const isActive = s?.sessionId && s.sessionId === activeSessionId;
                const ts = s?.lastMessageAt || s?.createdAt || null;
                return (
                  <button
                    key={s?.sessionId}
                    type="button"
                    onClick={() => {
                      if (typeof onSelectSession === 'function' && s?.sessionId) {
                        onSelectSession(s.sessionId);
                      }
                      setIsOpen(false);
                    }}
                    className={`w-full text-left rounded-xl border transition p-3`}
                    style={isActive ? { borderColor: 'var(--dc-brand)', background: 'var(--dc-brand-dim)' } : { borderColor: 'var(--dc-border)', background: 'transparent' }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate" style={{ color: isActive ? 'var(--dc-text-primary)' : 'var(--dc-text-secondary)' }}>
                          {String(s?.title ?? 'Chat')}
                        </p>
                        <p className="text-[11px] truncate mt-1" style={{ color: 'var(--dc-text-muted)' }}>
                          {String(s?.lastMessagePreview ?? '') || 'No messages yet'}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 min-w-[46px]">
                        <div className="text-[10px] text-right" style={{ color: 'var(--dc-text-muted)' }}>
                          {formatTime(ts)}
                        </div>
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="w-4 h-4 cursor-pointer transition"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteChatFunction(s.sessionId);
                            }}
                            style={{ color: 'var(--dc-red)' }}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="pt-3" style={{ borderTop: '1px solid var(--dc-border)' }}>
              <p className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>
                Tip: Each row is a separate chat, like WhatsApp.
              </p>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal
        isOpen={!!pendingDeleteSession}
        title="Delete chat?"
        description={pendingDeleteSession ? 'Delete this chat and its local history? This cannot be undone.' : ''}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger={true}
        onConfirm={confirmDeleteChat}
        onCancel={() => setPendingDeleteSession(null)}
      />
    </div>
  );
}
