/**
 * Task P2.17 (Redesign Phase 2) — Treaty stack types.
 *
 * Schema for `artifacts/treaty.json`, the cached payload behind `/treaty`.
 *
 * The treaty stack is a vertical column of reinsurance layers: one optional
 * Quota Share (QS) at the bottom slicing every loss dollar by `share`, and
 * one or more Excess-of-Loss (XS) layers stacked above with attachment /
 * exhaustion / RoL / reinstatements. The artifact is read-only — Phase 2
 * does not couple the view to `optimize_portfolio.solve()`. Treaty fitting
 * (and reinstatement modelling) lands in Phase 3 (P3.22).
 *
 * Keep this file in sync with `scripts/precompute_treaty.py`.
 */

export type QSLayer = {
  type: 'qs';
  /** Fraction ceded to the QS reinsurer, in `[0, 1]`. */
  share: number;
  /** Some QS treaties carry reinstatements; many don't. Optional. */
  reinstatements_remaining?: number;
  /** Rate-on-line for the QS slice, fraction of premium ceded. Optional. */
  rol?: number;
  /** Human-readable description shown in the data table beneath the ladder. */
  description?: string;
};

export type XSLayer = {
  type: 'xs';
  /** Attachment point in dollars — losses below this stay with the carrier. */
  attachment: number;
  /** Exhaustion point in dollars — losses above this pierce the next layer. */
  exhaustion: number;
  /** Reinstatements still available on this layer (integer ≥ 0). */
  reinstatements_remaining: number;
  /** Rate-on-line — premium / layer width, in `[0, 1]`. */
  rol: number;
  /** Human-readable description shown in the data table beneath the ladder. */
  description?: string;
};

export type TreatyLayer = QSLayer | XSLayer;

export interface TreatyStack {
  schema_version: 1;
  /** ISO-8601 timestamp written by the precompute script. */
  generated_at: string;
  /**
   * `live` once we plug in actual placed-treaty terms; `synthetic_demo`
   * until then. Drives the TrustTierBadge on the view.
   */
  data_source: 'live' | 'synthetic_demo';
  /** Book-level 99th-percentile loss in dollars — context for the ladder. */
  book_p99: number;
  /** Layers ordered bottom (lowest attachment) to top. QS first by convention. */
  layers: TreatyLayer[];
}
