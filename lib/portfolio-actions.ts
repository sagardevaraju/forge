/**
 * Client-safe types + helpers for Portfolio MIP actions. Imported by both
 * the server-side loader (lib/db/portfolio_optimization.ts) and the client
 * map / drilldown components — so this file must NOT pull node-only APIs.
 */
export type ActionName =
  | 'retain'
  | 'reprice_up'
  | 'reprice_down'
  | 'non_renew'
  | 'cede_qs'
  | 'cede_xs';

export interface OptimizedAction {
  cohort_id: string;
  retain: number;
  reprice_up: number;
  reprice_down: number;
  non_renew: number;
  cede_qs: number;
  cede_xs: number;
  dominant_action: ActionName;
  dominant_share: number;
}

export interface OptimizedCohort {
  id: string;
  zip3: string;
  build_type: string;
  tiv_decile: number;
  policy_count: number;
  total_tiv: number;
  total_premium: number;
  modal_flood_zone: string;
  avg_elevation_m: number;
  loss_p50: number;
  loss_p99: number;
}

export interface PortfolioOptimization {
  status: string;
  objective: number;
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

const ACTIONS: ActionName[] = [
  'retain',
  'reprice_up',
  'reprice_down',
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
  for (const a of opt.actions) {
    const cohort = cohortById.get(a.cohort_id);
    if (!cohort) continue;
    const zip3 = cohort.zip3;
    if (!accum[zip3]) {
      accum[zip3] = {
        retain: 0,
        reprice_up: 0,
        reprice_down: 0,
        non_renew: 0,
        cede_qs: 0,
        cede_xs: 0,
        __tiv: 0,
        __cohorts: 0,
      };
    }
    const bucket = accum[zip3];
    bucket.__tiv += cohort.total_tiv;
    bucket.__cohorts += 1;
    for (const action of ACTIONS) {
      bucket[action] += cohort.total_tiv * a[action];
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

export const ACTION_LABELS: Record<ActionName, string> = {
  retain: 'Retain',
  reprice_up: 'Reprice up',
  reprice_down: 'Reprice down',
  non_renew: 'Non-renew',
  cede_qs: 'Cede (quota share)',
  cede_xs: 'Cede (excess of loss)',
};

export const ACTION_COLORS: Record<ActionName, string> = {
  retain: '#16a34a',
  reprice_up: '#d97706',
  reprice_down: '#2563eb',
  non_renew: '#dc2626',
  cede_qs: '#9333ea',
  cede_xs: '#0d9488',
};
