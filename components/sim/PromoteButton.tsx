'use client';
import { useState } from 'react';

export interface PromoteButtonProps {
  simId: string | null;
  promoted: boolean;
  onPromoted: (result: { K: number; n_cohorts: number }) => void;
}

export function PromoteButton({ simId, promoted, onPromoted }: PromoteButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (promoted) {
    return (
      <div className="mt-4 text-center text-xs text-emerald-400 border border-emerald-900 rounded p-2">
        Already promoted — view banner on /portfolio to re-optimize.
      </div>
    );
  }

  async function onClick() {
    if (!simId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/sim/${simId}/promote`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `promote failed (${res.status})`);
      }
      onPromoted(await res.json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      <button
        type="button"
        disabled={!simId || busy}
        onClick={onClick}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold py-2 rounded"
      >
        {busy ? 'Generating K=1000 draws…' : 'Promote to scenario →'}
      </button>
      <div className="text-[10px] text-slate-400 text-center">
        Generates K=1000 cohort losses. /portfolio will surface a re-optimize banner.
      </div>
      {err && <div className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-2 py-1">{err}</div>}
    </div>
  );
}
