'use client';

/**
 * Task P2.15 (Redesign Phase 2) — Pareto sweep on the Portfolio page.
 *
 * 3×3 grid solve on (capital_budget, cession_budget) with
 * `max_nonrenew_pct` pinned to the baseline. The two budget axes are each
 * swept at multipliers [0.7×, 1.0×, 1.5×] of the baseline, giving 9
 * (capital, cession) pairs — the diagonal of which contains the baseline.
 *
 * UX:
 *   • Hidden behind a "Show Pareto sweep" toggle button to keep the
 *     portfolio header uncluttered until the operator asks.
 *   • On toggle-on, 9 parallel POSTs to `/api/optimize/portfolio` (P2.12)
 *     populate the grid. The route's TTL cache (5 min) deduplicates the
 *     baseline cell against the original solve, so the worst case is 8
 *     net new solves.
 *   • Each cell shows its (capital ×, cession ×) label + the achieved
 *     objective in $M. Cells are heatmap-shaded by objective magnitude;
 *     the baseline (1.0× / 1.0×) is outlined for instant orientation.
 *   • Infeasible cells render an "Infeasible" badge instead of $; cells
 *     whose server returned `Infeasible_relaxed` show the relaxed
 *     objective with a small "relaxed" marker so they don't lie about
 *     feasibility.
 *
 * Why a single click-and-fire rather than per-cell drag: the spec wants
 * the operator to read the *shape* of the frontier in one glance, not
 * to scrub individual budget axes (that's what P2.13/P2.14 are for).
 *
 * Trust grammar:
 *   • Panel header carries a MODEL_OUTPUT TrustTierBadge — every cell is
 *     a real PuLP/CBC solve, not an approximation.
 *   • ProvenanceFootnote announces the 9-parallel-solve pipeline.
 *
 * No new dependencies. Cells are rendered as a CSS grid; no chart lib.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import type { PortfolioOptimization } from '@/lib/portfolio-actions';

interface Props {
  baselineOptimization: PortfolioOptimization;
  /** Unused for the grid math itself, but kept symmetric with PortfolioWhatIfShell. */
  totalTiv: number;
}

/** Multipliers applied to each baseline budget along both axes of the grid. */
const MULTIPLIERS: ReadonlyArray<number> = [0.7, 1.0, 1.5];

interface CellResult {
  capitalMult: number;
  cessionMult: number;
  capitalBudget: number;
  cessionBudget: number;
  /** Achieved objective ($); null when infeasible or the request errored. */
  objective: number | null;
  /** Solver status echoed back (Optimal / Infeasible / Infeasible_relaxed). */
  status: string;
  /** Optional relaxation factor returned by the server (Infeasible_relaxed). */
  relaxation_factor?: number;
  /** When non-null, the cell renders as an error tile with this message. */
  error?: string;
}

interface ServerResponse extends PortfolioOptimization {
  error?: string;
  relaxation_factor?: number;
}

function formatObjectiveM(objective: number): string {
  return `$${(objective / 1e6).toFixed(1)}M`;
}

function formatMultiplier(m: number): string {
  // Render the diagonal as "1.0×" rather than "1×" for visual rhythm.
  return `${m.toFixed(1)}×`;
}

export function PortfolioPareto({ baselineOptimization, totalTiv: _totalTiv }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cells, setCells] = useState<CellResult[] | null>(null);
  const requestSeqRef = useRef(0);

  const baseCapital = baselineOptimization.budgets.capital_budget;
  const baseCession = baselineOptimization.budgets.cession_budget;
  const baseNonrenew = baselineOptimization.budgets.max_nonrenew_pct;

  const runSweep = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setCells(null);

    // Build the 9 budget triples. The outer loop iterates capital
    // (vertical axis: bottom row = looser cap), the inner loop iterates
    // cession (horizontal axis: rightmost = looser cession).
    const jobs: Array<{ capitalMult: number; cessionMult: number; budgets: { capital_budget: number; max_nonrenew_pct: number; cession_budget: number } }> = [];
    for (const capMult of MULTIPLIERS) {
      for (const cesMult of MULTIPLIERS) {
        jobs.push({
          capitalMult: capMult,
          cessionMult: cesMult,
          budgets: {
            capital_budget: baseCapital * capMult,
            max_nonrenew_pct: baseNonrenew,
            cession_budget: baseCession * cesMult,
          },
        });
      }
    }

    const results = await Promise.allSettled(
      jobs.map((job) =>
        fetch('/api/optimize/portfolio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job.budgets),
        }).then(async (res) => {
          const json = (await res.json()) as ServerResponse;
          if (!res.ok) {
            throw new Error(json.error ?? `HTTP ${res.status}`);
          }
          return json;
        }),
      ),
    );

    if (seq !== requestSeqRef.current) return; // a newer toggle invalidated this run

    const next: CellResult[] = results.map((settled, i) => {
      const job = jobs[i];
      if (settled.status === 'rejected') {
        return {
          capitalMult: job.capitalMult,
          cessionMult: job.cessionMult,
          capitalBudget: job.budgets.capital_budget,
          cessionBudget: job.budgets.cession_budget,
          objective: null,
          status: 'Error',
          error:
            settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason),
        };
      }
      const r = settled.value;
      if (r.status === 'Infeasible') {
        return {
          capitalMult: job.capitalMult,
          cessionMult: job.cessionMult,
          capitalBudget: job.budgets.capital_budget,
          cessionBudget: job.budgets.cession_budget,
          objective: null,
          status: 'Infeasible',
        };
      }
      return {
        capitalMult: job.capitalMult,
        cessionMult: job.cessionMult,
        capitalBudget: job.budgets.capital_budget,
        cessionBudget: job.budgets.cession_budget,
        objective: r.objective,
        status: r.status,
        relaxation_factor: r.relaxation_factor,
      };
    });

    setCells(next);
    setLoading(false);
  }, [baseCapital, baseCession, baseNonrenew]);

  useEffect(() => {
    if (open && cells === null && !loading) {
      void runSweep();
    }
    // We intentionally only fire when the panel opens for the first time.
    // Toggling closed and re-opening preserves the previous grid (the
    // server cache makes a refetch essentially free anyway, but we avoid
    // even that round-trip on re-open).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Heatmap saturation: shade by where each cell's objective sits relative
  // to the min/max objective across the grid.
  const objectives = (cells ?? [])
    .map((c) => c.objective)
    .filter((o): o is number => o !== null);
  const minObj = objectives.length ? Math.min(...objectives) : 0;
  const maxObj = objectives.length ? Math.max(...objectives) : 0;
  const span = maxObj - minObj;

  function heatmapStyle(objective: number | null): React.CSSProperties {
    if (objective === null || span === 0) return {};
    const t = (objective - minObj) / span; // 0 → worst, 1 → best
    // Emerald 50 → Emerald 200 — light enough that text stays legible.
    // 240,253,244 → 187,247,208 in 0..1 space.
    const r = Math.round(240 + (187 - 240) * t);
    const g = Math.round(253 + (247 - 253) * t);
    const b = Math.round(244 + (208 - 244) * t);
    return { backgroundColor: `rgb(${r}, ${g}, ${b})` };
  }

  return (
    <section
      data-testid="pareto-panel"
      className="rounded-md bg-white p-5 ring-1 ring-zinc-200/70 shadow-[0_1px_0_rgba(24,24,27,0.03)]"
      aria-labelledby="pareto-heading"
    >
      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.12em] font-medium text-zinc-500 mb-1">
            Efficient frontier · 3×3 grid
          </p>
          <div className="flex items-center gap-2">
            <h2
              id="pareto-heading"
              className="text-[15px] font-semibold text-zinc-900 tracking-[-0.005em]"
            >
              Pareto sweep
            </h2>
            <TrustTierBadge tier="MODEL_OUTPUT" />
          </div>
          <p className="text-[12px] text-zinc-600 mt-1.5 max-w-prose">
            Re-solves the MIP at 9 (capital × cession) budget combinations
            so you can read the shape of the frontier in one glance.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="pareto-grid"
          aria-label={open ? 'Hide Pareto sweep' : 'Show Pareto sweep'}
          className="shrink-0 text-[11.5px] font-medium px-2.5 py-1.5 rounded-md ring-1 ring-zinc-300 text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
        >
          {open ? 'Hide sweep' : 'Run sweep'}
        </button>
      </div>

      {open && loading && (
        <div
          data-testid="pareto-loading"
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-xs text-zinc-600 py-4"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin"
          />
          Solving 9 (capital × cession) cells in parallel…
        </div>
      )}

      {open && cells && (
        <div id="pareto-grid" data-testid="pareto-grid" className="flex flex-col gap-2">
          <p className="text-[11px] text-zinc-600 leading-snug">
            3×3 grid on (capital budget × cession budget), at multipliers{' '}
            <span className="font-medium">0.7× / 1.0× / 1.5×</span> of the
            baseline. Max non-renew % is pinned to the baseline (
            <span className="tabular-nums">
              {(baseNonrenew * 100).toFixed(0)}%
            </span>
            ).
          </p>

          {/* Axis label: cession increases left → right */}
          <div className="flex items-center justify-between text-[10px] text-zinc-500 uppercase tracking-wide px-1">
            <span>← tighter cession</span>
            <span>looser cession →</span>
          </div>

          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
            role="grid"
            aria-label="3x3 Pareto sweep grid"
          >
            {/* Render rows top → bottom as MULTIPLIERS reversed (highest
                capital at the top — visually conventional for "more budget = up"). */}
            {[...MULTIPLIERS].reverse().map((capMult) =>
              MULTIPLIERS.map((cesMult) => {
                const cell = cells.find(
                  (c) => c.capitalMult === capMult && c.cessionMult === cesMult,
                );
                if (!cell) return null;
                const isBaseline =
                  cell.capitalMult === 1.0 && cell.cessionMult === 1.0;
                const isInfeasible = cell.status === 'Infeasible';
                const isRelaxed = cell.status === 'Infeasible_relaxed';
                const isError = cell.status === 'Error';
                return (
                  <div
                    key={`${capMult}_${cesMult}`}
                    data-testid="pareto-cell"
                    data-baseline={isBaseline ? 'true' : 'false'}
                    data-capital-mult={cell.capitalMult}
                    data-cession-mult={cell.cessionMult}
                    role="gridcell"
                    aria-label={`Capital ${formatMultiplier(
                      cell.capitalMult,
                    )}, Cession ${formatMultiplier(cell.cessionMult)}`}
                    className={[
                      'rounded-md px-2.5 py-2 flex flex-col gap-0.5 min-h-[68px] transition-shadow',
                      isBaseline
                        ? 'ring-2 ring-emerald-600 shadow-[0_0_0_3px_rgba(4,120,87,0.08)]'
                        : 'ring-1 ring-zinc-200',
                    ].join(' ')}
                    style={
                      isInfeasible || isError
                        ? { backgroundColor: 'rgb(254, 242, 242)' }
                        : heatmapStyle(cell.objective)
                    }
                    title={
                      isError
                        ? `Solve error: ${cell.error}`
                        : `Capital $${(cell.capitalBudget / 1e6).toFixed(
                            1,
                          )}M · Cession $${(cell.cessionBudget / 1e6).toFixed(
                            2,
                          )}M`
                    }
                  >
                    <div className="flex items-center justify-between text-[10px] text-zinc-600 tabular-nums">
                      <span>
                        cap {formatMultiplier(cell.capitalMult)}
                      </span>
                      <span>
                        ces {formatMultiplier(cell.cessionMult)}
                      </span>
                    </div>
                    <div className="text-sm font-semibold text-zinc-900 tabular-nums">
                      {isInfeasible || isError ? (
                        <span className="text-red-700 text-xs font-medium">
                          {isError ? 'Error' : 'Infeasible'}
                        </span>
                      ) : (
                        <>{formatObjectiveM(cell.objective ?? 0)}</>
                      )}
                    </div>
                    {isBaseline && !isInfeasible && !isError && (
                      <div className="text-[9px] text-emerald-700 uppercase tracking-wide">
                        Baseline
                      </div>
                    )}
                    {isRelaxed && (
                      <div className="text-[9px] text-amber-700 uppercase tracking-wide">
                        Relaxed{' '}
                        {cell.relaxation_factor !== undefined
                          ? `${cell.relaxation_factor}×`
                          : ''}
                      </div>
                    )}
                  </div>
                );
              }),
            )}
          </div>

          <ProvenanceFootnote
            source="9 parallel solves via /api/optimize/portfolio (PuLP / CBC, 3×3 grid on capital × cession budgets, max non-renew pinned to baseline)."
            method="Each cell is a fresh MIP solve at the cell's budget triple. Server-side TTL cache (5 min) deduplicates identical triples."
            confidence={
              objectives.length
                ? `Achieved-objective span across feasible cells: $${(minObj / 1e6).toFixed(
                    1,
                  )}M to $${(maxObj / 1e6).toFixed(1)}M.`
                : 'All 9 cells infeasible or errored.'
            }
          />
        </div>
      )}
    </section>
  );
}
