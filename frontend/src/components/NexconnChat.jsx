import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AtSign, BookPlus, Check, Download, FileText, LoaderCircle, Paperclip, Pencil, Send, Users, X } from 'lucide-react';
import api from '../utils/api.util';
import { connectNexconn, NEXCONN_TYPING_MESSAGE, nexconnResultError } from '../utils/nexconnClient.util';
import { MAX_KNOWLEDGE_FILE_BYTES, knowledgeFileError } from '../utils/uploadFormats.util';
import { waitForIngestProgress } from '../utils/ingestProgress.util';
import ChatWindow from './ChatWindow';

function DeepContextChat({
  user,
  docs,
  ingestState,
  onIngestStart,
  onIngestEvent,
  onIngestComplete,
  onIngestFailed,
  onDismissIngest,
  onResponse,
}) {
  return <div className="flex flex-col h-full">
    <ChatWindow
      user={user}
      docs={docs}
      ingestState={ingestState}
      onIngestStart={onIngestStart}
      onIngestEvent={onIngestEvent}
      onIngestComplete={onIngestComplete}
      onIngestFailed={onIngestFailed}
      onDismissIngest={onDismissIngest}
      onResponse={onResponse}
    />
  </div>;
}

function resultError(result, fallback) {
  return nexconnResultError(result, fallback);
}

function createChannel(channel, sdk) {
  if (channel.type === 'direct') return new sdk.DirectChannel(channel.id);
  if (channel.type === 'group') return new sdk.GroupChannel(channel.id);
  if (channel.type === 'open') return new sdk.OpenChannel(channel.id);
  return new sdk.CommunitySubChannel(channel.id, channel.subchannel_id);
}

function sameChannel(message, channel) {
  const identifier = message?.channelIdentifier;
  return identifier?.channelId === channel.id
    && (channel.type !== 'community' || identifier?.subChannelId === channel.subchannel_id);
}

function normalizeMessage(message, currentUser) {
  const sender = message.content?.senderUserInfo;
  const mine = message.senderUserId === currentUser?.providerId;
  let extra = {};
  try {
    extra = JSON.parse(message.content?.extra || '{}');
  } catch {
    extra = {};
  }
  const isFile = message.messageType === 'RC:FileMsg'
    || Boolean(message.content?.remoteUrl && message.content?.name && message.content?.size != null);
  return {
    id: message.messageId || `local-${message.clientId}-${message.sentTime}`,
    text: isFile ? '' : (message.content?.text || message.content?.content || `[${message.messageType || 'message'}]`),
    senderId: message.senderUserId,
    senderName: mine ? currentUser.name : (sender?.name || message.content?.senderName || message.senderUserId || 'Unknown user'),
    sentTime: message.sentTime || Date.now(),
    channelIdentifier: message.channelIdentifier,
    edited: Boolean(message.hasChanged || message.updateInfo),
    mentionedUserIds: message.content?.mentionedInfo?.userIdList || [],
    attachment: isFile ? {
      name: message.content?.name || 'Shared file',
      size: Number(message.content?.size || 0),
      fileType: message.content?.fileType || '',
      remoteUrl: message.content?.remoteUrl || '',
      documentId: extra.deepcontext_document_id || '',
      knowledgeCompatible: Boolean(extra.deepcontext_document_id),
    } : null,
  };
}

function subscriptionIsOnline(status) {
  if (typeof status?.isOnline === 'boolean') return status.isOnline;
  return (status?.details || []).some((detail) => detail.isOnline === true || detail.eventValue === 1);
}

function formatFileSize(bytes) {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderMessageText(value, members) {
  const names = members.map((member) => member.name).filter(Boolean).sort((left, right) => right.length - left.length);
  if (!names.length) return value;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(@(?:${escaped.join('|')}))`, 'gi');
  return value.split(pattern).map((part, index) => part.startsWith('@')
    ? <span key={`${part}-${index}`} className="font-semibold rounded px-0.5" style={{ color: 'var(--dc-brand)', background: 'var(--dc-brand-dim)' }}>{part}</span>
    : part);
}

function NexconnChannel({ user, onIngestStart, onIngestEvent, onIngestComplete, onIngestFailed }) {
  const [status, setStatus] = useState('loading');
  const [reason, setReason] = useState('Connecting to Nexconn…');
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typingUsers, setTypingUsers] = useState({});
  const [members, setMembers] = useState([]);
  const [showMembers, setShowMembers] = useState(false);
  const [mentionRange, setMentionRange] = useState(null);
  const [attachmentUpload, setAttachmentUpload] = useState(null);
  const [attachmentActions, setAttachmentActions] = useState({});
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const channelRef = useRef(null);
  const sdkRef = useRef(null);
  const scrollRef = useRef(null);
  const typingTimersRef = useRef(new Map());
  const lastTypingSentRef = useRef(0);
  const sessionRef = useRef(null);
  const inputRef = useRef(null);
  const attachmentInputRef = useRef(null);

  const applyPresence = useCallback((statuses) => {
    const onlineById = new Map((statuses || []).map((item) => [item.userId, subscriptionIsOnline(item)]));
    setMembers((previous) => previous.map((member) => member.provider_id === sessionRef.current?.user_id
      ? { ...member, online: true }
      : onlineById.has(member.provider_id) ? { ...member, online: onlineById.get(member.provider_id) } : member));
  }, []);

  const addMessages = useCallback((incoming) => {
    setMessages((previous) => {
      const byId = new Map(previous.map((message) => [message.id, message]));
      incoming.map((message) => normalizeMessage(message, {
        providerId: sessionRef.current?.user_id,
        name: user?.name || user?.username || 'You',
      })).forEach((message) => byId.set(message.id, message));
      return [...byId.values()].sort((left, right) => left.sentTime - right.sentTime);
    });
  }, [user?.name, user?.username]);

  const noteTyping = useCallback((message) => {
    const senderId = message.senderUserId;
    if (!senderId || senderId === sessionRef.current?.user_id) return;
    const typing = message.content?.typing !== false;
    const name = message.content?.senderName
      || message.content?.senderUserInfo?.name
      || senderId;
    const previousTimer = typingTimersRef.current.get(senderId);
    if (previousTimer) window.clearTimeout(previousTimer);
    if (!typing) {
      typingTimersRef.current.delete(senderId);
      setTypingUsers((previous) => {
        const next = { ...previous };
        delete next[senderId];
        return next;
      });
      return;
    }
    setTypingUsers((previous) => ({ ...previous, [senderId]: name }));
    const timer = window.setTimeout(() => {
      typingTimersRef.current.delete(senderId);
      setTypingUsers((previous) => {
        const next = { ...previous };
        delete next[senderId];
        return next;
      });
    }, 3500);
    typingTimersRef.current.set(senderId, timer);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    let handlerId = '';
    let userHandlerId = '';
    let openChannel = null;
    let presenceInterval = null;
    const typingTimers = typingTimersRef.current;

    const connect = async () => {
      setStatus('loading');
      setReason('Requesting a secure Nexconn session…');
      try {
        const { data } = await api.get('/nexconn/session');
        if (cancelled) return;
        if (!data.enabled) {
          setStatus('disabled');
          setReason(data.reason || 'Nexconn is not configured.');
          return;
        }
        setSession(data);
        sessionRef.current = data;
        setMembers((data.members || []).map((member) => ({
          ...member,
          online: member.provider_id === data.user_id,
        })));
        const { chat: sdk } = await connectNexconn(data);
        sdkRef.current = sdk;
        if (cancelled) return;

        const channel = createChannel(data.channel, sdk);
        channelRef.current = channel;
        if (data.channel.type === 'open') {
          const entered = await channel.enterChannel({ messageCount: 50 });
          if (!entered.isOk) throw new Error(resultError(entered, 'Could not enter the open channel'));
          openChannel = channel;
        }

        handlerId = `deepcontext-${user.workspace_id}-${user.id}`;
        sdk.NCEngine.addMessageHandler(handlerId, new sdk.MessageHandler({
          onMessageReceived({ messages: received }) {
            const inChannel = received.filter((message) => sameChannel(message, data.channel));
            inChannel.filter((message) => message.messageType === NEXCONN_TYPING_MESSAGE).forEach(noteTyping);
            addMessages(inChannel.filter((message) => message.messageType !== NEXCONN_TYPING_MESSAGE));
          },
          onMessagesUpdated({ messages: updated }) {
            addMessages((updated || []).filter((message) => sameChannel(message, data.channel)));
          },
        }));

        const presenceIds = (data.members || [])
          .map((member) => member.provider_id)
          .filter((providerId) => providerId && providerId !== data.user_id);
        const refreshPresence = async () => {
          if (!presenceIds.length) return;
          const snapshot = await sdk.NCEngine.userModule.getSubscribeUsersOnlineStatus(presenceIds);
          if (snapshot.isOk) applyPresence(snapshot.data || []);
        };
        if (presenceIds.length) {
          userHandlerId = `deepcontext-presence-${user.workspace_id}-${user.id}`;
          sdk.NCEngine.addUserHandler(userHandlerId, new sdk.UserHandler({
            onSubscriptionChanged({ events }) {
              applyPresence(events || []);
            },
          }));
          const subscribed = await sdk.NCEngine.userModule.subscribeEvent({
            subscribeType: sdk.SubscribeType.ONLINE_STATUS,
            userIds: presenceIds,
            expiry: 3600,
          });
          if (subscribed.isOk) await refreshPresence();
          presenceInterval = window.setInterval(refreshPresence, 30000);
        }

        const query = data.channel.type === 'open'
          ? sdk.OpenChannel.createOpenChannelMessagesQuery({ channelId: data.channel.id, pageSize: 50, isAscending: true })
          : sdk.BaseChannel.createMessagesQuery({ channelIdentifier: channel.identifier, pageSize: 50, isAscending: true });
        const history = await query.loadNextPage();
        if (history.isOk && history.data?.data) addMessages(history.data.data);
        if (!cancelled) {
          setStatus('connected');
          setReason('Connected');
        }
      } catch (error) {
        if (!cancelled) {
          setStatus('error');
          setReason(error?.response?.data?.detail || error.message || 'Could not connect to Nexconn.');
        }
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (handlerId && sdkRef.current) sdkRef.current.NCEngine.removeMessageHandler(handlerId);
      if (userHandlerId && sdkRef.current) sdkRef.current.NCEngine.removeUserHandler(userHandlerId);
      if (presenceInterval) window.clearInterval(presenceInterval);
      if (openChannel) openChannel.exitChannel().catch(() => {});
      if (sdkRef.current) sdkRef.current.NCEngine.disconnect().catch(() => {});
      typingTimers.forEach((timer) => window.clearTimeout(timer));
      typingTimers.clear();
      channelRef.current = null;
      sessionRef.current = null;
    };
  }, [addMessages, applyPresence, noteTyping, user.id, user.workspace_id]);

  const sendTypingState = useCallback(async (typing) => {
    if (!channelRef.current || !sdkRef.current || status !== 'connected') return;
    try {
      const params = new sdkRef.current.SendMessageParams({
        typing,
        senderName: user?.name || user?.username || 'Workspace member',
      }, NEXCONN_TYPING_MESSAGE);
      params.disableNotification = true;
      params.disableUpdateLastMessage = true;
      await channelRef.current.sendMessage(params);
    } catch {
      // Typing presence is best-effort and must never block normal messages.
    }
  }, [status, user?.name, user?.username]);

  const handleTextChange = (event) => {
    const value = event.target.value;
    setText(value);
    const cursor = event.target.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)@([^@\s]*)$/);
    setMentionRange(match ? { start: beforeCursor.lastIndexOf('@'), end: cursor, query: match[1].toLowerCase() } : null);
    if (!value.trim()) {
      lastTypingSentRef.current = 0;
      sendTypingState(false);
      return;
    }
    const now = Date.now();
    if (now - lastTypingSentRef.current > 1800) {
      lastTypingSentRef.current = now;
      sendTypingState(true);
    }
  };

  const insertMention = (member) => {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? text.length;
    const start = mentionRange?.start ?? cursor;
    const end = mentionRange?.end ?? cursor;
    const prefix = mentionRange ? '' : (text && !/\s$/.test(text.slice(0, cursor)) ? ' ' : '');
    const inserted = `${prefix}@${member.name} `;
    const next = `${text.slice(0, start)}${inserted}${text.slice(end)}`;
    const nextCursor = start + inserted.length;
    setText(next);
    setMentionRange(null);
    setShowMembers(false);
    window.setTimeout(() => {
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || !channelRef.current || sending) return;
    setSending(true);
    try {
      sendTypingState(false);
      lastTypingSentRef.current = 0;
      const mentioned = members.filter((member) => member.provider_id !== session?.user_id
        && value.toLowerCase().includes(`@${member.name.toLowerCase()}`));
      const content = { text: value };
      if (mentioned.length) {
        content.mentionedInfo = {
          type: sdkRef.current.MentionedType.USERS,
          userIdList: mentioned.map((member) => member.provider_id),
          mentionedContent: `${user?.name || user?.username || 'A workspace member'} mentioned you`,
        };
      }
      const result = await channelRef.current.sendMessage(new sdkRef.current.SendTextMessageParams(content));
      if (!result.isOk) throw new Error(resultError(result, 'Message could not be sent'));
      if (result.data) addMessages([result.data]);
      setText('');
    } catch (error) {
      setStatus('error');
      setReason(error.message || 'Message could not be sent.');
    } finally {
      setSending(false);
    }
  };

  const startEditingMessage = (message) => {
    setEditingMessageId(message.id);
    setEditText(message.text || '');
    setEditError('');
  };

  const cancelEditingMessage = () => {
    setEditingMessageId(null);
    setEditText('');
    setEditError('');
  };

  const saveEditedMessage = async (event, message) => {
    event.preventDefault();
    const value = editText.trim();
    if (!value || savingEdit || !sdkRef.current || !message?.channelIdentifier) return;
    if (value === message.text.trim()) {
      cancelEditingMessage();
      return;
    }

    setSavingEdit(true);
    setEditError('');
    try {
      const mentioned = members.filter((member) => member.provider_id !== session?.user_id
        && value.toLowerCase().includes(`@${member.name.toLowerCase()}`));
      const content = { text: value };
      if (mentioned.length) {
        content.mentionedInfo = {
          type: sdkRef.current.MentionedType.USERS,
          userIdList: mentioned.map((member) => member.provider_id),
          mentionedContent: `${user?.name || user?.username || 'A workspace member'} mentioned you`,
        };
      }
      const result = await sdkRef.current.BaseChannel.updateMessage({
        channelIdentifier: message.channelIdentifier,
        messageId: message.id,
        content,
      });
      if (!result.isOk) throw new Error(resultError(result, 'Message could not be edited'));
      setMessages((current) => current.map((item) => item.id === message.id
        ? { ...item, text: value, edited: true, mentionedUserIds: mentioned.map((member) => member.provider_id) }
        : item));
      cancelEditingMessage();
    } catch (error) {
      setEditError(error.message || 'Message could not be edited. It may be outside Nexconn’s edit window.');
    } finally {
      setSavingEdit(false);
    }
  };

  const discardStagedShare = async (documentId) => {
    if (!documentId) return;
    try {
      await api.delete(`/nexconn/share-file/${documentId}`);
    } catch {
      // The pending document remains visible to editors if cleanup is not
      // possible, so it can still be explicitly reviewed or rejected.
    }
  };

  const sendAttachment = async (file) => {
    if (!file || !channelRef.current || !sdkRef.current || (attachmentUpload && !attachmentUpload.error)) return;
    if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
      setAttachmentUpload({ name: file.name, progress: 0, error: 'Chat attachments are limited to 15MB.' });
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
      return;
    }

    setAttachmentUpload({ name: file.name, progress: 0, error: '' });
    let documentId = '';
    try {
      // Supported knowledge files are staged as a pending proposal. Other
      // formats remain ordinary Nexconn attachments and cannot be indexed.
      if (!knowledgeFileError(file)) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          const staged = await api.post('/nexconn/share-file', formData);
          documentId = staged.data?.document_id || '';
        } catch {
          documentId = '';
        }
      }

      const prepared = await sdkRef.current.Helper.createSendFileMessageParams(file);
      if (!prepared.isOk || !prepared.data) {
        throw new Error(resultError(prepared, 'Nexconn could not prepare this attachment'));
      }
      if (documentId) {
        prepared.data.content.extra = JSON.stringify({ deepcontext_document_id: documentId });
      }
      prepared.data.onUploadProgress = (progress) => {
        setAttachmentUpload({ name: file.name, progress: Math.max(0, Math.min(100, Math.round(progress))), error: '' });
      };
      const sent = await channelRef.current.sendMediaMessage(prepared.data);
      if (!sent.isOk) throw new Error(resultError(sent, 'Nexconn could not send this attachment'));
      if (sent.data) addMessages([sent.data]);
      setAttachmentUpload(null);
      if (documentId) window.dispatchEvent(new Event('documents-pending'));
    } catch (error) {
      await discardStagedShare(documentId);
      setAttachmentUpload({ name: file.name, progress: 0, error: error.message || 'Attachment could not be sent.' });
    } finally {
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  };

  const addAttachmentToWorkspace = async (attachment) => {
    if (!attachment?.documentId || attachmentActions[attachment.documentId]) return;
    const documentId = attachment.documentId;
    setAttachmentActions((previous) => ({ ...previous, [documentId]: { status: 'starting', message: 'Starting ingestion…' } }));
    onIngestStart?.(attachment.name);
    try {
      const response = await api.post(`/approve-document/${documentId}`);
      const jobId = response.data?.job_id;
      setAttachmentActions((previous) => ({ ...previous, [documentId]: { status: 'processing', message: 'Adding to workspace…' } }));
      if (jobId) {
        const progress = await waitForIngestProgress(jobId, {
          onEvent: (event) => {
            setAttachmentActions((previous) => ({ ...previous, [documentId]: { status: event.stage, message: event.message || 'Adding to workspace…' } }));
            onIngestEvent?.(event);
          },
        });
        if (progress.ok) {
          setAttachmentActions((previous) => ({ ...previous, [documentId]: { status: 'completed', message: 'Added to workspace' } }));
          await onIngestComplete?.();
          window.dispatchEvent(new Event('document-indexed'));
        } else if (progress.fallback) {
          setAttachmentActions((previous) => ({ ...previous, [documentId]: { status: 'processing', message: 'Ingestion continues in background' } }));
        } else {
          throw new Error(progress.event?.message || 'Ingestion failed');
        }
      }
    } catch (error) {
      const message = error?.response?.data?.detail || error.message || 'Could not add file to workspace.';
      setAttachmentActions((previous) => ({ ...previous, [documentId]: { status: 'failed', message } }));
      onIngestFailed?.({ message });
    }
  };

  const channelLabel = useMemo(() => session?.channel?.name || 'Nexconn Channel', [session]);
  const onlineCount = members.filter((member) => member.online).length;
  const canAddAttachments = ['editor', 'admin', 'owner'].includes(user?.role);
  const mentionSuggestions = useMemo(() => {
    if (!mentionRange) return [];
    return members.filter((member) => member.provider_id !== session?.user_id
      && member.name.toLowerCase().includes(mentionRange.query)).slice(0, 6);
  }, [members, mentionRange, session?.user_id]);

  if (status === 'loading') return <div className="h-full flex flex-col items-center justify-center gap-3" style={{ color: 'var(--dc-text-secondary)' }}>
    <LoaderCircle className="animate-spin" size={28} /><strong>{reason}</strong>
  </div>;

  if (status === 'disabled') return <div className="h-full flex items-center justify-center p-8">
    <div className="max-w-lg rounded-2xl p-6" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border-strong)' }}>
      <AlertCircle size={24} style={{ color: 'var(--dc-brand)' }} />
      <h2 className="text-lg font-semibold mt-3">Connect this workspace to Nexconn</h2>
      <p className="text-sm mt-2" style={{ color: 'var(--dc-text-secondary)' }}>{reason}</p>
      <p className="text-xs mt-4" style={{ color: 'var(--dc-text-muted)' }}>Set NEXCONN_API_BASE_URL, NEXCONN_APP_KEY, NEXCONN_APP_SECRET, and NEXCONN_AREA_CODE in backend/.env, then restart the API. A separate group is created automatically for each workspace.</p>
    </div>
  </div>;

  return <div className="h-full flex flex-col min-h-0 relative">
    <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--dc-border)' }}>
      <div><strong className="text-sm">{channelLabel}</strong><p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--dc-text-muted)' }}>{session?.channel?.type} · {session?.channel?.id}</p></div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setShowMembers((visible) => !visible)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]" style={{ border: '1px solid var(--dc-border)', color: 'var(--dc-text-secondary)' }} aria-expanded={showMembers} aria-label="Show workspace members"><Users size={14} />{onlineCount} online</button>
        <span className="text-[11px] flex items-center gap-2" style={{ color: status === 'connected' ? 'var(--dc-green)' : '#fb7185' }}><span className="w-2 h-2 rounded-full" style={{ background: 'currentColor' }} />{reason}</span>
      </div>
    </div>
    {showMembers && <div className="absolute z-30 top-[62px] right-4 w-72 rounded-xl shadow-xl overflow-hidden" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border-strong)' }}>
      <div className="px-3 py-2.5 flex items-center justify-between border-b" style={{ borderColor: 'var(--dc-border)' }}><div><strong className="text-xs">Workspace members</strong><p className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>Click a person to mention them</p></div><button type="button" onClick={() => setShowMembers(false)} aria-label="Close member list"><X size={15} /></button></div>
      <div className="max-h-72 overflow-y-auto p-1.5 custom-scrollbar">
        {[...members].sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name)).map((member) => <button key={member.provider_id} type="button" onClick={() => member.provider_id !== session?.user_id && insertMention(member)} disabled={member.provider_id === session?.user_id} className="w-full flex items-center gap-3 rounded-lg px-2.5 py-2 text-left disabled:cursor-default" style={{ color: 'var(--dc-text-primary)' }}>
          <span className="relative w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}>{member.name.slice(0, 2).toUpperCase()}<span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2" style={{ background: member.online ? 'var(--dc-green)' : 'var(--dc-text-muted)', borderColor: 'var(--dc-surface-0)' }} /></span>
          <span className="min-w-0 flex-1"><span className="block text-xs font-medium truncate">{member.name}{member.provider_id === session?.user_id ? ' (you)' : ''}</span><span className="block text-[10px] capitalize" style={{ color: 'var(--dc-text-muted)' }}>{member.online ? 'Online' : 'Offline'} · {member.role}</span></span>
          {member.provider_id !== session?.user_id && <AtSign size={14} style={{ color: 'var(--dc-text-muted)' }} />}
        </button>)}
      </div>
    </div>}
    <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-3">
      {!messages.length && <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--dc-text-muted)' }}>No messages in this channel yet.</div>}
      {messages.map((message) => {
        const mine = message.senderId === session?.user_id;
        const isEditing = editingMessageId === message.id;
        return <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
          <div className="group max-w-[75%] rounded-2xl px-4 py-2.5" style={{ background: mine ? 'var(--dc-brand-dim)' : 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}>
            <p className="text-[10px] font-semibold mb-1" style={{ color: mine ? 'var(--dc-text-secondary)' : 'var(--dc-brand)' }}>{mine ? `${message.senderName} · You` : message.senderName}</p>
            {message.attachment ? <div className="min-w-[230px] max-w-sm rounded-xl p-3" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border-strong)' }}>
              <div className="flex items-center gap-2.5">
                <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}><FileText size={17} /></span>
                <div className="min-w-0 flex-1"><p className="text-xs font-semibold truncate">{message.attachment.name}</p><p className="text-[9px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>{formatFileSize(message.attachment.size)}{message.attachment.fileType ? ` · ${message.attachment.fileType}` : ''}</p></div>
                {message.attachment.remoteUrl && <a href={message.attachment.remoteUrl} target="_blank" rel="noreferrer" download={message.attachment.name} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: 'var(--dc-brand)', border: '1px solid var(--dc-border)' }} aria-label={`Download ${message.attachment.name}`}><Download size={15} /></a>}
              </div>
              {message.attachment.documentId ? <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--dc-border)' }}>
                {canAddAttachments ? <button type="button" onClick={() => addAttachmentToWorkspace(message.attachment)} disabled={Boolean(attachmentActions[message.attachment.documentId]) && attachmentActions[message.attachment.documentId].status !== 'failed'} className="w-full rounded-lg px-2.5 py-1.5 flex items-center justify-center gap-1.5 text-[10px] font-semibold disabled:opacity-60" style={{ color: 'var(--dc-green)', background: 'rgba(16,185,129,.10)', border: '1px solid rgba(16,185,129,.22)' }}><BookPlus size={13} />{attachmentActions[message.attachment.documentId]?.message || 'Add to workspace'}</button>
                  : <p className="text-[9px] flex items-center gap-1" style={{ color: 'var(--dc-text-muted)' }}><BookPlus size={11} />Waiting for an editor to add this to the workspace</p>}
              </div> : <p className="text-[9px] mt-2" style={{ color: 'var(--dc-text-muted)' }}>Chat attachment only · this format cannot be indexed</p>}
            </div> : isEditing ? (
              <form onSubmit={(event) => saveEditedMessage(event, message)} className="min-w-[280px]">
                <textarea
                  autoFocus
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelEditingMessage();
                    } else if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={Math.min(5, Math.max(1, editText.split('\n').length))}
                  maxLength={4096}
                  className="block max-h-36 min-h-10 w-full resize-none bg-transparent text-sm outline-none"
                  aria-label="Edit Nexconn message"
                />
                {editError ? <p className="mt-1 text-[10px]" style={{ color: 'var(--dc-red)' }}>{editError}</p> : null}
                <div className="mt-2 flex items-center justify-end gap-1.5 border-t pt-2" style={{ borderColor: 'var(--dc-brand-border)' }}>
                  <span className="mr-auto text-[9px]" style={{ color: 'var(--dc-text-muted)' }}>Enter to send</span>
                  <button type="button" onClick={cancelEditingMessage} className="flex h-7 w-7 items-center justify-center rounded-lg" aria-label="Cancel editing"><X size={13} /></button>
                  <button type="submit" disabled={savingEdit || !editText.trim()} className="flex h-7 w-7 items-center justify-center rounded-lg disabled:opacity-40" style={{ background: 'var(--dc-brand)', color: 'white' }} aria-label="Send edited message"><Check size={13} /></button>
                </div>
              </form>
            ) : <p className="text-sm whitespace-pre-wrap break-words">{renderMessageText(message.text, members)}</p>}
            {message.mentionedUserIds.includes(session?.user_id) && <span className="inline-flex items-center gap-1 mt-1 text-[9px] font-semibold" style={{ color: 'var(--dc-brand)' }}><AtSign size={10} />Mentioned you</span>}
            {!isEditing && <div className="mt-1 flex items-center justify-end gap-2">
              {mine && !message.attachment ? <button type="button" onClick={() => startEditingMessage(message)} disabled={savingEdit || Boolean(editingMessageId)} className="flex items-center gap-1 text-[9px] opacity-0 transition group-hover:opacity-100 focus:opacity-100 disabled:opacity-30" style={{ color: 'var(--dc-text-muted)' }} aria-label="Edit Nexconn message"><Pencil size={10} />Edit</button> : null}
              <p className="text-[9px]" style={{ color: 'var(--dc-text-muted)' }}>{message.edited ? 'edited · ' : ''}{new Date(message.sentTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
            </div>}
          </div>
        </div>;
      })}
    </div>
    {Object.keys(typingUsers).length > 0 && <div className="px-5 pb-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--dc-text-muted)' }} aria-live="polite">
      <span className="font-medium">{Object.values(typingUsers).slice(0, 2).join(', ')}{Object.keys(typingUsers).length > 2 ? ` +${Object.keys(typingUsers).length - 2}` : ''}</span>
      <span>{Object.keys(typingUsers).length === 1 ? 'is' : 'are'} typing</span>
      <span className="inline-flex items-end gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((dot) => <span key={dot} className="w-1 h-1 rounded-full animate-bounce" style={{ background: 'currentColor', animationDelay: `${dot * 140}ms`, animationDuration: '850ms' }} />)}
      </span>
    </div>}
    {attachmentUpload && <div className="mx-4 mb-2 rounded-lg px-3 py-2" style={{ background: attachmentUpload.error ? 'rgba(244,63,94,.08)' : 'var(--dc-brand-dim)', border: `1px solid ${attachmentUpload.error ? 'rgba(244,63,94,.22)' : 'var(--dc-brand-border)'}` }}>
      <div className="flex items-center justify-between gap-3 text-[10px]"><span className="truncate" style={{ color: attachmentUpload.error ? 'var(--dc-red)' : 'var(--dc-text-secondary)' }}>{attachmentUpload.error || `Sharing ${attachmentUpload.name}`}</span>{!attachmentUpload.error && <span className="tabular-nums" style={{ color: 'var(--dc-brand)' }}>{attachmentUpload.progress}%</span>}</div>
      {!attachmentUpload.error && <div className="h-1 rounded-full mt-1.5 overflow-hidden" style={{ background: 'var(--dc-surface-2)' }}><div className="h-full transition-all" style={{ width: `${attachmentUpload.progress}%`, background: 'var(--dc-brand)' }} /></div>}
    </div>}
    <form onSubmit={sendMessage} className="p-4 border-t flex gap-2 relative" style={{ borderColor: 'var(--dc-border)' }}>
      {mentionSuggestions.length > 0 && <div className="absolute z-20 left-4 bottom-[70px] w-72 rounded-xl shadow-xl p-1.5" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border-strong)' }}>
        <p className="px-2 py-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--dc-text-muted)' }}>Mention someone</p>
        {mentionSuggestions.map((member) => <button key={member.provider_id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(member)} className="w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left"><span className="w-2 h-2 rounded-full" style={{ background: member.online ? 'var(--dc-green)' : 'var(--dc-text-muted)' }} /><span className="text-xs font-medium flex-1 truncate">{member.name}</span><span className="text-[10px] capitalize" style={{ color: 'var(--dc-text-muted)' }}>{member.online ? 'online' : member.role}</span></button>)}
      </div>}
      <input ref={attachmentInputRef} type="file" className="hidden" onChange={(event) => sendAttachment(event.target.files?.[0])} />
      <button type="button" onClick={() => attachmentInputRef.current?.click()} disabled={status !== 'connected' || Boolean(attachmentUpload && !attachmentUpload.error)} className="rounded-xl px-3 disabled:opacity-40" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border-strong)', color: 'var(--dc-text-secondary)' }} aria-label="Share a file"><Paperclip size={17} /></button>
      <input ref={inputRef} value={text} onChange={handleTextChange} onBlur={() => sendTypingState(false)} disabled={status !== 'connected'} maxLength={4096} placeholder="Message, @mention, or share a file…" className="flex-1 rounded-xl px-4 py-3 text-sm outline-none" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border-strong)', color: 'var(--dc-text-primary)' }} />
      <button type="submit" disabled={status !== 'connected' || sending || !text.trim()} className="rounded-xl px-4 disabled:opacity-40" style={{ background: 'var(--dc-brand)', color: 'white' }} aria-label="Send Nexconn message"><Send size={18} /></button>
    </form>
  </div>;
}

export default function NexconnChat({ mode = 'ai', ...props }) {
  return mode === 'nexconn' ? <NexconnChannel {...props} /> : <DeepContextChat {...props} />;
}
