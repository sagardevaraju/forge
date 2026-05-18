/**
 * Task P2.28 — Expected adjuster-load rollup helper.
 *
 * The pre-brief on `/claims` surfaces a per-ZIP3 adjuster-load rollup so the
 * cat-ops VP can see, at a glance, how many adjusters the Operational LP
 * expects to need against a baseline staffing assumption.
 *
 * This module is a **derivation helper** — it takes the pre-flagged policy
 * set (each row already carries its cohort's `loss_p50`-derived
 * `expected_loss`) and rolls it up per ZIP3. Until the real Operational LP
 * (VRP) artifact lands with a `demand_adjustments` field keyed by ZIP3, we
 * compute the per-ZIP3 demand from the cohort prior on-the-fly and tag the
 * UI surface as `MODEL_OUTPUT`.
 *
 * Formula (documented on the page + in the ProvenanceFootnote):
 *
 *   needed[zip3]   = ceil( Σ expected_loss[policy] / DOLLARS_PER_ADJUSTER )
 *   baseline[zip3] = ADJUSTER_LOAD_BASELINE_PER_ZIP3
 *   delta[zip3]    = needed[zip3] - baseline[zip3]
 *
 * The two constants are tunables — they are exported so tests can pin them
 * and consumers (e.g. the rollup component) can render them in a footnote
 * for transparency.
 *
 * Trust tier: MODEL_OUTPUT — the loss numbers driving this come from the
 * Portfolio MIP cohort prior. The staffing baseline is a documented
 * heuristic until a real staffing feed lands; we keep the badge MODEL_OUTPUT
 * (rather than SYNTHETIC_SCAFFOLD) because the *load* signal it derives is
 * model-grounded; the *baseline* is the synthetic side and the page
 * footnote calls that out.
 */

import type { PreflagPolicy } from '@/components/ClaimsTable';

/**
 * Dollars of expected loss one adjuster is assumed to process during a
 * pre-brief horizon. Tuned from industry norms (an adjuster typically
 * handles ~$200K–$300K of property losses per week of catastrophe
 * deployment); we pick the midpoint as a defensible Phase 2 constant.
 *
 * Exposed so tests can assert against the boundary deterministically.
 */
export const ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER = 250_000;

/**
 * Per-ZIP3 baseline staffing assumption used when no real Operational LP
 * artifact is loaded. Two adjusters per ZIP3 covers the carrier's
 * default-on-call rotation; the delta column shows how far the expected
 * load drifts from that baseline.
 *
 * Exposed for the same reason as the dollar threshold above.
 */
export const ADJUSTER_LOAD_BASELINE_PER_ZIP3 = 2;

export interface AdjusterLoadRow {
  zip3: string;
  /** Number of pre-flagged policies that contributed to this row. */
  policy_count: number;
  /** Sum of per-policy `expected_loss` values for this ZIP3 (USD). */
  total_expected_loss: number;
  /** ceil(total_expected_loss / DOLLARS_PER_ADJUSTER). */
  needed: number;
  /** ADJUSTER_LOAD_BASELINE_PER_ZIP3. */
  baseline: number;
  /** needed - baseline. May be positive (short-staffed) or negative (surplus). */
  delta: number;
}

export interface AdjusterLoadRollup {
  rows: AdjusterLoadRow[];
  /** Σ rows.needed — total adjusters the load implies. */
  total_needed: number;
  /** Σ rows.delta — total deviation from baseline across affected ZIP3s. */
  total_delta: number;
}

/**
 * Roll a pre-flag policy list up to a per-ZIP3 adjuster-load delta.
 *
 * Policies whose `expected_loss` is `null` (no matching cohort in the MIP
 * artifact) are skipped — they cannot contribute a derived demand. ZIP3s
 * with zero qualifying policies do not appear in the rollup.
 *
 * Rows are returned sorted by `delta` descending (most short-staffed
 * first), with `policy_count` as the tie-breaker — that's the order the
 * pre-brief reader wants to scan top-down.
 */
export function computeAdjusterLoad(
  policies: ReadonlyArray<PreflagPolicy>,
): AdjusterLoadRollup {
  const byZip3 = new Map<
    string,
    { policy_count: number; total_expected_loss: number }
  >();
  for (const p of policies) {
    if (p.expected_loss == null) continue;
    const entry = byZip3.get(p.zip3) ?? {
      policy_count: 0,
      total_expected_loss: 0,
    };
    entry.policy_count += 1;
    entry.total_expected_loss += p.expected_loss;
    byZip3.set(p.zip3, entry);
  }

  const rows: AdjusterLoadRow[] = [];
  for (const [zip3, agg] of byZip3.entries()) {
    const needed = Math.ceil(
      agg.total_expected_loss / ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER,
    );
    const baseline = ADJUSTER_LOAD_BASELINE_PER_ZIP3;
    rows.push({
      zip3,
      policy_count: agg.policy_count,
      total_expected_loss: agg.total_expected_loss,
      needed,
      baseline,
      delta: needed - baseline,
    });
  }
  rows.sort((a, b) => {
    if (b.delta !== a.delta) return b.delta - a.delta;
    return b.policy_count - a.policy_count;
  });

  const total_needed = rows.reduce((s, r) => s + r.needed, 0);
  const total_delta = rows.reduce((s, r) => s + r.delta, 0);
  return { rows, total_needed, total_delta };
}
