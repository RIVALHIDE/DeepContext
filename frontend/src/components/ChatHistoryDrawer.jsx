import React, { useEffect, useMemo, useState } from 'react';
import { Clock, MessageSquarePlus, X } from 'lucide-react';
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

    const formData = new FormData();
    formData.append('file', file);

    onIngestStart?.(file.name);

    try {
      const res = await api.post('/upload', formData);

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

      <label
        className="inline-flex items-center gap-2 text-xs border rounded-xl px-3 py-2 transition"
        style={isUploading
          ? { color: 'var(--dc-text-muted)', background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.25)', cursor: 'not-allowed' }
          : { color: 'var(--dc-text-secondary)', background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border)', cursor: 'pointer' }
        }
      >
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.txt,.md,.puml,.mmd,.mermaid,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          className="hidden"
          onChange={async (e) => {
            const selectedFile = e.target.files?.[0];
            if (!selectedFile) return;
            await handleUpload(selectedFile);
            e.target.value = '';
          }}
          disabled={isUploading}
        />
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 16v-7m0 0l-3.5 3.5M12 9l3.5 3.5M19 16V7a2 2 0 00-2-2h-6a2 2 0 00-2 2v5.5" />
        </svg>
        {isUploading ? 'Uploading…' : 'Upload'}
      </label>

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
