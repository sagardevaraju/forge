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
  /**
   * Task P3.22 — per-occurrence remaining capacity. Surfaces in
   * /treaty as a MIP input (NOT a constraint per plan: the operator
   * sees how much layer width is consumed so they can size the next
   * decision against it, but the precompute MIP does not enforce
   * remaining_capacity_usd as an upper bound on cession).
   *
   * - `initial_capacity_usd` is the layer width at issuance, including
   *   reinstatements. For an XS layer with width `(exhaustion -
   *   attachment)` and N reinstatements: `(N + 1) * width`.
   * - `remaining_capacity_usd` is the amount still available after
   *   losses to date.
   *
   * Both default to undefined for legacy artifacts so pre-P3.22
   * readers continue to render. New artifacts (schema_version ≥ 5)
   * always carry them.
   */
  initial_capacity_usd?: number;
  remaining_capacity_usd?: number;
  /**
   * Task P3.22 — reinstatement premium factor. Multiplier on the
   * pro-rata fraction of the original premium that the cedant pays
   * to refresh the layer after a loss. 1.0 = "100% at 100%" (the
   * standard cat-XS convention — exhausting the layer costs the full
   * original premium again); 0.5 = "100% at 50%" (discounted
   * reinstatement); 0.0 = free reinstatement (rare). Defaults to 1.0
   * when unspecified.
   */
  reinstatement_premium_factor?: number;
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

/**
 * Task P3.20 — Captive vehicle (trapped vs free capital).
 *
 * A captive is an insurance subsidiary the parent owns and uses to
 * absorb risk that the open market would price unfavorably, or that the
 * parent wants to retain economically. Captives are typically the
 * underlying capital provider behind a fronting arrangement
 * (FrontingLayer.capital_provider === 'captive').
 *
 * The central state variable is **trapped vs free capital**:
 *
 *   - **Trapped** capital is locked inside the captive to back
 *     outstanding loss reserves, ceded-collateral letters of credit /
 *     trust accounts pledged to fronting carriers, and unearned
 *     premium reserves. It cannot be released as a dividend to the
 *     parent until the underlying obligation runs off.
 *   - **Free** capital is the captive's surplus above trapped capital.
 *     This is what can be dividended out, redeployed into a sidecar /
 *     ILS investment, or used to absorb a new underwriting line.
 *
 *   free_capital = total_capital
 *                  - outstanding_reserves
 *                  - collateral_pledged
 *                  - unearned_premium_reserve
 *
 *   trapped_capital = total_capital - free_capital
 *   trapped_share   = trapped_capital / total_capital
 *
 * The TreatyLadder renders this as a side-panel beneath the fronting
 * band rather than as another vertical layer, because the captive's
 * capital position is not in the cession waterfall — it's the
 * destination of the cession.
 *
 * Units are USD throughout. Negative values are clipped at write time.
 */
export type CaptiveLayer = {
  type: 'captive';
  /** Total capital sitting in the captive, in USD. */
  total_capital_usd: number;
  /**
   * Sum of outstanding incurred-but-unpaid loss reserves backing
   * recognised liabilities. Trapped until claims close.
   */
  outstanding_reserves_usd: number;
  /**
   * Cash / letters of credit / trust assets pledged to fronting
   * carriers as collateral. Trapped until the fronting carrier
   * releases it (typically annually after a loss-run review).
   */
  collateral_pledged_usd: number;
  /**
   * Unearned premium reserve — premium written but not yet earned.
   * Trapped on a pro-rata basis as the policy period elapses.
   */
  unearned_premium_reserve_usd: number;
  /** Human-readable description shown in the data table beneath the ladder. */
  description?: string;
};

/**
 * Task P3.21 — ILS (Insurance-Linked Securities) / cat-bond layer.
 *
 * A cat-bond is a capital-markets instrument: investors buy bonds with
 * a coupon; if a covered cat event occurs, the bond principal is
 * reduced to pay the sponsor's covered loss. From the sponsor's
 * perspective the layer behaves like XS reinsurance — the difference
 * is the counterparty (capital-markets investors via an SPV / Special
 * Purpose Insurer instead of a traditional reinsurer) and the trigger
 * mechanism that determines how much principal is reduced.
 *
 * Trigger types:
 *
 *   - **indemnity** (v1 default — plan-locked): principal is reduced by
 *     the sponsor's actual incurred loss inside the layer
 *     [attachment, exhaustion]. Mathematically identical to an XS
 *     treaty; the difference is the counterparty + the existence of
 *     basis risk = 0 for the sponsor. Adds modelling complexity for
 *     investors who need to vet sponsor loss data.
 *   - **industry_loss** (v2): principal reduced based on PCS / Swiss
 *     Re sigma reported industry losses. Carries basis risk for the
 *     sponsor (the bond may not pay even if the sponsor takes loss).
 *   - **parametric** (v2): triggered by event parameters (e.g. EQ Mw
 *     ≥ 7.0 within a defined zone). Lowest basis risk for investors;
 *     highest basis risk for sponsor.
 *   - **modeled_loss** (v2): vendor-modeled loss using event data.
 *
 * v1 only supports `trigger = 'indemnity'`; the type is open for
 * forward-compatibility with v2 triggers without a schema bump.
 *
 * The cat-bond layer behaves like XS for loss math (see
 * `api_py/treaty.retained_ils`). Additional fields capture the
 * capital-markets economics: coupon rate (interest paid to investors),
 * term in years (typical 3-5), reset frequency.
 */
export type ILSLayer = {
  type: 'ils';
  /** Attachment point in dollars — losses below stay with the sponsor. */
  attachment: number;
  /** Exhaustion point in dollars — losses above pierce the layer. */
  exhaustion: number;
  /**
   * Trigger mechanism. v1 only supports `'indemnity'`; v2 (out of P3.21
   * scope) will add industry_loss / parametric / modeled_loss. The
   * union is open so v2 additions don't require a schema bump.
   */
  trigger: 'indemnity' | 'industry_loss' | 'parametric' | 'modeled_loss';
  /**
   * Coupon rate paid to investors as fraction of principal per annum
   * (e.g. 0.07 = 700 bps). The total coupon load on the sponsor is
   * `coupon_rate * principal` per year; this is the cat-bond analogue
   * of the XS RoL.
   */
  coupon_rate: number;
  /** Term to maturity in years (typical 3-5). */
  term_years: number;
  /**
   * Reset frequency in years. 0 = no reset (collateralised at issuance
   * for full term); 1 = annual reset of the trigger parameters.
   */
  reset_years: number;
  /**
   * Human-readable description shown in the data table beneath the
   * ladder.
   */
  description?: string;
};

export type TreatyLayer = QSLayer | XSLayer | FrontingLayer | CaptiveLayer | ILSLayer;

export interface TreatyStack {
  /**
   * Schema version. Bumped to 2 in P3.19 (FrontingLayer), 3 in P3.20
   * (CaptiveLayer), 4 in P3.21 (ILSLayer), and 5 in P3.22 (per-occurrence
   * remaining-capacity fields on XSLayer). Older readers are
   * forward-compatible — additive fields default to undefined and
   * unknown layer types are simply ignored by older typed unions.
   */
  schema_version: 1 | 2 | 3 | 4 | 5;
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
