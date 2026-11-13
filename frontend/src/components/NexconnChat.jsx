import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, Send } from 'lucide-react';
import api from '../utils/api.util';
import ChatWindow from './ChatWindow';

let initializedAppKey = '';

function DeepContextChat({
  user,
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
  return result?.msg || (result?.code != null ? `${fallback} (Nexconn code ${result.code})` : fallback);
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

function normalizeMessage(message) {
  const sender = message.content?.senderUserInfo;
  return {
    id: message.messageId || `local-${message.clientId}-${message.sentTime}`,
    text: message.content?.text || message.content?.content || `[${message.messageType || 'message'}]`,
    senderId: message.senderUserId,
    senderName: sender?.name || message.senderUserId || 'Unknown user',
    sentTime: message.sentTime || Date.now(),
  };
}

function NexconnChannel({ user }) {
  const [status, setStatus] = useState('loading');
  const [reason, setReason] = useState('Connecting to Nexconn…');
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const channelRef = useRef(null);
  const sdkRef = useRef(null);
  const scrollRef = useRef(null);

  const addMessages = useCallback((incoming) => {
    setMessages((previous) => {
      const byId = new Map(previous.map((message) => [message.id, message]));
      incoming.map(normalizeMessage).forEach((message) => byId.set(message.id, message));
      return [...byId.values()].sort((left, right) => left.sentTime - right.sentTime);
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    let handlerId = '';
    let openChannel = null;

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
        const sdk = await import('@nexconn/chat');
        sdkRef.current = sdk;

        if (initializedAppKey && initializedAppKey !== data.app_key) {
          throw new Error('The Nexconn App Key changed. Reload this browser tab to reconnect.');
        }
        if (!initializedAppKey) {
          const areas = { sg: sdk.AreaCode.SG, bj: sdk.AreaCode.BJ, na: sdk.AreaCode.NA, sa: sdk.AreaCode.SA, om: sdk.AreaCode.OM };
          sdk.NCEngine.initialize({ appKey: data.app_key, areaCode: areas[data.area_code] || sdk.AreaCode.SG });
          initializedAppKey = data.app_key;
        }

        setReason('Connecting to the channel…');
        const connection = await sdk.NCEngine.connect({ token: data.token });
        if (!connection.isOk) throw new Error(resultError(connection, 'Could not connect to Nexconn'));
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
            addMessages(received.filter((message) => sameChannel(message, data.channel)));
          },
        }));

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
      if (openChannel) openChannel.exitChannel().catch(() => {});
      if (sdkRef.current) sdkRef.current.NCEngine.disconnect().catch(() => {});
      channelRef.current = null;
    };
  }, [addMessages, user.id, user.workspace_id]);

  const sendMessage = async (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || !channelRef.current || sending) return;
    setSending(true);
    try {
      const result = await channelRef.current.sendMessage(new sdkRef.current.SendTextMessageParams({ text: value }));
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

  const channelLabel = useMemo(() => session?.channel?.name || 'Nexconn Channel', [session]);

  if (status === 'loading') return <div className="h-full flex flex-col items-center justify-center gap-3" style={{ color: 'var(--dc-text-secondary)' }}>
    <LoaderCircle className="animate-spin" size={28} /><strong>{reason}</strong>
  </div>;

  if (status === 'disabled') return <div className="h-full flex items-center justify-center p-8">
    <div className="max-w-lg rounded-2xl p-6" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border-strong)' }}>
      <AlertCircle size={24} style={{ color: 'var(--dc-brand)' }} />
      <h2 className="text-lg font-semibold mt-3">Connect this workspace to Nexconn</h2>
      <p className="text-sm mt-2" style={{ color: 'var(--dc-text-secondary)' }}>{reason}</p>
      <p className="text-xs mt-4" style={{ color: 'var(--dc-text-muted)' }}>Set NEXCONN_API_BASE_URL, NEXCONN_APP_KEY, NEXCONN_APP_SECRET, NEXCONN_WORKSPACE_ID, NEXCONN_CHANNEL_TYPE, and NEXCONN_CHANNEL_ID in backend/.env, then restart the API.</p>
    </div>
  </div>;

  return <div className="h-full flex flex-col min-h-0">
    <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--dc-border)' }}>
      <div><strong className="text-sm">{channelLabel}</strong><p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--dc-text-muted)' }}>{session?.channel?.type} · {session?.channel?.id}</p></div>
      <span className="text-[11px] flex items-center gap-2" style={{ color: status === 'connected' ? 'var(--dc-green)' : '#fb7185' }}><span className="w-2 h-2 rounded-full" style={{ background: 'currentColor' }} />{reason}</span>
    </div>
    <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-3">
      {!messages.length && <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--dc-text-muted)' }}>No messages in this channel yet.</div>}
      {messages.map((message) => {
        const mine = message.senderId === session?.user_id;
        return <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
          <div className="max-w-[75%] rounded-2xl px-4 py-2.5" style={{ background: mine ? 'var(--dc-brand-dim)' : 'var(--dc-surface-1)', border: '1px solid var(--dc-border)' }}>
            {!mine && <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--dc-brand)' }}>{message.senderName}</p>}
            <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
            <p className="text-[9px] text-right mt-1" style={{ color: 'var(--dc-text-muted)' }}>{new Date(message.sentTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </div>;
      })}
    </div>
    <form onSubmit={sendMessage} className="p-4 border-t flex gap-2" style={{ borderColor: 'var(--dc-border)' }}>
      <input value={text} onChange={(event) => setText(event.target.value)} disabled={status !== 'connected'} maxLength={4096} placeholder="Message the Nexconn channel…" className="flex-1 rounded-xl px-4 py-3 text-sm outline-none" style={{ background: 'var(--dc-surface-1)', border: '1px solid var(--dc-border-strong)', color: 'var(--dc-text-primary)' }} />
      <button type="submit" disabled={status !== 'connected' || sending || !text.trim()} className="rounded-xl px-4 disabled:opacity-40" style={{ background: 'var(--dc-brand)', color: 'white' }} aria-label="Send Nexconn message"><Send size={18} /></button>
    </form>
  </div>;
}

export default function NexconnChat({ mode = 'ai', ...props }) {
  return mode === 'nexconn' ? <NexconnChannel user={props.user} /> : <DeepContextChat {...props} />;
}
