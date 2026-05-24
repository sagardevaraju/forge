/**
 * Task 17 — Action economics mirror.
 *
 * TS-side mirror of the economic constants owned by
 * `api_py/optimize_portfolio.py` (REPRICE_FACTOR / LOSS_FACTOR /
 * CESSION_COST_RATE). The drill-down UI uses this table to surface
 * hover-to-source attribution on the magic numbers driving each
 * recommendation — readers can see *why* the optimizer chose a given action
 * and which line of which file owns the constant.
 *
 * P2.8 update: the two scalar reprice actions (`reprice_up`/`reprice_down`)
 * were replaced by a 7-bucket rate grid priced with a retention-elasticity
 * correction. The reprice multiplier for each bucket is computed from
 * `RATE_GRID` via the same formula the Python solver uses:
 *
 *     premium_factor(Δrate, η) = (1 + Δrate) × (1 − η × max(Δrate, 0))
 *
 * with η = DEFAULT_ELASTICITY (0.5). Loss factor is 1.0 for every
 * `reprice_*` bucket — repricing changes premium, not peril (P2.8 contract).
 *
 * When you tune the Python coefficients, update this file in the same
 * commit. The numbers are load-bearing; the `note` is a Phase-2 pointer to
 * the planned replacement.
 */
import { type ActionName, RATE_GRID, type RepriceActionName } from './../portfolio-actions';

export interface EconomicsRow {
  reprice: number;
  loss: number;
  cession: number;
  source: string;
  note: string;
}

/** Mirrors `api_py/optimize_portfolio.py::DEFAULT_ELASTICITY`. */
const DEFAULT_ELASTICITY = 0.5;

/**
 * Effective-premium multiplier under a Δrate move with elasticity η.
 * Mirrors `_reprice_factor()` in `api_py/optimize_portfolio.py`.
 */
function repriceFactor(action: RepriceActionName, eta: number = DEFAULT_ELASTICITY): number {
  const delta = RATE_GRID[action];
  return (1 + delta) * (1 - eta * Math.max(delta, 0));
}

const REPRICE_SOURCE = 'api_py/optimize_portfolio.py:103';
const REPRICE_NOTE =
  'price-elasticity multiplier (1+Δrate)·(1−η·max(Δrate,0)); η=0.5 default (P2.8)';

const repriceRow = (a: RepriceActionName): EconomicsRow => ({
  reprice: repriceFactor(a),
  loss: 1.0,
  cession: 0.0,
  source: REPRICE_SOURCE,
  note: REPRICE_NOTE,
});

export const ECONOMICS_TABLE: Record<ActionName, EconomicsRow> = {
  retain:       { reprice: 1.00, loss: 1.0, cession: 0.00, source: 'api_py/optimize_portfolio.py:34', note: 'no change to economics' },
  reprice_n20:  repriceRow('reprice_n20'),
  reprice_n10:  repriceRow('reprice_n10'),
  reprice_0:    repriceRow('reprice_0'),
  reprice_p5:   repriceRow('reprice_p5'),
  reprice_p10:  repriceRow('reprice_p10'),
  reprice_p15:  repriceRow('reprice_p15'),
  reprice_p20:  repriceRow('reprice_p20'),
  non_renew:    { reprice: 0.00, loss: 0.0, cession: 0.00, source: 'api_py/optimize_portfolio.py:34', note: 'policy not renewed; subject to state notice periods' },
  cede_qs:      { reprice: 0.50, loss: 0.5, cession: 0.65, source: 'api_py/optimize_portfolio.py:128', note: 'QS cost = 1 − ceding_commission; US homeowner norms 30–35% per Aon RMD Jan 2026 → 0.65; see research.md §10a' },
  cede_xs:      { reprice: 1.00, loss: 0.3, cession: 0.12, source: 'api_py/optimize_portfolio.py:128', note: 'XS cost ≈ working-layer RoL; Guy Carpenter US Property Cat RoL Index at 1/1 2026; see research.md §10b' },
};
