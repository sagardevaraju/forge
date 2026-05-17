/**
 * Client-safe types + helpers for Portfolio MIP actions. Imported by both
 * the server-side loader (lib/db/portfolio_optimization.ts) and the client
 * map / drilldown components — so this file must NOT pull node-only APIs.
 *
 * Task P2.8 (Phase 2): the action set expanded from six to eleven. The two
 * pre-Phase-2 reprice scalars (`reprice_up`, `reprice_down`) are gone;
 * in their place is a discretized rate grid of seven binary buckets
 * (`reprice_n20, reprice_n10, reprice_0, reprice_p5, reprice_p10,
 * reprice_p15, reprice_p20`) priced with a per-cohort retention-
 * elasticity correction. See `api_py/optimize_portfolio.py::RATE_GRID`.
 * UI consumers (PortfolioMap, PortfolioDrillDown, narrative, reconciler,
 * economics) will be updated in a follow-up to render the new rate-grid
 * shape; this file is the type-level swap.
 */

/**
 * Δrate associated with each `reprice_*` action — mirrors
 * `api_py/optimize_portfolio.py::RATE_GRID`. Used by downstream renderers
 * to convert action keys like `reprice_p10` into "+10%" labels.
 */
export const RATE_GRID = {
  reprice_n20: -0.20,
  reprice_n10: -0.10,
  reprice_0: 0.0,
  reprice_p5: 0.05,
  reprice_p10: 0.10,
  reprice_p15: 0.15,
  reprice_p20: 0.20,
} as const;

export type RepriceActionName = keyof typeof RATE_GRID;

export type ActionName =
  | 'retain'
  | RepriceActionName
  | 'non_renew'
  | 'cede_qs'
  | 'cede_xs';

export type OptimizedAction = {
  cohort_id: string;
  dominant_action: ActionName;
  dominant_share: number;
} & {
  [K in ActionName]: number;
};

export interface OptimizedCohort {
  id: string;
  zip3: string;
  build_type: string;
  tiv_quintile: number;
  policy_count: number;
  total_tiv: number;
  total_premium: number;
  modal_flood_zone: string;
  avg_elevation_m: number;
  loss_p50: number;
  loss_p99: number;
  // Task P2.0 (schema_version 3): K=1000 lognormal draws on the server-side
  // artifact only. `app/portfolio/page.tsx` strips this before passing the
  // cohort down to client components, so it should never be observed in
  // browser code.
  loss_scenarios?: number[];
}

export interface PortfolioOptimization {
  schema_version?: number;
  status: string;
  /** P2.8: solver_mode is 'milp' or 'lp_relaxed_rounded'. */
  solver_mode?: string;
  objective: number;
  /**
   * Task 24 — treaty-year horizon (ISO ``YYYY-MM-DD``). Defaults to the
   * industry cat treaty cycle (Jul 1 → Jun 30). Optional so older cached
   * artifacts without the field still parse.
   */
  horizon_start?: string;
  horizon_end?: string;
  budgets: {
    capital_budget: number;
    max_nonrenew_pct: number;
    cession_budget: number;
  };
  book_totals: {
    tiv: number;
    premium: number;
    loss_p50: number;
    loss_p99: number;
  };
  action_summary: Record<ActionName, { count: number; tiv: number }>;
  cohorts: OptimizedCohort[];
  actions: OptimizedAction[];
}

/**
 * The canonical action ordering used everywhere a stable iteration order
 * matters (action_summary rendering, indexByZip3 bucket build, chart
 * legend, etc). Mirrors `api_py/optimize_portfolio.py::ACTIONS`.
 */
export const ACTIONS: ActionName[] = [
  'retain',
  'reprice_n20',
  'reprice_n10',
  'reprice_0',
  'reprice_p5',
  'reprice_p10',
  'reprice_p15',
  'reprice_p20',
  'non_renew',
  'cede_qs',
  'cede_xs',
];

export function indexByZip3(
  opt: PortfolioOptimization,
): Record<string, { dominantActionByTiv: ActionName; tiv: number; cohorts: number }> {
  const cohortById = new Map(opt.cohorts.map((c) => [c.id, c]));
  const accum: Record<
    string,
    Record<ActionName, number> & { __tiv: number; __cohorts: number }
  > = {};
  const blankActionBucket = (): Record<ActionName, number> =>
    ACTIONS.reduce(
      (acc, a) => {
        acc[a] = 0;
        return acc;
      },
      {} as Record<ActionName, number>,
    );
  for (const a of opt.actions) {
    const cohort = cohortById.get(a.cohort_id);
    if (!cohort) continue;
    const zip3 = cohort.zip3;
    if (!accum[zip3]) {
      accum[zip3] = {
        ...blankActionBucket(),
        __tiv: 0,
        __cohorts: 0,
      };
    }
    const bucket = accum[zip3];
    bucket.__tiv += cohort.total_tiv;
    bucket.__cohorts += 1;
    for (const action of ACTIONS) {
      bucket[action] += cohort.total_tiv * (a[action] ?? 0);
    }
  }
  const out: Record<string, { dominantActionByTiv: ActionName; tiv: number; cohorts: number }> = {};
  for (const [zip3, b] of Object.entries(accum)) {
    let best: ActionName = 'retain';
    let bestVal = -Infinity;
    for (const a of ACTIONS) {
      if (b[a] > bestVal) {
        bestVal = b[a];
        best = a;
      }
    }
    out[zip3] = { dominantActionByTiv: best, tiv: b.__tiv, cohorts: b.__cohorts };
  }
  return out;
}

/**
 * Render a Δrate (number, e.g. 0.10) as a signed percent string ("+10%").
 * Used by ACTION_LABELS to derive human-readable rate-grid labels.
 */
function formatRateLabel(delta: number): string {
  if (delta === 0) return '±0%';
  const pct = Math.round(delta * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

export const ACTION_LABELS: Record<ActionName, string> = {
  retain: 'Retain',
  reprice_n20: `Reprice ${formatRateLabel(RATE_GRID.reprice_n20)}`,
  reprice_n10: `Reprice ${formatRateLabel(RATE_GRID.reprice_n10)}`,
  reprice_0: `Reprice ${formatRateLabel(RATE_GRID.reprice_0)}`,
  reprice_p5: `Reprice ${formatRateLabel(RATE_GRID.reprice_p5)}`,
  reprice_p10: `Reprice ${formatRateLabel(RATE_GRID.reprice_p10)}`,
  reprice_p15: `Reprice ${formatRateLabel(RATE_GRID.reprice_p15)}`,
  reprice_p20: `Reprice ${formatRateLabel(RATE_GRID.reprice_p20)}`,
  non_renew: 'Non-renew',
  cede_qs: 'Cede (quota share)',
  cede_xs: 'Cede (excess of loss)',
};

/**
 * Colors for the rate-grid use a diverging amber→blue scale matching
 * the underlying Δrate sign: negative Δrate (rate cuts) read as blue,
 * 0 as neutral grey, positive Δrate (rate hikes) deepen through amber
 * toward dark orange. Non-reprice actions keep the Phase-1 palette.
 */
export const ACTION_COLORS: Record<ActionName, string> = {
  retain: '#16a34a',
  reprice_n20: '#1d4ed8',
  reprice_n10: '#3b82f6',
  reprice_0: '#9ca3af',
  reprice_p5: '#fbbf24',
  reprice_p10: '#f59e0b',
  reprice_p15: '#d97706',
  reprice_p20: '#b45309',
  non_renew: '#dc2626',
  cede_qs: '#9333ea',
  cede_xs: '#0d9488',
};
