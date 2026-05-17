/**
 * Task 17 — Action economics mirror.
 *
 * TS-side mirror of the six-action economic constants owned by
 * `api_py/optimize_portfolio.py` (REPRICE_FACTOR / LOSS_FACTOR /
 * CESSION_COST_RATE, lines 34-57). The drill-down UI uses this table to
 * surface hover-to-source attribution on the magic numbers driving each
 * recommendation — readers can see *why* the optimizer chose a given action
 * and which line of which file owns the constant.
 *
 * When you tune the Python coefficients, update this file in the same
 * commit. The numbers are load-bearing; the `note` is a Phase-2 pointer to
 * the planned replacement (price-elasticity model, RoL-based treaty
 * pricing, real per-scenario retained tail).
 */
import type { ActionName } from './../portfolio-actions';

export interface EconomicsRow {
  reprice: number;
  loss: number;
  cession: number;
  source: string;
  note: string;
}

export const ECONOMICS_TABLE: Record<ActionName, EconomicsRow> = {
  retain:       { reprice: 1.00, loss: 1.0, cession: 0.00, source: 'api_py/optimize_portfolio.py:34', note: 'no change to economics' },
  reprice_up:   { reprice: 1.15, loss: 1.0, cession: 0.00, source: 'api_py/optimize_portfolio.py:34', note: 'magic constant — Phase 2 swaps to price-elasticity model (P2.8)' },
  reprice_down: { reprice: 0.90, loss: 1.0, cession: 0.00, source: 'api_py/optimize_portfolio.py:34', note: 'magic constant — Phase 2 swaps to price-elasticity model (P2.8)' },
  non_renew:    { reprice: 0.00, loss: 0.0, cession: 0.00, source: 'api_py/optimize_portfolio.py:34', note: 'policy not renewed; subject to state notice periods' },
  cede_qs:      { reprice: 0.50, loss: 0.5, cession: 0.60, source: 'api_py/optimize_portfolio.py:34', note: 'magic constant — Phase 2 swaps to RoL/attachment-based treaty pricing (P2.7)' },
  cede_xs:      { reprice: 1.00, loss: 0.3, cession: 0.15, source: 'api_py/optimize_portfolio.py:34', note: 'magic constant — Phase 2 computes real per-scenario retained tail (P2.7)' },
};
