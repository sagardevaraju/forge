'use client';
/**
 * SITREP panel.
 *
 * Pre-loads the prompt with the active-event context (storm ID, peak wind,
 * fire-count, data source) so clicking Generate produces a real memo instead
 * of a follow-up "which storm did you mean?" Renders the response inside a
 * <pre> for the demo — full ReactMarkdown is intentionally out of scope.
 */
import { useState } from 'react';
import { readChatStream } from '@/lib/chat-stream';

export interface SitrepContext {
  storm_id: string;
  advisory_number: string | null;
  peak_wind: number | null;
  fire_count: number;
  source: 'live' | 'mock';
}

interface Props {
  sitrepMd: string;
  context: SitrepContext | null;
  onGenerate: (md: string) => void;
}

function buildPrompt(ctx: SitrepContext | null): string {
  if (!ctx) {
    return (
      'Draft a 5-paragraph sitrep memo describing the carrier book posture in ' +
      'the absence of an active named storm. Call the draft_sitrep tool. Cover ' +
      'portfolio status, claims-prep readiness, and operational standby.'
    );
  }
  return (
    `Draft a 5-paragraph sitrep memo for storm ${ctx.storm_id}` +
    (ctx.advisory_number ? ` (advisory ${ctx.advisory_number})` : '') +
    `. Peak wind ${ctx.peak_wind ?? 'unknown'} mph. ` +
    `${ctx.fire_count} active fires reported in the bbox. ` +
    `Data source: ${ctx.source === 'live' ? 'live NHC feed' : 'demo scenario'}. ` +
    'Use the draft_sitrep tool. Include portfolio posture, operational ' +
    'recommendations (adjuster staging by exposed ZIP3), and claims-prep ' +
    'recommendations (pre-flag thresholds, communication cadence).'
  );
}

export function SitrepPanel({ sitrepMd, context, onGenerate }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function generate() {
    setBusy(true);
    setStatus('Calling draft_sitrep…');
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: buildPrompt(context) }],
        }),
      });
      if (!r.ok) throw new Error(`chat returned ${r.status}`);
      let final = '';
      for await (const ev of readChatStream(r)) {
        if (ev.type === 'tool_call') setStatus(`Calling ${ev.name}…`);
        else if (ev.type === 'tool_result')
          setStatus(ev.ok ? `${ev.name} → ${ev.summary}` : `${ev.name} failed`);
        else if (ev.type === 'final') final = ev.text;
        else if (ev.type === 'error') throw new Error(ev.message);
      }
      onGenerate(final || '(empty memo)');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onGenerate(`Error drafting sitrep: ${msg}`);
    } finally {
      setBusy(false);
      setStatus('');
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
      {busy && status && (
        <div className="text-xs italic text-zinc-600" data-testid="sitrep-status">
          {status}
        </div>
      )}
      {sitrepMd ? (
        <pre className="text-xs whitespace-pre-wrap font-sans">{sitrepMd}</pre>
      ) : !busy ? (
        <div className="text-xs text-zinc-500">No sitrep yet. Click Generate.</div>
      ) : null}
    </div>
  );
}
