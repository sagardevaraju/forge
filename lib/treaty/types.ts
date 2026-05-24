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

/**
 * Task P3.19 — Fronting vehicle.
 *
 * A fronting layer represents an arrangement where a licensed-paper
 * carrier (the "fronter") issues policies in jurisdictions where the
 * actual risk-bearer can't write (admitted-only states, non-US
 * domiciles, regulated lines). The fronter cedes the risk back to the
 * underlying capital provider (typically a captive, sidecar, or ILS
 * investor) for a fronting fee, and may retain a small residual slice
 * for regulatory and tail-of-the-tail purposes.
 *
 * Math (per-dollar of inbound premium / loss):
 *
 *   ceded_to_capital   = (1 - residual_retention_share) · L
 *   retained_by_fronter = residual_retention_share · L
 *   fronting_fee_paid   = fronting_fee_share · P
 *
 * The fronting fee is a *premium* slice (not a loss slice) — it
 * compensates the fronter for rented paper, separate from the residual
 * loss retention. Total fronter compensation = fronting_fee_share · P.
 *
 * `capital_provider` tags the kind of vehicle absorbing the cession so
 * downstream views can color / group fronting layers by provider type
 * (captive vs sidecar vs ILS).
 */
export type FrontingLayer = {
  type: 'fronting';
  /**
   * Fraction of inbound loss the fronter retains for its own account.
   * Typical values: 0.05-0.10 (95-90% pure passthrough). 0 = pure
   * conduit (regulator-allowed in some jurisdictions); 1 = no
   * fronting at all (degenerate).
   */
  residual_retention_share: number;
  /**
   * Fraction of inbound *premium* paid to the fronter as a fronting
   * fee. Typical values: 0.03-0.08. Distinct from the loss
   * retention — even at 0% loss retention the fronter charges this
   * fee for rented paper.
   */
  fronting_fee_share: number;
  /**
   * Tag for the underlying capital provider absorbing the cession.
   * Used by the TreatyLadder to color the band and group rows in the
   * data table.
   */
  capital_provider: 'captive' | 'sidecar' | 'ils' | 'other';
  /** Human-readable description shown in the data table beneath the ladder. */
  description?: string;
};

export type TreatyLayer = QSLayer | XSLayer | FrontingLayer;

export interface TreatyStack {
  /**
   * Schema version. Bumped to 2 in P3.19 to mark the addition of the
   * `FrontingLayer` variant. Pre-P3.19 readers (`schema_version === 1`)
   * are forward-compatible — they'll simply ignore any `type: 'fronting'`
   * layer entries because their union doesn't include the variant.
   */
  schema_version: 1 | 2;
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
