import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, FileText, GitBranch, Search, SendHorizontal, Sparkles, Square, Terminal, UploadCloud, X } from 'lucide-react';
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

function documentDisplayName(doc = {}) {
  const explicit = String(doc.displayName || doc.display_name || '').trim();
  if (explicit) return explicit;
  const internal = String(doc.name || doc.sourceName || doc.source_name || '').trim();
  return internal.includes('__') ? internal.split('__').slice(1).join('__') : internal;
}

function documentSourceName(doc = {}) {
  return String(doc.name || doc.sourceName || doc.source_name || '').trim();
}

function documentMentionTag(doc = {}) {
  return `@[${documentDisplayName(doc).replaceAll(']', '')}]`;
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
          id: item.id ? `history-${item.id}` : undefined,
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
          id: undefined,
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

function diagramHistoryFromMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages.flatMap((message, messageIndex) => {
    if (message?.role !== 'ai' || !Array.isArray(message.diagrams)) return [];

    return message.diagrams
      .filter((diagram) => diagram?.flow?.nodes?.length)
      .map((diagram, diagramIndex) => ({
        id: `map-${messageIndex}-${diagramIndex}`,
        title: diagram.title || diagram.name || `Context map ${messageIndex + 1}`,
        summary: String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        flow: diagram.flow,
      }));
  });
}

export default function ChatWindow({
  user,
  docs = [],
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
    const inputRef = useRef(null);
    const streamAbortRef = useRef(null);
    const activeAssistantMessageIdRef = useRef(null);
    const shouldAutoScrollRef = useRef(true);
    const forceAutoScrollRef = useRef(false);

    const isDocumentProcessing = ingestState?.status === 'uploading' || ingestState?.status === 'processing';
    const canUploadKnowledge = ['member', 'editor', 'admin', 'owner'].includes(user?.role);

    const username = user?.username ?? null;

    const effectiveSessionId = useMemo(() => activeSessionId, [activeSessionId]);
    const mentionRange = useMemo(() => {
      const cursor = inputRef.current?.selectionStart ?? input.length;
      const beforeCursor = input.slice(0, cursor);
      const match = beforeCursor.match(/(?:^|\s)@([^\]\n]*)$/);
      if (!match) return null;
      return {
        start: beforeCursor.lastIndexOf('@'),
        end: cursor,
        query: match[1].trim().toLowerCase(),
      };
    }, [input]);
    const mentionableDocs = useMemo(() => (docs || []).filter((doc) => documentSourceName(doc) && documentDisplayName(doc)), [docs]);
    const documentSuggestions = useMemo(() => {
      if (!mentionRange) return [];
      return mentionableDocs
        .filter((doc) => documentDisplayName(doc).toLowerCase().includes(mentionRange.query))
        .slice(0, 6);
    }, [mentionRange, mentionableDocs]);
    const selectedMentionDocs = useMemo(() => {
      const normalizedInput = input.toLowerCase();
      return mentionableDocs.filter((doc) => normalizedInput.includes(documentMentionTag(doc).toLowerCase()));
    }, [input, mentionableDocs]);

    const insertDocumentMention = useCallback((doc) => {
      const inputElement = inputRef.current;
      const cursor = inputElement?.selectionStart ?? input.length;
      const start = mentionRange?.start ?? cursor;
      const end = mentionRange?.end ?? cursor;
      const prefix = mentionRange ? '' : (input && !/\s$/.test(input.slice(0, cursor)) ? ' ' : '');
      const inserted = `${prefix}${documentMentionTag(doc)} `;
      const next = `${input.slice(0, start)}${inserted}${input.slice(end)}`;
      const nextCursor = start + inserted.length;
      setInput(next);
      onInputChange?.(next);
      window.setTimeout(() => {
        inputElement?.focus();
        inputElement?.setSelectionRange(nextCursor, nextCursor);
      }, 0);
    }, [input, mentionRange, onInputChange]);

    const removeDocumentMention = useCallback((doc) => {
      const tag = documentMentionTag(doc);
      const next = input.replaceAll(tag, '').replace(/\s{2,}/g, ' ').trimStart();
      setInput(next);
      onInputChange?.(next);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }, [input, onInputChange]);

    const startDocumentMention = useCallback(() => {
      if (isTyping) return;
      const inputElement = inputRef.current;
      const cursor = inputElement?.selectionStart ?? input.length;
      const prefix = cursor > 0 && !/\s$/.test(input.slice(0, cursor)) ? ' @' : '@';
      const next = `${input.slice(0, cursor)}${prefix}${input.slice(cursor)}`;
      const nextCursor = cursor + prefix.length;
      setInput(next);
      onInputChange?.(next);
      window.setTimeout(() => {
        inputElement?.focus();
        inputElement?.setSelectionRange(nextCursor, nextCursor);
      }, 0);
    }, [input, isTyping, onInputChange]);

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
          const nextMessages = normalized.map((m) => ({
              id: m.id || genMessageId(m.role === 'human' ? 'human' : 'assistant'),
              role: m.role,
              content: m.content,
              diagrams: Array.isArray(m.diagrams) ? m.diagrams : [],
              sources: Array.isArray(m.sources) ? m.sources : [],
            }));
          setMessages(nextMessages);
          const latestAssistant = [...nextMessages].reverse().find((message) => message.role === 'ai');
          onResponse?.({
            answer: latestAssistant?.content || '',
            diagrams: latestAssistant?.diagrams || [],
            sources: latestAssistant?.sources || [],
            diagramHistory: diagramHistoryFromMessages(nextMessages),
            restored: true,
          });
        } catch {
          setMessages([]);
          onResponse?.({ answer: '', diagrams: [], sources: [], diagramHistory: [], restored: true });
        }
      },
      [username, onResponse]
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
        onResponse?.({ answer: '', diagrams: [], sources: [], diagramHistory: [] });
        if (newSession?.sessionId) {
          setActiveSessionIdState(newSession.sessionId);
        }
      })();
    }, [username, onResponse]);
  
    const sendMessage = async (options = {}) => {
      const text = String(options.textOverride ?? input).trim();
      if (!text || isTyping) return;
      if (!username || !effectiveSessionId) return;
      const normalizedQuestion = text.toLowerCase();
      const selectedSources = mentionableDocs
        .filter((doc) => normalizedQuestion.includes(documentMentionTag(doc).toLowerCase()))
        .map(documentSourceName);
      const replaceMessageId = options.replaceMessageId || null;
      const replaceHumanTurn = Number.isInteger(options.replaceHumanTurn)
        ? options.replaceHumanTurn
        : null;

      forceAutoScrollRef.current = true;
      const userMsgId = replaceMessageId || genMessageId('human');
      const assistantMessageId = genMessageId('assistant');
      const userMsg = { id: userMsgId, role: 'human', content: text };
      const pendingAssistant = {
          id: assistantMessageId,
          role: 'ai',
          content: '',
          diagrams: [],
          sources: [],
          streaming: true,
        };
      setMessages((prev) => {
        if (!replaceMessageId) return [...prev, userMsg, pendingAssistant];
        const replaceIndex = prev.findIndex((message) => message.id === replaceMessageId);
        if (replaceIndex < 0) return [...prev, userMsg, pendingAssistant];
        return [...prev.slice(0, replaceIndex), userMsg, pendingAssistant];
      });
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
          selectedSources,
          replaceHumanTurn,
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
            selectedSources,
            replaceHumanTurn,
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

    const editHumanMessage = (messageId, content) => {
      if (isTyping) return;
      const messageIndex = messages.findIndex((message) => message.id === messageId);
      if (messageIndex < 0) return;
      const replaceHumanTurn = messages
        .slice(0, messageIndex + 1)
        .filter((message) => message.role === 'human').length - 1;
      sendMessage({ textOverride: content, replaceMessageId: messageId, replaceHumanTurn });
    };

    const retryAssistantMessage = (messageId) => {
      if (isTyping) return;
      const assistantIndex = messages.findIndex((message) => message.id === messageId);
      if (assistantIndex < 0) return;
      let humanIndex = assistantIndex - 1;
      while (humanIndex >= 0 && messages[humanIndex].role !== 'human') humanIndex -= 1;
      if (humanIndex < 0) return;
      const humanMessage = messages[humanIndex];
      const replaceHumanTurn = messages
        .slice(0, humanIndex + 1)
        .filter((message) => message.role === 'human').length - 1;
      sendMessage({
        textOverride: humanMessage.content,
        replaceMessageId: humanMessage.id,
        replaceHumanTurn,
      });
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
                : <MessageBubble
                    key={m.id ?? `${m.role}_${m.content?.slice(0,20)}`}
                    message={m}
                    documents={docs}
                    disabled={isTyping}
                    onEdit={m.role === 'human' ? editHumanMessage : undefined}
                    onRetry={m.role === 'ai' && !m.streaming ? retryAssistantMessage : undefined}
                  />
            ))
          }
          {isTyping && !isReceivingTokens && <ThinkingIndicator stage={thinkingStage} />}
          <div ref={messagesEndRef} />
        </div>
  
        <div
          className="relative flex items-end gap-2 rounded-2xl p-1.5"
          style={{
            background: 'var(--dc-surface-0)',
            border: `1px solid ${input.trim() || isTyping ? 'var(--dc-brand-border)' : 'var(--dc-border)'}`,
            boxShadow: input.trim() ? '0 0 0 3px rgba(37,99,235,0.08)' : 'none',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}
        >
          {documentSuggestions.length > 0 && (
            <div className="absolute z-30 bottom-[calc(100%+8px)] left-0 w-full max-w-md overflow-hidden rounded-xl" style={{ background: 'var(--dc-surface-0)', border: '1px solid var(--dc-border-strong)', boxShadow: '0 16px 42px rgba(30,52,78,.16)' }}>
              <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--dc-border)' }}>
                <AtSign size={13} style={{ color: 'var(--dc-brand)' }} />
                <div><p className="text-xs font-semibold">Choose files for this answer</p><p className="text-[10px]" style={{ color: 'var(--dc-text-muted)' }}>The AI will search only the files you tag</p></div>
              </div>
              <div className="max-h-56 overflow-y-auto p-1.5 custom-scrollbar">
                {documentSuggestions.map((doc) => (
                  <button key={documentSourceName(doc)} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertDocumentMention(doc)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-slate-50">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}><FileText size={15} /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{documentDisplayName(doc)}</span><span className="block text-[10px] capitalize" style={{ color: 'var(--dc-text-muted)' }}>{doc.accessRole || doc.access_role || 'permitted'} access</span></span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={startDocumentMention}
            disabled={isTyping || mentionableDocs.length === 0}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-40"
            style={{ background: 'var(--dc-surface-1)', color: 'var(--dc-brand)' }}
            aria-label="Choose files for this question"
            title="Choose specific files"
          >
            <AtSign size={16} />
          </button>

          {canUploadKnowledge && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('deepcontext-open-upload'))}
              disabled={isDocumentProcessing}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-40"
              style={{ background: 'var(--dc-surface-1)', color: 'var(--dc-text-secondary)' }}
              aria-label="Upload files to the knowledge base"
              title={isDocumentProcessing ? 'An upload is already processing' : 'Upload knowledge'}
            >
              <UploadCloud size={16} />
            </button>
          )}

          <div className="min-w-0 flex-1">
          {selectedMentionDocs.length > 0 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
              <span className="text-[10px] font-medium" style={{ color: 'var(--dc-text-muted)' }}>Searching only:</span>
              {selectedMentionDocs.map((doc) => (
                <span key={documentSourceName(doc)} className="inline-flex max-w-48 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold" style={{ background: 'var(--dc-brand-dim)', color: 'var(--dc-brand)' }}>
                  <AtSign size={10} /><span className="truncate">{documentDisplayName(doc)}</span>
                  <button type="button" onClick={() => removeDocumentMention(doc)} className="shrink-0" aria-label={`Remove ${documentDisplayName(doc)} from this question`}><X size={10} /></button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              onInputChange?.(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && documentSuggestions.length > 0) {
                e.preventDefault();
                insertDocumentMention(documentSuggestions[0]);
                return;
              }
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
                          : 'Ask your knowledge base…'
            }
            rows={1}
            className="block w-full resize-none bg-transparent px-1 py-2 text-sm leading-5 focus:outline-none custom-scrollbar"
            style={{ color: 'var(--dc-text-primary)', minHeight: '36px', maxHeight: '140px' }}
          />
          </div>

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
