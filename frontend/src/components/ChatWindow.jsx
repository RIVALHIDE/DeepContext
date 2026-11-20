import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, GitBranch, Search, SendHorizontal, Sparkles, Square, Terminal } from 'lucide-react';
import api from '../utils/api.util';
import ChatHistoryDrawer from './ChatHistoryDrawer';
import IngestProgressBanner from './IngestProgressBanner';
import MarkdownRenderer from './MarkdownRenderer';
import WelcomeScreen from './chat/WelcomeScreen';
import MessageBubble from './chat/MessageBubble';
import ThinkingIndicator from './chat/ThinkingIndicator';
import {
  createNewChatSession,
  ensureInitialChatSession,
  maybeSetChatTitleFromFirstMessage,
  touchChatSession,
} from '../utils/chatSessions.util';

const SLASH_COMMANDS = [
  { command: '/extract_diagram', label: 'Extract and graph a visual flow', icon: GitBranch },
  { command: '/search', label: 'Search all permitted documents', icon: Search },
  { command: '/summarize', label: 'Summarize retrieved knowledge', icon: FileText },
  { command: '/help', label: 'Show available assistant commands', icon: Sparkles },
];

function buildStreamUrl(path) {
  const base = String(api.defaults.baseURL ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

function genMessageId(prefix = 'msg') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function parseSseEventBlock(block) {
  const lines = String(block ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));

  let event = 'message';
  const dataLines = [];

  lines.forEach((line) => {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      return;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  });

  if (!dataLines.length) return null;

  const rawData = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(rawData) };
  } catch {
    return { event, data: rawData };
  }
}

function getFinalAssistantContent(answer, diagrams) {
  const normalizedAnswer = String(answer ?? '').trim();
  if (normalizedAnswer) return normalizedAnswer;
  return Array.isArray(diagrams) && diagrams.length > 0 ? '' : 'No response was generated.';
}

function normalizeHistoryPayload(payload) {
  const raw = payload?.['chat-history'];
  if (!Array.isArray(raw)) return [];
  function normalizeSources(sources) {
    if (!Array.isArray(sources)) return [];
    if (sources.length === 0) return [];
    // If stored as array of strings, convert to minimal structured objects
    if (typeof sources[0] === 'string') {
      return sources.map((name, idx) => ({ index: idx + 1, sourceName: name, preview: '' }));
    }
    // If already objects, normalize common key variants
    return sources
      .map((s, idx) => {
        if (!s || typeof s !== 'object') return null;
        return {
          index: s.index ?? s.chunkIndex ?? s.chunk_index ?? idx + 1,
          sourceName: s.sourceName ?? s.source_name ?? s.source ?? s.name ?? '',
          displayName: s.displayName ?? s.display_name ?? '',
          preview: s.preview ?? s.raw_text_preview ?? '',
          page: s.page ?? s.page,
        };
      })
      .filter(Boolean);
  }

  return raw
    .map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return {
          role: item.role,
          content: item.content,
          diagrams: Array.isArray(item.diagrams) ? item.diagrams : [],
          sources: normalizeSources(item.sources),
        };
      }
      if (Array.isArray(item) && item.length >= 2) {
        const diagramsFromTuple = Array.isArray(item[3])
          ? item[3]
          : (Array.isArray(item[2]) ? item[2] : []);
        return { 
          role: item[0], 
          content: item[1],
          diagrams: diagramsFromTuple,
          sources: [],
        };
      }
      return null;
    })
    .filter(Boolean);
}

export default function ChatWindow({
  user,
  ingestState,
  onIngestStart,
  onIngestEvent,
  onIngestComplete,
  onIngestFailed,
  onDismissIngest,
  onResponse,
  onInputChange,
}) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [isTyping, setIsTyping] = useState(false);
    const [thinkingStage, setThinkingStage] = useState('retrieving');
    const [isReceivingTokens, setIsReceivingTokens] = useState(false);
    const [activeSessionId, setActiveSessionIdState] = useState(null);
    const [sessionsVersion, setSessionsVersion] = useState(0);
    const messagesContainerRef = useRef(null);
    const messagesEndRef = useRef(null);
    const streamAbortRef = useRef(null);
    const activeAssistantMessageIdRef = useRef(null);
    const shouldAutoScrollRef = useRef(true);
    const forceAutoScrollRef = useRef(false);

    const isDocumentProcessing = ingestState?.status === 'uploading' || ingestState?.status === 'processing';

    const username = user?.username ?? null;

    const effectiveSessionId = useMemo(() => activeSessionId, [activeSessionId]);

    const scrollToBottom = useCallback((behavior = 'smooth') => {
      messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    }, []);

    const updateAssistantMessage = useCallback((messageId, patch) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId ? { ...message, ...patch } : message
        )
      );
    }, []);

    const cancelStreaming = useCallback(() => {
      streamAbortRef.current?.abort();
    }, []);

    const loadSession = useCallback(
      async (sessionId) => {
        if (!username || !sessionId) return;
        streamAbortRef.current?.abort();
        streamAbortRef.current = null;
        activeAssistantMessageIdRef.current = null;
        setActiveSessionIdState(sessionId);
        setIsTyping(false);
        setIsReceivingTokens(false);
        setInput('');

        try {
          const res = await api.post(`/get-history/${sessionId}`);
          const normalized = normalizeHistoryPayload(res?.data);
          setMessages(
            normalized.map((m) => ({
              role: m.role,
              content: m.content,
              diagrams: Array.isArray(m.diagrams) ? m.diagrams : [],
              sources: Array.isArray(m.sources) ? m.sources : [],
            }))
          );
        } catch {
          setMessages([]);
        }
      },
      [username]
    );

    useEffect(() => {
      if (!username) return;
      (async () => {
        const { activeSessionId: initialActive } = await ensureInitialChatSession(username);
        if (initialActive) {
          await loadSession(initialActive);
        }
      })();
    }, [username, loadSession]);

    useEffect(() => {
      const container = messagesContainerRef.current;
      if (!container) return;

      const handleScroll = () => {
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        shouldAutoScrollRef.current = distanceFromBottom < 80;
      };

      handleScroll();
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }, []);

    useEffect(() => {
      if (!forceAutoScrollRef.current && !shouldAutoScrollRef.current) return;

      requestAnimationFrame(() => {
        scrollToBottom('smooth');
        requestAnimationFrame(() => {
          scrollToBottom('smooth');
          forceAutoScrollRef.current = false;
        });
      });
    }, [messages, isTyping, scrollToBottom]);

    useEffect(() => {
      const container = messagesContainerRef.current;
      if (!container || typeof ResizeObserver === 'undefined') return;

      const observer = new ResizeObserver(() => {
        if (!forceAutoScrollRef.current && !shouldAutoScrollRef.current) return;
        scrollToBottom('auto');
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, [scrollToBottom]);

    const startNewChat = useCallback(() => {
      if (!username) return;
      (async () => {
        streamAbortRef.current?.abort();
        streamAbortRef.current = null;
        activeAssistantMessageIdRef.current = null;
        const newSession = await createNewChatSession(username);
        setSessionsVersion((v) => v + 1);
        setMessages([]);
        setInput('');
        setIsTyping(false);
        setIsReceivingTokens(false);
        if (newSession?.sessionId) {
          setActiveSessionIdState(newSession.sessionId);
        }
      })();
    }, [username]);
  
    const sendMessage = async () => {
      const text = input.trim();
      if (!text || isTyping) return;
      if (!username || !effectiveSessionId) return;

      forceAutoScrollRef.current = true;
      const userMsgId = genMessageId('human');
      const assistantMessageId = genMessageId('assistant');
      const userMsg = { id: userMsgId, role: 'human', content: text };
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: assistantMessageId,
          role: 'ai',
          content: '',
          diagrams: [],
          sources: [],
          streaming: true,
        },
      ]);
      setInput("");
      setIsTyping(true);
      setThinkingStage('retrieving');
      setIsReceivingTokens(false);
      activeAssistantMessageIdRef.current = assistantMessageId;

      const controller = new AbortController();
      streamAbortRef.current = controller;
      let receivedAnyToken = false;

      const runFallbackRequest = async () => {
        const res = await api.post('/get-answer', {
          question: text,
          sessionId: effectiveSessionId,
        });

        const answer = String(res?.data?.answer ?? '').trim();
        const diagrams = Array.isArray(res?.data?.diagrams) ? res?.data?.diagrams : [];
        const sources = Array.isArray(res?.data?.sources) ? res.data.sources : [];
        const content = getFinalAssistantContent(answer, diagrams);

        updateAssistantMessage(assistantMessageId, {
          content,
          diagrams,
          sources,
          streaming: false,
        });

        onResponse?.({ answer: content, diagrams, sources });

        setSessionsVersion((v) => v + 1);
      };

      try {
        await maybeSetChatTitleFromFirstMessage(effectiveSessionId, text);
        await touchChatSession(effectiveSessionId, {
          lastMessageAt: new Date().toISOString(),
          lastMessagePreview: text,
        });
        setSessionsVersion((v) => v + 1);

        const response = await fetch(buildStreamUrl('/get-answer/stream'), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            question: text,
            sessionId: effectiveSessionId,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error('Streaming response unavailable');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let doneReceived = false;
        let streamedAnswer = '';
        let guardrail = null;

        const processBlock = async (block) => {
          const parsed = parseSseEventBlock(block);
          if (!parsed) return;

          if (parsed.event === 'thinking') {
            const stage = parsed.data?.stage;
            if (['retrieving', 'drafting', 'verifying'].includes(stage)) {
              setThinkingStage(stage);
            }
            return;
          }

          if (parsed.event === 'guardrail') {
            guardrail = parsed.data || {};
            setIsReceivingTokens(true);
            updateAssistantMessage(assistantMessageId, {
              blocked: true,
              guardrail,
              streaming: true,
            });
            return;
          }

          if (parsed.event === 'token') {
            const token = String(parsed.data?.token ?? '');
            if (!token) return;
            receivedAnyToken = true;
            setIsReceivingTokens(true);
            streamedAnswer += token;
            updateAssistantMessage(assistantMessageId, {
              content: streamedAnswer,
              streaming: true,
            });
            return;
          }

          if (parsed.event === 'done') {
            const diagrams = Array.isArray(parsed.data?.diagrams) ? parsed.data.diagrams : [];
            const sources = Array.isArray(parsed.data?.sources) ? parsed.data.sources : [];
            const finalAnswer = getFinalAssistantContent(
              parsed.data?.answer ?? streamedAnswer,
              diagrams
            );

            updateAssistantMessage(assistantMessageId, {
              content: finalAnswer,
              diagrams,
              sources,
              blocked: Boolean(parsed.data?.blocked || guardrail?.blocked),
              guardrail: parsed.data?.guardrail || guardrail,
              streaming: false,
            });

            onResponse?.({ answer: finalAnswer, diagrams, sources, blocked: Boolean(parsed.data?.blocked || guardrail?.blocked) });

            setSessionsVersion((v) => v + 1);
            doneReceived = true;
            return;
          }

          if (parsed.event === 'error') {
            throw new Error(parsed.data?.message || 'Streaming failed');
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

          let boundaryIndex = buffer.indexOf('\n\n');
          while (boundaryIndex !== -1) {
            const block = buffer.slice(0, boundaryIndex).trim();
            buffer = buffer.slice(boundaryIndex + 2);
            if (block) {
              await processBlock(block);
              if (doneReceived) break;
            }
            boundaryIndex = buffer.indexOf('\n\n');
          }

          if (doneReceived) break;
        }

        const trailing = buffer.trim();
        if (!doneReceived && trailing) {
          await processBlock(trailing);
        }

        if (!doneReceived) {
          throw new Error('Streaming response ended unexpectedly');
        }
      } catch (err) {
        if (controller.signal.aborted) {
          updateAssistantMessage(assistantMessageId, {
            content: 'Request cancelled.',
            streaming: false,
          });
        } else if (!receivedAnyToken) {
          try {
            await runFallbackRequest();
          } catch (fallbackErr) {
            updateAssistantMessage(assistantMessageId, {
              content: 'Something went wrong while fetching the answer.',
              streaming: false,
            });
            console.error(fallbackErr);
          }
        } else {
          updateAssistantMessage(assistantMessageId, {
            content: 'Something went wrong while streaming the answer.',
            streaming: false,
          });
          console.error(err);
        }
      }
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      activeAssistantMessageIdRef.current = null;
      setIsTyping(false);
      setIsReceivingTokens(false);
    };

    const slashMatches = input.startsWith('/') && !input.includes(' ')
      ? SLASH_COMMANDS.filter((item) => item.command.startsWith(input.toLowerCase()))
      : [];
  
    return (
      <div className="h-full min-h-0 flex-1 flex flex-col overflow-hidden p-4 mx-auto w-full">
        <ChatHistoryDrawer
          user={user}
          activeSessionId={effectiveSessionId}
          sessionsVersion={sessionsVersion}
          onNewChat={startNewChat}
          onSelectSession={(sessionId) => loadSession(sessionId)}
          onIngestStart={onIngestStart}
          onIngestEvent={onIngestEvent}
          onIngestComplete={onIngestComplete}
          onIngestFailed={onIngestFailed}
          isUploading={isDocumentProcessing}
        />

        <IngestProgressBanner
          ingestState={ingestState}
          onDismiss={onDismissIngest}
        />

        {slashMatches.length > 0 && (
          <div className="mb-2 ml-2 w-full max-w-sm rounded-xl overflow-hidden" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border-strong)', boxShadow: '0 14px 38px rgba(30,52,78,.14)' }}>
            <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--dc-border)' }}><Terminal size={12} style={{ color: 'var(--dc-brand)' }} /><span className="text-[9px] font-semibold uppercase tracking-widest" style={{ color: 'var(--dc-text-muted)' }}>Commands</span></div>
            {slashMatches.map((item) => {
              const Icon = item.icon;
              return <button key={item.command} type="button" onClick={() => { const value = `${item.command} `; setInput(value); onInputChange?.(value); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50"><Icon size={13} style={{ color: 'var(--dc-brand)' }} /><div><p className="text-[11px] font-semibold">{item.command}</p><p className="text-[9px] mt-0.5" style={{ color: 'var(--dc-text-muted)' }}>{item.label}</p></div></button>;
            })}
          </div>
        )}

        <div
          ref={messagesContainerRef}
          className="messagesBox min-h-0 flex-1 overflow-y-auto overflow-x-hidden space-y-4 mb-4 pr-2 custom-scrollbar"
        >
          {messages.length === 0 && !isTyping
            ? <WelcomeScreen onSuggestion={(text) => { setInput(text); }} />
            : messages.map((m) => (
              m.role === 'ai' && m.streaming && !m.content
                ? null
                : <MessageBubble key={m.id ?? `${m.role}_${m.content?.slice(0,20)}`} message={m} />
            ))
          }
          {isTyping && !isReceivingTokens && <ThinkingIndicator stage={thinkingStage} />}
          <div ref={messagesEndRef} />
        </div>
  
        <div
          className="relative flex items-end gap-3 rounded-2xl p-2"
          style={{
            background: 'var(--dc-surface-1)',
            border: `1px solid ${input.trim() || isTyping ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
            boxShadow: input.trim() ? '0 0 0 3px rgba(37,99,235,0.08)' : 'none',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}
        >
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              onInputChange?.(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
              if (e.key === 'Escape' && isTyping) {
                cancelStreaming();
              }
            }}
            placeholder={
              isTyping  ? 'Press Esc to stop…'
                          : "Message #channel (Type '/' for commands, Shift+Enter for new line)"
            }
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm leading-relaxed focus:outline-none custom-scrollbar"
            style={{ color: 'var(--dc-text-primary)', minHeight: '36px', maxHeight: '140px' }}
          />

          <button
            type="button"
            onClick={isTyping ? cancelStreaming : sendMessage}
            disabled={!isTyping && !input.trim()}
            className="shrink-0 flex items-center justify-center w-9 h-9 rounded-xl transition-all"
            style={{
              background: isTyping ? 'var(--dc-red)' : input.trim() ? 'var(--dc-brand)' : 'var(--dc-surface-2)',
              color: (isTyping || input.trim()) ? 'var(--dc-text-inverse)' : 'var(--dc-text-muted)',
              boxShadow: isTyping ? '0 0 16px rgba(244,63,94,0.4)' : (input.trim() ? 'var(--dc-glow-brand)' : 'none'),
            }}
            aria-label={isTyping ? 'Stop' : 'Send'}
          >
            {isTyping ? <Square size={15} strokeWidth={2.5} /> : <SendHorizontal size={15} strokeWidth={2.5} />}
          </button>
        </div>
      </div>
    );
  }
