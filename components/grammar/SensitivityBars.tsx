'use client';

/**
 * Task P2.14 (Redesign Phase 2) — SensitivityBars grammar primitive.
 *
 * Given a baseline `PortfolioOptimization` (current budgets + objective),
 * fires six perturbed solves (±N% on each of the three budget axes) and
 * renders the resulting Δobjective per axis as a horizontal ± bar:
 *
 *   capital_budget    [───┤─●─┤── center ──┤─●─┤───]   -$1.2M / +$0.8M
 *   max_nonrenew_pct  [───── center ──┤─●─┤───────]   −$0.0M / +$0.3M
 *   cession_budget    [───┤─●─┤── center ──────────]   −$0.1M / +$0.0M
 *
 * The six solves are kicked off in parallel via `Promise.all` on mount.
 * Each axis's bar shows the two deltas; negative perturbation is drawn in
 * neutral slate (loss of flexibility), positive in emerald (more headroom).
 * The center tick advertises the unperturbed objective for visual reference.
 *
 * Trust grammar:
 *   • Each bar is annotated with the MODEL_OUTPUT trust tier because the
 *     deltas are real solver responses, not approximations.
 *   • A ProvenanceFootnote at the bottom describes the six-solve pipeline.
 *
 * Failure isolation:
 *   If one of the six solves rejects, that single ± leg (and the bar that
 *   contains it) is marked with `?` and a tooltip carrying the error
 *   message. The other bars render normally — a partial result is far more
 *   useful than blanking out the whole sensitivity panel.
 *
 * Pure primitive: no /portfolio page coupling. Tests inject `onSolve`;
 * production falls back to `POST /api/optimize/portfolio` (P2.12).
 */

import { useEffect, useState } from 'react';
import { TrustTierBadge } from './TrustTierBadge';
import { ProvenanceFootnote } from './ProvenanceFootnote';

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

export interface BudgetTriple {
  capital_budget: number;
  max_nonrenew_pct: number;
  cession_budget: number;
}

export interface SensitivityBaseline extends BudgetTriple {
  objective: number;
}

export interface SensitivityBarsProps {
  baseline: SensitivityBaseline;
  /**
   * Injectable for tests. Production callers can omit this and the
   * component will POST to `/api/optimize/portfolio`.
   */
  onSolve?: (budgets: BudgetTriple) => Promise<{ objective: number }>;
  /**
   * Multiplier offset. 0.10 → ×0.9 / ×1.1 on each axis. Defaults to 0.10.
   */
  perturbation?: number;
}

type BudgetAxis = 'capital_budget' | 'max_nonrenew_pct' | 'cession_budget';

const AXES: ReadonlyArray<BudgetAxis> = [
  'capital_budget',
  'max_nonrenew_pct',
  'cession_budget',
];

const AXIS_LABEL: Record<BudgetAxis, string> = {
  capital_budget: 'Capital budget',
  max_nonrenew_pct: 'Non-renew cap',
  cession_budget: 'Cession budget',
};

interface AxisResult {
  axis: BudgetAxis;
  delta_low: number | null; // Δobjective at ×(1 - perturbation); null on solve failure.
  delta_high: number | null; // Δobjective at ×(1 + perturbation); null on solve failure.
  error_low?: string;
  error_high?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function perturb(
  baseline: SensitivityBaseline,
  axis: BudgetAxis,
  multiplier: number,
): BudgetTriple {
  return {
    capital_budget:
      axis === 'capital_budget'
        ? baseline.capital_budget * multiplier
        : baseline.capital_budget,
    max_nonrenew_pct:
      axis === 'max_nonrenew_pct'
        ? baseline.max_nonrenew_pct * multiplier
        : baseline.max_nonrenew_pct,
    cession_budget:
      axis === 'cession_budget'
        ? baseline.cession_budget * multiplier
        : baseline.cession_budget,
  };
}

async function defaultSolve(budgets: BudgetTriple): Promise<{ objective: number }> {
  const resp = await fetch('/api/optimize/portfolio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(budgets),
  });
  if (!resp.ok) {
    throw new Error(`solver HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { objective?: number };
  if (typeof data.objective !== 'number' || !Number.isFinite(data.objective)) {
    throw new Error('solver response missing numeric objective');
  }
  return { objective: data.objective };
}

function formatDelta(delta: number | null): string {
  if (delta === null) return '?';
  const sign = delta >= 0 ? '+' : '-';
  const magnitude = Math.abs(delta) / 1e6;
  return `${sign}$${magnitude.toFixed(1)}M`;
}

/**
 * Map a Δobjective onto a 0–100 % position within the bar, where 50 % is
 * the baseline and the larger absolute leg saturates the full half-width.
 * Returns null when the delta is unavailable (`?` rendering).
 */
function positionPct(
  delta: number | null,
  maxAbs: number,
): number | null {
  if (delta === null || maxAbs === 0) return null;
  const half = (Math.abs(delta) / maxAbs) * 50; // % offset from the centre
  return delta >= 0 ? 50 + half : 50 - half;
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function SensitivityBars({
  baseline,
  onSolve,
  perturbation = 0.1,
}: SensitivityBarsProps) {
  const [results, setResults] = useState<AxisResult[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    const solve = onSolve ?? defaultSolve;
    setLoading(true);

    const lowMult = 1 - perturbation;
    const highMult = 1 + perturbation;

    // Build the 6 jobs in a stable order and fire them in parallel. We use
    // Promise.allSettled so one failing leg doesn't blank out the whole
    // panel — the failure-isolation contract in the task spec.
    const jobs: Array<{ axis: BudgetAxis; side: 'low' | 'high' }> = AXES.flatMap(
      (axis) => [
        { axis, side: 'low' as const },
        { axis, side: 'high' as const },
      ],
    );

    const promises = jobs.map((job) =>
      solve(perturb(baseline, job.axis, job.side === 'low' ? lowMult : highMult)),
    );

    Promise.allSettled(promises).then((settled) => {
      if (cancelled) return;
      const byAxis: Record<BudgetAxis, AxisResult> = {
        capital_budget: { axis: 'capital_budget', delta_low: null, delta_high: null },
        max_nonrenew_pct: { axis: 'max_nonrenew_pct', delta_low: null, delta_high: null },
        cession_budget: { axis: 'cession_budget', delta_low: null, delta_high: null },
      };
      settled.forEach((outcome, i) => {
        const { axis, side } = jobs[i];
        if (outcome.status === 'fulfilled') {
          const delta = outcome.value.objective - baseline.objective;
          if (side === 'low') byAxis[axis].delta_low = delta;
          else byAxis[axis].delta_high = delta;
        } else {
          const msg =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          if (side === 'low') byAxis[axis].error_low = msg;
          else byAxis[axis].error_high = msg;
        }
      });
      setResults(AXES.map((a) => byAxis[a]));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [baseline, onSolve, perturbation]);

  if (loading || !results) {
    return (
      <div
        data-testid="sensitivity-bars-skeleton"
        role="status"
        aria-label="loading sensitivity bars"
        className="flex flex-col gap-2 p-3 border rounded bg-white"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-600 uppercase tracking-wide">
            Sensitivity (±{Math.round(perturbation * 100)}%)
          </span>
          <TrustTierBadge tier="MODEL_OUTPUT" />
        </div>
        {AXES.map((axis) => (
          <div key={axis} className="flex flex-col gap-1">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wide">
              {AXIS_LABEL[axis]}
            </div>
            <div className="h-3 bg-zinc-100 rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  // Saturate the bar at the max |Δ| seen across all axes so each row uses a
  // shared scale; this lets the eye compare magnitudes across axes.
  const maxAbs = Math.max(
    1, // guard against an all-zero result blowing up positionPct
    ...results.flatMap((r) =>
      [r.delta_low, r.delta_high]
        .filter((d): d is number => d !== null)
        .map(Math.abs),
    ),
  );

  return (
    <div
      data-testid="sensitivity-bars"
      className="flex flex-col gap-2 p-3 border rounded bg-white"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-600 uppercase tracking-wide">
          Sensitivity (±{Math.round(perturbation * 100)}%)
        </span>
        <TrustTierBadge tier="MODEL_OUTPUT" />
      </div>

      {results.map((row) => {
        const lowPos = positionPct(row.delta_low, maxAbs);
        const highPos = positionPct(row.delta_high, maxAbs);
        const hasError = row.error_low !== undefined || row.error_high !== undefined;
        const errMsg = [row.error_low, row.error_high].filter(Boolean).join(' / ');

        return (
          <div
            key={row.axis}
            data-testid="sensitivity-bar"
            data-axis={row.axis}
          >
            {/* Inner wrapper carries an axis-specific testid so tests can
                look up a single bar by name (`sensitivity-bar-capital_budget`)
                while the outer wrapper supports `getAllByTestId('sensitivity-bar')`. */}
            <div data-testid={`sensitivity-bar-${row.axis}`} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-600">
                <span className="uppercase tracking-wide">{AXIS_LABEL[row.axis]}</span>
                <span className="tabular-nums">
                  <span
                    data-testid="sensitivity-bar-low"
                    className={[
                      'mr-2',
                      row.delta_low === null ? 'text-zinc-400' : 'text-slate-700',
                    ].join(' ')}
                    title={row.error_low ?? undefined}
                  >
                    {formatDelta(row.delta_low)}
                  </span>
                  <span
                    data-testid="sensitivity-bar-high"
                    className={
                      row.delta_high === null ? 'text-zinc-400' : 'text-emerald-700'
                    }
                    title={row.error_high ?? undefined}
                  >
                    {formatDelta(row.delta_high)}
                  </span>
                </span>
              </div>
              <div
                className="relative h-3 bg-zinc-100 rounded"
                title={hasError ? errMsg : undefined}
              >
                {/* Baseline tick at the geometric centre of the bar. */}
                <div
                  data-testid="sensitivity-bar-baseline-tick"
                  aria-hidden="true"
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-4 w-0.5 bg-zinc-500 rounded-sm"
                />
                {/* Negative-perturbation leg (slate). */}
                {lowPos !== null && (
                  <div
                    aria-hidden="true"
                    className="absolute top-1/2 -translate-y-1/2 h-2 rounded-l bg-slate-400"
                    style={{
                      left: `${Math.min(lowPos, 50)}%`,
                      width: `${Math.max(0, 50 - Math.min(lowPos, 50))}%`,
                    }}
                  />
                )}
                {/* Positive-perturbation leg (emerald). */}
                {highPos !== null && (
                  <div
                    aria-hidden="true"
                    className="absolute top-1/2 -translate-y-1/2 h-2 rounded-r bg-emerald-400"
                    style={{
                      left: '50%',
                      width: `${Math.max(0, Math.max(highPos, 50) - 50)}%`,
                    }}
                  />
                )}
                {hasError && (
                  <span
                    data-testid="sensitivity-bar-error"
                    className="absolute top-1/2 right-1 -translate-y-1/2 text-[10px] text-amber-700 font-semibold"
                    title={errMsg}
                  >
                    ?
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      <ProvenanceFootnote
        source={`6 deterministic re-solves via /api/optimize/portfolio at ±${Math.round(
          perturbation * 100,
        )}% on each budget axis.`}
        method="Cached server-side by state hash for 5 minutes."
      />
    </div>
  );
}
