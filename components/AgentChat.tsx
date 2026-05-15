'use client';
/**
 * Task 21 — Agent chat panel.
 *
 * Minimal chat UI against `POST /api/agent/chat`. Each user submission posts
 * the running message list and appends the plain-text response. The endpoint
 * already returns `text/plain` so there's no JSON parsing here.
 *
 * Streaming UX (token-by-token) is a deliberate future enhancement; the
 * current backend returns the final assistant content after the tool-call
 * loop completes, which keeps the wire format simple for the demo.
 */
import { useState } from 'react';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

export function AgentChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!input.trim() || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: input }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: next }),
      });
      const text = await r.text();
      setMessages([...next, { role: 'assistant', content: text }]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages([...next, { role: 'assistant', content: `Error: ${msg}` }]);
    } finally {
      setBusy(false);
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
          </div>
        ))}
        {busy && <div className="text-zinc-500 text-xs">Thinking…</div>}
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
