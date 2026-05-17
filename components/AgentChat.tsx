'use client';
/**
 * Agent chat panel.
 *
 * Consumes the NDJSON stream from `POST /api/agent/chat` so users see tool
 * calls happen in real time instead of waiting in silence. Each `tool_call`
 * event becomes a "Calling X…" status line; each `tool_result` collapses
 * it; the `final` event becomes the assistant's reply.
 *
 * Task 21 — when the `final` event carries `citations`, render a
 * "Sources: tool@hash" breadcrumb under the assistant message so analysts
 * can trace which tool result each numeric claim came from.
 */
import { useState } from 'react';
import { readChatStream, type Citation } from '@/lib/chat-stream';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
}

export function AgentChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string>('');

  async function send() {
    if (!input.trim() || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: input }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setStatusLine('Thinking…');
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: next }),
      });
      if (!r.ok) throw new Error(`chat returned ${r.status}`);

      let final = '';
      let citations: Citation[] | undefined;
      for await (const ev of readChatStream(r)) {
        if (ev.type === 'tool_call') {
          setStatusLine(`Calling ${ev.name}…`);
        } else if (ev.type === 'tool_result') {
          setStatusLine(
            ev.ok ? `${ev.name} → ${ev.summary}` : `${ev.name} failed`,
          );
        } else if (ev.type === 'final') {
          final = ev.text;
          citations = ev.citations;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
      setMessages([
        ...next,
        {
          role: 'assistant',
          content: final || '(empty response)',
          citations,
        },
      ]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages([...next, { role: 'assistant', content: `Error: ${msg}` }]);
    } finally {
      setBusy(false);
      setStatusLine('');
    }
  }

  return (
    <div
      data-testid="agent-chat"
      className="border rounded p-3 flex flex-col gap-2 max-h-[40vh] overflow-hidden"
    >
      <div className="font-semibold text-sm">Ask FORGE</div>
      <div className="flex-1 overflow-auto space-y-2 text-sm">
        {messages.length === 0 && (
          <div className="text-zinc-500 text-xs">
            e.g., &quot;What&apos;s our Tampa exposure?&quot;
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === 'user' ? 'text-zinc-900' : 'text-blue-700'}
          >
            <span className="font-medium">
              {m.role === 'user' ? 'You' : 'FORGE'}:{' '}
            </span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
            {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
              <div
                className="text-[10px] text-zinc-500 mt-1"
                data-testid="agent-citations"
              >
                Sources:{' '}
                {m.citations
                  .map((c) => `${c.tool}@${c.result_hash}`)
                  .join(', ')}
              </div>
            )}
          </div>
        ))}
        {busy && statusLine && (
          <div
            className="text-zinc-600 text-xs italic"
            data-testid="agent-status-line"
          >
            {statusLine}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-2 py-1 text-sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder="Ask a question…"
          disabled={busy}
          aria-label="agent-input"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="bg-blue-600 text-white px-3 rounded text-sm disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
