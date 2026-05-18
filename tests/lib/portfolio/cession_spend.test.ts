/**
 * computeProjectedCessionSpend sums the cession premium across the cohort ×
 * action matrix using the same CESSION_COST_RATE coefficients the Python
 * solver applies. Without this helper the home tile + the portfolio header
 * silently rendered $0 even when the MIP had recommended cede_qs / cede_xs
 * for most of the book.
 */
import { describe, test, expect } from 'vitest';
import {
  ACTIONS,
  CESSION_COST_RATE,
  computeProjectedCessionSpend,
  type PortfolioOptimization,
  type ActionName,
  type OptimizedAction,
} from '@/lib/portfolio-actions';

function makeAction(cohort_id: string, fractions: Partial<Record<ActionName, number>>): OptimizedAction {
  const base = ACTIONS.reduce(
    (acc, a) => {
      acc[a] = 0;
      return acc;
    },
    {} as Record<ActionName, number>,
  );
  const merged = { ...base, ...fractions };
  // Pick the largest action as dominant for the cohort.
  let dominant: ActionName = 'retain';
  let bestShare = -Infinity;
  for (const a of ACTIONS) {
    if (merged[a] > bestShare) {
      bestShare = merged[a];
      dominant = a;
    }
  }
  return {
    cohort_id,
    dominant_action: dominant,
    dominant_share: bestShare,
    ...merged,
  };
}

function makeOpt(actions: OptimizedAction[]): PortfolioOptimization {
  return {
    status: 'Optimal',
    objective: 0,
    budgets: { capital_budget: 0, max_nonrenew_pct: 0, cession_budget: 0 },
    book_totals: { tiv: 0, premium: 0, loss_p50: 0, loss_p99: 0 },
    action_summary: ACTIONS.reduce(
      (acc, a) => {
        acc[a] = { count: 0, tiv: 0 };
        return acc;
      },
      {} as Record<ActionName, { count: number; tiv: number }>,
    ),
    cohorts: actions.map((a) => ({
      id: a.cohort_id,
      zip3: '337',
      build_type: 'masonry',
      tiv_quintile: 0,
      policy_count: 0,
      total_tiv: 0,
      total_premium: 0,
      modal_flood_zone: 'X',
      avg_elevation_m: 0,
      loss_p50: 1_000_000,
      loss_p99: 2_000_000,
    })),
    actions,
  };
}

describe('computeProjectedCessionSpend', () => {
  test('returns 0 when no cohort is ceded', () => {
    const opt = makeOpt([makeAction('a', { retain: 1 })]);
    expect(computeProjectedCessionSpend(opt)).toBe(0);
  });

  test('sums cede_qs at 0.6 × loss_p50 × share', () => {
    // Two cohorts, both 100% cede_qs. loss_p50 is 1_000_000 each.
    const opt = makeOpt([
      makeAction('a', { cede_qs: 1 }),
      makeAction('b', { cede_qs: 1 }),
    ]);
    // 2 × 1_000_000 × 0.6 = 1_200_000
    expect(computeProjectedCessionSpend(opt)).toBe(1_200_000);
  });

  test('cede_xs costs 0.15 × loss_p50 × share', () => {
    const opt = makeOpt([makeAction('a', { cede_xs: 1 })]);
    expect(computeProjectedCessionSpend(opt)).toBe(150_000);
  });

  test('fractional shares blend proportionally', () => {
    const opt = makeOpt([makeAction('a', { cede_qs: 0.5, cede_xs: 0.5 })]);
    // 1_000_000 × (0.6 × 0.5 + 0.15 × 0.5) = 1_000_000 × 0.375 = 375_000
    expect(computeProjectedCessionSpend(opt)).toBe(375_000);
  });

  test('non-cede actions contribute zero to the sum', () => {
    // Every reprice / retain / non-renew action has rate 0; only cede_* burn.
    for (const a of ACTIONS) {
      if (a === 'cede_qs' || a === 'cede_xs') continue;
      expect(CESSION_COST_RATE[a]).toBe(0);
    }
  });
});
