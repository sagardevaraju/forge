'use client';
/**
 * Task 21 — SITREP panel.
 *
 * Generates a draft markdown SITREP by hitting `/api/agent/chat` with a prompt
 * that directs the LLM to call the `draft_sitrep` tool. We render the response
 * inside a <pre> for the demo — full ReactMarkdown is intentionally out of
 * scope here, the backend memo is already structured markdown and the <pre>
 * preserves the formatting without pulling a parser into the bundle.
 */
import { useState } from 'react';

interface Props {
  sitrepMd: string;
  onGenerate: (md: string) => void;
}

export function SitrepPanel({ sitrepMd, onGenerate }: Props) {
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content:
                'Draft a 5-paragraph sitrep memo for the current named storm. ' +
                'Use draft_sitrep tool. Include posture summary covering portfolio, ' +
                'operational, and claims-prep recommendations.',
            },
          ],
        }),
      });
      const text = await r.text();
      onGenerate(text);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onGenerate(`Error drafting sitrep: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="sitrep-panel"
      className="border rounded p-3 flex flex-col gap-2 max-h-[40vh] overflow-auto"
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold text-sm">Sitrep memo</div>
        <button
          onClick={generate}
          disabled={busy}
          className="bg-zinc-900 text-white px-2 py-1 rounded text-xs disabled:opacity-50"
        >
          {busy ? 'Drafting…' : 'Generate'}
        </button>
      </div>
      {sitrepMd ? (
        <pre className="text-xs whitespace-pre-wrap font-sans">{sitrepMd}</pre>
      ) : (
        <div className="text-xs text-zinc-500">No sitrep yet. Click Generate.</div>
      )}
    </div>
  );
}
