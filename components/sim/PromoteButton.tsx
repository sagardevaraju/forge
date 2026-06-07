'use client';
import { useState } from 'react';
import type { LossHistogram, LossSummary } from './LossDistribution';

export interface PromoteResult {
  K: number;
  n_cohorts: number;
  histogram?: LossHistogram;
  summary?: LossSummary;
}

export interface PromoteButtonProps {
  simId: string | null;
  promoted: boolean;
  onPromoted: (result: PromoteResult) => void;
}

export function PromoteButton({ simId, promoted, onPromoted }: PromoteButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (promoted) {
    return (
      <div className="mt-4 text-center text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
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
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 disabled:text-zinc-400 text-white font-semibold py-2 rounded"
      >
        {busy ? 'Generating K=1000 draws…' : 'Promote to scenario →'}
      </button>
      <div className="text-[10px] text-zinc-500 text-center">
        Generates K=1000 cohort losses. /portfolio will surface a re-optimize banner.
      </div>
      {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{err}</div>}
    </div>
  );
}
