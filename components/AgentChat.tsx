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
 *
 * Task 22 — `tool_call` events carry an `iteration` counter from the route's
 * tool-call loop. Surface "(Iter N/6)" in the status line so operators can
 * see when the agent is approaching the hard cap and decide whether to
 * tighten their question.
 *
 * Task P2.25 — Free / Procedure mode toggle. In Procedure mode the operator
 * picks one of 7 named runbooks (pre_landfall_t72/t48/t24, landfall,
 * post_landfall_t24/t72, post_storm_post_mortem) and supplies a storm_id.
 * The route runs the runbook's fixed tool-call sequence with no LLM tool
 * selection, then summarizes the results. Toggle is per-message: switching
 * back to Free keeps the chat log intact.
 */
import { useState } from 'react';
import { readChatStream, MAX_TOOL_ITERATIONS, type Citation } from '@/lib/chat-stream';
import { RUNBOOKS, type RunbookId } from '@/lib/runbooks';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
}

type Mode = 'free' | 'procedure';

export function AgentChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string>('');
  const [mode, setMode] = useState<Mode>('free');
  const [runbookId, setRunbookId] = useState<RunbookId | ''>('');
  const [stormId, setStormId] = useState('');

  async function send() {
    if (busy) return;
    if (mode === 'free' && !input.trim()) return;
    if (mode === 'procedure' && !runbookId) return;

    const userContent =
      mode === 'free'
        ? input
        : `Run runbook ${runbookId}${stormId ? ` for ${stormId}` : ''}`;

    const next: Msg[] = [...messages, { role: 'user', content: userContent }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setStatusLine(mode === 'procedure' ? `Running ${runbookId}…` : 'Thinking…');
    try {
      const payload: Record<string, unknown> = { messages: next };
      if (mode === 'procedure') {
        payload.mode = 'procedure';
        payload.runbook_id = runbookId;
        payload.runbook_params = stormId ? { storm_id: stormId } : {};
      }
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`chat returned ${r.status}`);

      let final = '';
      let citations: Citation[] | undefined;
      for await (const ev of readChatStream(r)) {
        if (ev.type === 'tool_call') {
          const iterTag = ev.iteration
            ? mode === 'procedure'
              ? ` (Step ${ev.iteration})`
              : ` (Iter ${ev.iteration}/${MAX_TOOL_ITERATIONS})`
            : '';
          // Task P2.25 — procedure-mode tool_call events carry a
          // human-readable `description`. Surface it verbatim when present.
          const desc = (ev as { description?: string }).description;
          const label = desc ? `${ev.name}, ${desc}` : ev.name;
          setStatusLine(`Calling ${label}…${iterTag}`);
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
      <div className="flex items-center justify-between">
        <div className="font-semibold text-sm">Ask FORGE</div>
        <div
          className="inline-flex rounded border text-xs overflow-hidden"
          data-testid="agent-mode-toggle"
          role="tablist"
          aria-label="chat mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'free'}
            data-testid="agent-mode-free"
            onClick={() => setMode('free')}
            disabled={busy}
            className={
              mode === 'free'
                ? 'bg-blue-600 text-white px-2 py-0.5'
                : 'bg-white text-zinc-700 px-2 py-0.5'
            }
          >
            Free
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'procedure'}
            data-testid="agent-mode-procedure"
            onClick={() => setMode('procedure')}
            disabled={busy}
            className={
              mode === 'procedure'
                ? 'bg-blue-600 text-white px-2 py-0.5'
                : 'bg-white text-zinc-700 px-2 py-0.5'
            }
          >
            Procedure
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto space-y-2 text-sm">
        {messages.length === 0 && (
          <div className="text-zinc-500 text-xs">
            {mode === 'free'
              ? 'e.g., "What’s our Tampa exposure?"'
              : 'Pick a runbook, supply a storm_id, then Run.'}
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
      {mode === 'free' ? (
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
      ) : (
        <div className="flex gap-2 flex-wrap" data-testid="agent-procedure-form">
          <select
            className="border rounded px-2 py-1 text-sm flex-1 min-w-[160px]"
            value={runbookId}
            onChange={(e) => setRunbookId(e.target.value as RunbookId | '')}
            disabled={busy}
            aria-label="agent-runbook"
          >
            <option value="">Pick a runbook…</option>
            {RUNBOOKS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {runbookId && (
            <input
              className="border rounded px-2 py-1 text-sm w-32"
              value={stormId}
              onChange={(e) => setStormId(e.target.value)}
              placeholder="storm_id"
              disabled={busy}
              aria-label="agent-storm-id"
            />
          )}
          <button
            onClick={send}
            disabled={busy || !runbookId}
            className="bg-blue-600 text-white px-3 rounded text-sm disabled:opacity-50"
          >
            Run
          </button>
        </div>
      )}
    </div>
  );
}
