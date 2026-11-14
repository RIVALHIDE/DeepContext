import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, Mic, MicOff, PhoneOff, Users, X } from 'lucide-react';
import api from '../utils/api.util';
import { connectNexconn, nexconnResultError } from '../utils/nexconnClient.util';

function callError(result, action) {
  if (result?.code === 80006) {
    return 'Nexconn VoIP is disabled for this App Key. In Nexconn Console, open Call → Call Subscription, activate the real-time audio/video service for the same environment as this App Key, then reload this page.';
  }
  if (result?.code === 80007) {
    return 'No other workspace member is available to call. Invite another person to this workspace and ask them to sign in before starting a huddle.';
  }
  const base = nexconnResultError(result, `Nexconn could not ${action}`);
  return `${base}. Confirm that Call Subscription is activated for this application in the Nexconn Console.`;
}

export default function NexconnHuddle({ onClose }) {
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('Preparing a secure workspace huddle…');
  const [callId, setCallId] = useState('');
  const [muted, setMuted] = useState(false);
  const [participants, setParticipants] = useState(1);
  const engineRef = useRef(null);
  const activeCallRef = useRef('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let chatSdk = null;

    const updateSession = (session, nextStatus = 'connected') => {
      const id = session?.getCallId?.() || activeCallRef.current;
      activeCallRef.current = id;
      if (!mountedRef.current) return;
      setCallId(id);
      setParticipants(1 + (session?.getRemoteParticipants?.().length || 0));
      setStatus(nextStatus);
      setMessage(nextStatus === 'connected' ? 'You are live in the workspace audio room.' : 'Connecting audio…');
    };

    const start = async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone access requires HTTPS or localhost. Open this page on localhost, or serve it over HTTPS.');
        }

        const { data } = await api.get('/nexconn/huddle-session');
        if (!data.enabled) throw new Error(data.reason || 'Nexconn is not configured for this server.');
        if (!data.callee_ids?.length && !data.call_id) {
          throw new Error('Invite at least one other person to this workspace before starting a huddle.');
        }

        setMessage('Requesting microphone permission…');
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        permissionStream.getTracks().forEach((track) => track.stop());

        setMessage('Connecting to Nexconn Call…');
        const { chat, call } = await connectNexconn(data, { includeCall: true });
        chatSdk = chat;
        const engine = call.NCCallEngine.initialize({});
        engineRef.current = engine;
        engine.setCallEventHandler({
          async onCallReceived(event) {
            const incomingId = event.session.getCallId();
            activeCallRef.current = incomingId;
            if (mountedRef.current) {
              setCallId(incomingId);
              setStatus('connecting');
              setMessage('Accepting the workspace huddle…');
            }
            const accepted = await engine.acceptCall({ callId: incomingId });
            if (accepted.code !== 0 && mountedRef.current) {
              setStatus('error');
              setMessage(callError(accepted, 'accept this huddle'));
            }
          },
          onCallConnected(event) {
            updateSession(event.session);
          },
          onCallEnded() {
            activeCallRef.current = '';
            if (mountedRef.current) {
              setCallId('');
              setStatus('ended');
              setMessage('You left the huddle. Other workspace members may still be connected.');
            }
          },
          onRemoteUserStateChanged() {
            const session = engine.getCurrentCallSession();
            if (session && mountedRef.current) setParticipants(1 + session.getRemoteParticipants().length);
          },
        });

        if (data.call_id) {
          setMessage('Joining the active workspace huddle…');
          const joined = await engine.joinCall({ callId: data.call_id });
          if (joined.code === 0) {
            activeCallRef.current = data.call_id;
            if (mountedRef.current) {
              setCallId(data.call_id);
              setStatus('connecting');
              setMessage('Joining audio…');
            }
            return;
          }
          // The saved room has ended. Remove it, then create a fresh one.
          await api.delete(`/nexconn/huddle/${encodeURIComponent(data.call_id)}`).catch(() => {});
        }

        setMessage('Starting a new workspace huddle…');
        const started = await engine.startCall({
          calleeIds: data.callee_ids,
          callType: call.NCCallType.MULTI,
          mediaType: call.NCCallMediaType.AUDIO,
          targetId: data.workspace.id,
          extra: JSON.stringify({ workspace_id: data.workspace.id }),
        });
        if (started.code !== 0 || !started.callId) throw new Error(callError(started, 'start this huddle'));
        activeCallRef.current = started.callId;
        setCallId(started.callId);
        setStatus('connecting');
        setMessage('Calling workspace members…');
        await api.post('/nexconn/huddle', { call_id: started.callId });
      } catch (error) {
        if (mountedRef.current) {
          setStatus('error');
          setMessage(error?.response?.data?.detail || error.message || 'Could not start the Nexconn huddle.');
        }
      }
    };

    start();
    return () => {
      mountedRef.current = false;
      engineRef.current?.setCallEventHandler({
        onCallReceived() {}, onCallEnded() {}, onCallConnected() {},
      });
      // The call is deliberately not ended just because the modal unmounted;
      // users leave through the explicit Leave button below.
      if (!activeCallRef.current) chatSdk?.NCEngine.disconnect().catch(() => {});
    };
  }, []);

  const toggleMute = async () => {
    if (!engineRef.current || !callId) return;
    const nextMuted = !muted;
    const result = await engineRef.current.enableMicrophone(!nextMuted);
    if (result.code === 0) setMuted(nextMuted);
    else setMessage(callError(result, nextMuted ? 'mute the microphone' : 'unmute the microphone'));
  };

  const leave = async () => {
    const id = activeCallRef.current;
    if (engineRef.current && id) await engineRef.current.endCall({ callId: id }).catch(() => {});
    activeCallRef.current = '';
    onClose();
  };

  const busy = status === 'loading' || status === 'connecting';
  const connected = status === 'connected';

  return <div className="fixed inset-0 z-[100] grid place-items-center p-5" style={{ background: 'rgba(15,23,42,.42)', backdropFilter: 'blur(6px)' }}>
    <section className="w-full max-w-sm rounded-2xl p-5 text-center" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border)', boxShadow: '0 24px 70px rgba(15,23,42,.24)' }}>
      <button type="button" disabled={status === 'loading'} onClick={connected || callId ? leave : onClose} className="float-right p-1.5 rounded-lg disabled:opacity-30" aria-label="Close huddle"><X size={16} /></button>
      <span className="mx-auto w-14 h-14 rounded-full flex items-center justify-center" style={{ color: connected ? 'white' : '#08784f', background: connected ? 'var(--dc-green)' : 'rgba(16,185,129,.14)', border: '1px solid rgba(16,185,129,.25)' }}>
        {busy ? <LoaderCircle className="animate-spin" size={24} /> : status === 'error' ? <AlertCircle size={24} /> : <Mic size={24} />}
      </span>
      <h2 className="text-base font-semibold mt-3">Nexconn Huddle</h2>
      <p className="text-xs mt-2 leading-relaxed" style={{ color: status === 'error' ? 'var(--dc-red)' : 'var(--dc-text-muted)' }}>{message}</p>
      {callId && <p className="text-[10px] mt-3 flex items-center justify-center gap-1.5" style={{ color: 'var(--dc-text-muted)' }}><Users size={12} />{participants} connected · Room {callId.slice(0, 8)}</p>}
      <div className="flex gap-2 mt-5">
        {connected && <button type="button" onClick={toggleMute} className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold" style={{ border: '1px solid var(--dc-border)' }}>{muted ? <MicOff size={15} /> : <Mic size={15} />}{muted ? 'Unmute' : 'Mute'}</button>}
        <button type="button" disabled={status === 'loading'} onClick={connected || callId ? leave : onClose} className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold disabled:opacity-40" style={{ background: connected || callId ? '#e11d48' : 'var(--dc-surface-1)', color: connected || callId ? 'white' : 'var(--dc-text-primary)', border: '1px solid var(--dc-border)' }}>{connected || callId ? <PhoneOff size={15} /> : null}{connected || callId ? 'Leave' : busy ? 'Please wait…' : 'Close'}</button>
      </div>
    </section>
  </div>;
}

