/**
 * SimulationBanner — amber alert strip shown on /portfolio when there are
 * promoted+non-retired simulations that are NOT yet reflected in the
 * cached portfolio_optimization.meta.json (i.e. the MIP was last solved
 * before these sims were promoted, so TVaR-99 is stale).
 *
 * Task 22 (simulate-tab): component + 3 Vitest assertions.
 * Task 23 (simulate-tab): mounted above PortfolioPersonaScope in
 * app/portfolio/page.tsx so it is always visible regardless of persona lens.
 */
'use client';
import { useState } from 'react';

export interface UnresolvedSim {
  id: string;
  name: string;
  peril: string;
  promoted_at: string;
}

export interface SimulationBannerProps {
  unresolved: UnresolvedSim[];
}

export function SimulationBanner({ unresolved }: SimulationBannerProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (unresolved.length === 0) return null;

  const headline =
    unresolved.length === 1
      ? `1 unresolved simulation — ${unresolved[0].name}`
      : `${unresolved.length} unresolved simulations`;

  async function reoptimize() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/portfolio/reoptimize', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ||
            `re-optimize failed (${res.status})`,
        );
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-amber-950/40 border border-amber-900 rounded-lg p-3 mb-4 flex items-start gap-3">
      <span aria-hidden className="text-amber-400 text-lg leading-none">
        ⚠
      </span>
      <div className="flex-1">
        <div className="text-sm text-amber-200 font-medium">{headline}</div>
        <div className="text-xs text-amber-400/80 mt-0.5">
          Adds K=1000 per sim to joint TVaR-99. Re-optimize to see updated
          portfolio actions.
        </div>
        {err && <div className="text-xs text-red-400 mt-1">{err}</div>}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reoptimize}
          disabled={busy}
          className="bg-amber-700 hover:bg-amber-600 disabled:bg-slate-700 text-white text-xs px-3 py-1.5 rounded font-semibold"
        >
          {busy ? 'Re-optimizing…' : 'Re-optimize portfolio'}
        </button>
        {unresolved.length === 1 && (
          <a
            href={`/simulate?id=${unresolved[0].id}`}
            className="text-xs px-3 py-1.5 rounded border border-amber-800 text-amber-200 hover:bg-amber-950/60"
          >
            View simulation
          </a>
        )}
      </div>
    </div>
  );
}
