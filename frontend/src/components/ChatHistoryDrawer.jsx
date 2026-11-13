import React, { useEffect, useMemo, useState } from 'react';
import { Clock, ExternalLink, FileCheck2, MessageSquarePlus, ShieldCheck, UploadCloud, Video, X } from 'lucide-react';
import api from '../utils/api.util';
import {
  STAGE_LABELS,
  waitForIngestProgress,
} from '../utils/ingestProgress.util';
import { ensureInitialChatSession, getChatSessions } from '../utils/chatSessions.util';
import ConfirmModal from './ui/ConfirmModal';

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
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [huddleOpen, setHuddleOpen] = useState(false);
  const canUpload = ['member', 'editor', 'admin', 'owner'].includes(user?.role);
  const canSelfApprove = ['editor', 'admin', 'owner'].includes(user?.role);
  const huddleUrl = import.meta.env.VITE_NEXCONN_HUDDLE_URL;

  const username = user?.username ?? null;

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
    if (!username) return;
    (async () => {
      await ensureInitialChatSession(username);
      const nextSessions = await getChatSessions();
      setSessions(nextSessions);
    })();
  }, [username, sessionsVersion, isOpen]);

  const pollJobStatus = async (jobId, fileName) => {
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
            meta: { file_name: fileName },
          });
        }

        if (status === 'completed') {
          onIngestEvent?.({
            stage: 'completed',
            message: STAGE_LABELS.completed,
            meta: { file_name: fileName },
          });
          return { ok: true };
        }
        if (status === 'failed' || status === 'not_found') {
          onIngestEvent?.({
            stage: 'failed',
            message: message || STAGE_LABELS.failed,
            meta: { file_name: fileName },
          });
          return { ok: false };
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

  const handleUpload = async (file) => {
    if (!file || isUploading) return;

    const extension = `.${file.name.split('.').pop()?.toLowerCase() || ''}`;
    const allowed = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.puml', '.mmd', '.mermaid', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
    if (file.size > 15 * 1024 * 1024) {
      setUploadError('This file is larger than the 15MB limit.');
      return;
    }
    if (!allowed.has(extension)) {
      setUploadError('This file type is not supported. Choose a document, image, diagram, or Office file.');
      return;
    }
    setUploadError('');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('access_role', accessRole);

    onIngestStart?.(file.name);

    try {
      const res = await api.post('/upload', formData);
      // The dialog covers only the browser-to-API transfer. Once accepted,
      // indexing continues in the background status strip.
      setUploadOpen(false);
      setSelectedFile(null);

      if (res.data?.status === 'pending_approval') {
        onIngestEvent?.({ stage: 'pending_approval', message: 'Uploaded. Waiting for an editor or admin to approve it in Pull Requests.', meta: { file_name: file.name } });
        window.dispatchEvent(new Event('documents-pending'));
        return;
      }

      const jobId = res.data?.job_id;
      if (jobId) {
        const progressResult = await waitForIngestProgress(jobId, {
          onEvent: (event) => onIngestEvent?.(event),
        });

        if (progressResult.fallback) {
          const pollResult = await pollJobStatus(jobId, file.name);
          if (pollResult.ok) {
            await onIngestComplete?.();
          } else {
            onIngestFailed?.({ message: STAGE_LABELS.failed });
          }
        } else if (progressResult.ok) {
          await onIngestComplete?.();
        } else {
          onIngestFailed?.(
            progressResult.event ?? { message: STAGE_LABELS.failed }
          );
        }
      } else {
        onIngestEvent?.({
          stage: 'completed',
          message: 'Upload successful.',
          meta: { file_name: file.name },
        });
        await onIngestComplete?.();
      }
    } catch (err) {
      console.error('Upload failed', err);
      const detail = err?.response?.data?.detail;
      const message = typeof detail === 'string'
        ? detail
        : err?.response
          ? `Upload failed (HTTP ${err.response.status}). Check the API terminal for details.`
          : `Cannot reach the API at ${api.defaults.baseURL}. Check that the API is running and reachable.`;
      onIngestFailed?.({ message });
      setUploadError(message);
    }
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
        onClick={() => { setUploadError(''); setUploadOpen(true); }}
        disabled={isUploading}
        className="inline-flex items-center gap-2 text-xs border rounded-xl px-3 py-2 transition disabled:opacity-50"
        style={{ color: 'var(--dc-text-secondary)', background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)', cursor: isUploading ? 'not-allowed' : 'pointer' }}
      >
        <UploadCloud size={14} />
        {isUploading ? 'Uploading…' : 'Upload'}
      </button>}

      {uploadOpen && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-5" style={{ background: 'rgba(15,23,42,.36)', backdropFilter: 'blur(5px)' }} onClick={() => !isUploading && setUploadOpen(false)}>
          <section className="w-full max-w-lg rounded-2xl p-5" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border)', boxShadow: '0 24px 70px rgba(15,23,42,.22)' }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex gap-3">
                <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}><UploadCloud size={19} /></span>
                <div><h2 className="text-sm font-semibold">Upload knowledge</h2><p className="text-[11px] mt-1" style={{ color: 'var(--dc-text-muted)' }}>{canSelfApprove ? 'Your role can index this file immediately.' : 'Files enter the approval queue before indexing.'}</p></div>
              </div>
              <button type="button" onClick={() => setUploadOpen(false)} disabled={isUploading} className="p-1.5 rounded-lg" style={{ color: 'var(--dc-text-muted)' }} aria-label="Close upload dialog"><X size={16} /></button>
            </div>

            <div className="grid grid-cols-2 gap-2 my-4">
              <div className="rounded-xl p-3 flex gap-2" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}><ShieldCheck size={15} style={{ color: 'var(--dc-green)' }} /><div><p className="text-[11px] font-semibold">Maximum 15MB</p><p className="text-[10px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>Validated again by the API</p></div></div>
              <div className="rounded-xl p-3 flex gap-2" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}><FileCheck2 size={15} style={{ color: 'var(--dc-brand)' }} /><div><p className="text-[11px] font-semibold">Approved formats</p><p className="text-[10px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>PDF, MD, TXT, images and Office</p></div></div>
            </div>

            <label className="block rounded-xl border border-dashed p-5 text-center cursor-pointer" style={{ borderColor: selectedFile ? 'var(--dc-brand)' : 'var(--dc-border-strong)', background: selectedFile ? 'var(--dc-brand-dim)' : 'var(--dc-surface-1)' }}>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.md,.puml,.mmd,.mermaid,.doc,.docx,.xls,.xlsx,.ppt,.pptx" className="hidden" disabled={isUploading} onChange={(event) => { setSelectedFile(event.target.files?.[0] || null); setUploadError(''); }} />
              <UploadCloud size={22} className="mx-auto mb-2" style={{ color: 'var(--dc-brand)' }} />
              <p className="text-xs font-medium">{selectedFile ? selectedFile.name : 'Choose a file to upload'}</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--dc-text-muted)' }}>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB` : 'PDF, Markdown, TXT, PNG, JPG, DOCX, XLSX, PPTX and diagrams'}</p>
            </label>

            <label className="block text-[11px] font-medium mt-4">Minimum access level<select value={accessRole} onChange={(event) => setAccessRole(event.target.value)} className="w-full mt-1.5 rounded-lg px-3 py-2" style={{ background: 'var(--dc-surface-1)', color: 'var(--dc-text-primary)', border: '1px solid var(--dc-border)' }}><option value="viewer">Everyone in workspace</option><option value="member">Members and above</option>{['editor', 'admin', 'owner'].includes(user.role) && <option value="editor">Editors and above</option>}{['admin', 'owner'].includes(user.role) && <option value="admin">Admins and owner</option>}{user.role === 'owner' && <option value="owner">Owner only</option>}</select></label>
            {uploadError && <p className="text-[11px] mt-3 rounded-lg px-3 py-2" style={{ color: 'var(--dc-red)', background: 'rgba(244,63,94,.08)' }}>{uploadError}</p>}
            <div className="flex justify-end gap-2 mt-5"><button type="button" onClick={() => setUploadOpen(false)} disabled={isUploading} className="px-4 py-2 rounded-lg text-xs" style={{ border: '1px solid var(--dc-border)' }}>Cancel</button><button type="button" onClick={() => handleUpload(selectedFile)} disabled={!selectedFile || isUploading} className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50" style={{ background: 'var(--dc-brand)', color: 'white' }}>{isUploading ? 'Uploading…' : canSelfApprove ? 'Upload and index' : 'Upload for approval'}</button></div>
          </section>
        </div>
      )}

      {huddleOpen && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-5" style={{ background: 'rgba(15,23,42,.36)', backdropFilter: 'blur(5px)' }} onClick={() => setHuddleOpen(false)}>
          <section className="w-full max-w-sm rounded-2xl p-5 text-center" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border)', boxShadow: '0 24px 70px rgba(15,23,42,.22)' }} onClick={(event) => event.stopPropagation()}>
            <span className="mx-auto w-12 h-12 rounded-2xl flex items-center justify-center" style={{ color: '#08784f', background: 'rgba(16,185,129,.14)', border: '1px solid rgba(16,185,129,.25)' }}><Video size={22} /></span>
            <h2 className="text-base font-semibold mt-3">Nexconn Huddle</h2>
            <p className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--dc-text-muted)' }}>{huddleUrl ? 'Open the configured audio room for this workspace.' : 'The Huddle launcher is ready. Configure your Nexconn Call room URL to enable live audio.'}</p>
            {!huddleUrl && <code className="block text-[10px] rounded-lg px-2 py-2 mt-3" style={{ background: 'var(--dc-surface-1)', color: 'var(--dc-brand)', border: '1px solid var(--dc-border)' }}>VITE_NEXCONN_HUDDLE_URL=https://…</code>}
            <div className="flex gap-2 mt-5"><button type="button" onClick={() => setHuddleOpen(false)} className="flex-1 px-4 py-2 rounded-lg text-xs" style={{ border: '1px solid var(--dc-border)' }}>Close</button><button type="button" disabled={!huddleUrl} onClick={() => window.open(`${huddleUrl}?workspace=${encodeURIComponent(user.workspace_id)}`, '_blank', 'noopener,noreferrer')} className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40" style={{ background: 'var(--dc-green)', color: 'white' }}>Join huddle <ExternalLink size={12} /></button></div>
          </section>
        </div>
      )}

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
