/**
 * SimulationBanner — amber alert strip shown on /portfolio when there are
 * promoted+non-retired simulations that are NOT yet reflected in the
 * cached portfolio_optimization.meta.json (i.e. the MIP was last solved
 * before these sims were promoted, so TVaR-99 is stale).
 *
 * Task 22 (simulate-tab): component + 3 Vitest assertions.
 * Task 23 (simulate-tab): mounted above PortfolioPersonaScope in
 * app/portfolio/page.tsx so it is always visible regardless of persona lens.
 * 2026-05-25 — consume the new NDJSON progress stream from
 * `POST /api/portfolio/reoptimize` so the busy state surfaces:
 *   - per-sim sync progress ("Regenerating sim losses (47/188)")
 *   - precompute kickoff + coarse stage labels
 *   - elapsed wall-clock (M:SS)
 * The legacy single-shot JSON path is still on the route; this client
 * opts into streaming via `Accept: application/x-ndjson`.
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import {
  formatElapsed,
  readReoptimizeStream,
  type ReoptimizeEvent,
} from '@/lib/reoptimize-stream';
import { InfoIcon } from '@/components/grammar/InfoTooltip';

export interface UnresolvedSim {
  id: string;
  name: string;
  peril: string;
  promoted_at: string;
}

export interface SimulationBannerProps {
  unresolved: UnresolvedSim[];
}

/**
 * What the banner is currently showing for the busy state. Pure
 * presentation — the route's stream is the source of truth.
 */
interface ProgressState {
  // Coarse stage the operator sees in the label.
  stage:
    | 'starting'
    | 'syncing_sims'
    | 'sync_idle' // all caches present, skipping straight to precompute
    | 'precompute_starting'
    | 'precompute_running'
    | 'finishing';
  // Sim sync tick — populated only during `syncing_sims`.
  simIdx?: number;
  simTotal?: number;
  // Latest coarse-stage label from `classifyPrecomputeLine`.
  precomputeLabel?: string;
}

function describe(progress: ProgressState, elapsedMs: number): string {
  const elapsed = formatElapsed(elapsedMs);
  switch (progress.stage) {
    case 'starting':
      return `Starting re-optimize… · ${elapsed}`;
    case 'syncing_sims':
      if (progress.simTotal && progress.simIdx !== undefined) {
        return `Regenerating sim losses (${progress.simIdx}/${progress.simTotal}) · ${elapsed}`;
      }
      return `Regenerating sim losses… · ${elapsed}`;
    case 'sync_idle':
      return `Sim caches OK · solving MIP… · ${elapsed}`;
    case 'precompute_starting':
      return `Solving Portfolio MIP… · ${elapsed}`;
    case 'precompute_running':
      return `${progress.precomputeLabel ?? 'Solving Portfolio MIP'} · ${elapsed}`;
    case 'finishing':
      return `Finalizing artifact… · ${elapsed}`;
  }
}

export function SimulationBanner({ unresolved }: SimulationBannerProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState>({ stage: 'starting' });

  // Tick the elapsed-time counter once per second while busy. The
  // start timestamp lives in a ref so each tick re-reads from the
  // same anchor without depending on stale state from the closure.
  const startedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!busy) {
      startedAtRef.current = null;
      setElapsedMs(0);
      return;
    }
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => {
      if (startedAtRef.current === null) return;
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  if (unresolved.length === 0) return null;

  const headline =
    unresolved.length === 1
      ? `1 unresolved simulation — ${unresolved[0].name}`
      : `${unresolved.length} unresolved simulations`;

  function applyEvent(event: ReoptimizeEvent): void {
    if (event.type === 'phase') {
      if (event.stage === 'sync_start') {
        if ((event.total ?? 0) === 0) {
          setProgress({ stage: 'sync_idle' });
        } else {
          setProgress({
            stage: 'syncing_sims',
            simIdx: 0,
            simTotal: event.total,
          });
        }
      } else if (event.stage === 'sync_tick') {
        setProgress((prev) => ({
          ...prev,
          stage: 'syncing_sims',
          simIdx: event.idx,
          simTotal: event.total,
        }));
      } else if (event.stage === 'sync_done') {
        // Sync done — leave the label flavor up to the precompute
        // kickoff (which fires next). The sync_idle branch sets a
        // dedicated label when sync was a no-op.
        setProgress((prev) =>
          prev.stage === 'sync_idle' ? prev : { ...prev, stage: 'syncing_sims' },
        );
      } else if (event.stage === 'precompute_start') {
        setProgress({ stage: 'precompute_starting' });
      } else if (event.stage === 'precompute_tick') {
        setProgress({
          stage: 'precompute_running',
          precomputeLabel: event.label,
        });
      }
    } else if (event.type === 'done') {
      setProgress({ stage: 'finishing' });
    } else if (event.type === 'error') {
      setErr(event.message);
    }
    // `log` events are deliberately ignored by this UI — they're a
    // deep-debug channel for tooling, not for the banner label.
  }

  async function reoptimize() {
    setBusy(true);
    setErr(null);
    setProgress({ stage: 'starting' });
    try {
      const res = await fetch('/api/portfolio/reoptimize', {
        method: 'POST',
        headers: { Accept: 'application/x-ndjson' },
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ||
            `re-optimize failed (${res.status})`,
        );
      }
      let lastEvent: ReoptimizeEvent | null = null;
      for await (const event of readReoptimizeStream(res)) {
        applyEvent(event);
        lastEvent = event;
      }
      if (lastEvent && lastEvent.type === 'error') {
        throw new Error(lastEvent.message);
      }
      // Successful stream → reload the page so the freshly written
      // portfolio_optimization.json + meta.json are picked up by the
      // server component on the next render.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const label = busy
    ? describe(progress, elapsedMs)
    : 'Re-optimize portfolio';

  return (
    <div className="bg-amber-950/40 border border-amber-900 rounded-lg p-3 mb-4 flex items-start gap-3">
      <span aria-hidden className="text-amber-400 text-lg leading-none">
        ⚠
      </span>
      <div className="flex-1">
        <div className="text-sm text-amber-200 font-medium inline-flex items-center gap-1">
          {headline}
          <InfoIcon term="unresolved-simulation" iconSize="sm" />
        </div>
        <div className="text-xs text-amber-400/80 mt-0.5 inline-flex items-center gap-1 flex-wrap">
          Adds <span className="inline-flex items-center gap-1">K=1000<InfoIcon term="k-1000" iconSize="sm" /></span> per sim to joint <span className="inline-flex items-center gap-1">TVaR-99<InfoIcon term="tvar-99" iconSize="sm" /></span>. Re-optimize to see updated portfolio actions.
        </div>
        {err && <div className="text-xs text-red-400 mt-1">{err}</div>}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reoptimize}
          disabled={busy}
          // Wider min width when busy so the M:SS counter doesn't
          // cause the button to twitch on every tick.
          className="bg-amber-700 hover:bg-amber-600 disabled:bg-slate-700 text-white text-xs px-3 py-1.5 rounded font-semibold min-w-[12rem] whitespace-nowrap"
          data-testid="reoptimize-button"
        >
          {label}
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
