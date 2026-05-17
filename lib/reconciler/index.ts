/**
 * Task 18 — Decision Reconciler.
 *
 * After the Portfolio MIP (Task 16) and the Operational VRP (Task 17) each
 * solve their own slice, several pair-wise inconsistencies can leak through:
 *
 *  1. A cohort the MIP voted to **non-renew** is no longer the carrier's
 *     policies — its individual policies should not appear on the claims
 *     pre-flag list.
 *
 *  2. A cohort that is **ceded** (quota-share or excess-of-loss) means the
 *     reinsurer is on the hook for some share of losses; the carrier's own
 *     adjuster staging shouldn't size demand against the *gross* claim
 *     volume in those zones — it should net the ceded share out.
 *
 *  3. A cohort flagged for heavy **non-renewal** that nonetheless sits inside
 *     a zone where the VRP has stationed several adjusters is a *conflict*
 *     worth surfacing to a human reviewer — either the cohort shouldn't be
 *     non-renewed (claims are coming and we need our adjusters) or the
 *     adjuster staging should be re-thought.
 *
 * The reconciler is intentionally pure: same input → same output, no I/O,
 * no DB access. Inputs come in as plain objects; outputs are a new
 * `ReconcileOutput` (the original inputs are not mutated).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PortfolioAction {
  cohort_id: string;
  retain: number;
  /**
   * P2.8 rate-grid reprice buckets (mirrors
   * `api_py/optimize_portfolio.py::RATE_GRID`). The two pre-Phase-2
   * scalars `reprice_up`/`reprice_down` were replaced by a 7-bucket
   * discretized grid.
   */
  reprice_n20: number;
  reprice_n10: number;
  reprice_0: number;
  reprice_p5: number;
  reprice_p10: number;
  reprice_p15: number;
  reprice_p20: number;
  non_renew: number;
  cede_qs: number;
  cede_xs: number;
}

export interface PreflaggedPolicy {
  policy_id: number;
  cohort_id: string;
  severity: 'low' | 'medium' | 'high';
  expected_loss: number;
}

export interface VRPAssignment {
  adjuster_id: number;
  zone_id: number;
  day: number;
  drive_hours: number;
}

export interface ReconcileInput {
  portfolio: { actions: PortfolioAction[] };
  preflagged: PreflaggedPolicy[];
  vrp: { assignments: VRPAssignment[] };
  /** cohort_id → zip3 prefix (e.g. "330"). Used to map a cohort to a zone. */
  cohort_zip3_map?: Record<string, string>;
  /** zone_id → zip3 prefix. */
  zone_zip3_map?: Record<number, string>;
}

export interface ReconcileConflict {
  kind: 'high_nonrenew_with_adjusters';
  cohort_id: string;
  zone_id: number;
  details: string;
}

export interface ReconcileOutput {
  /** Pass-through: portfolio decisions are not mutated. */
  portfolio: { actions: PortfolioAction[] };
  /** Pre-flag list with non-renewed cohorts dropped. */
  preflagged: PreflaggedPolicy[];
  /** VRP assignments untouched, plus per-zone demand multiplier (<=1). */
  vrp: { assignments: VRPAssignment[]; demand_adjustments: Record<number, number> };
  /** Cross-lever conflicts surfaced for the manager. */
  conflicts: ReconcileConflict[];
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A cohort is treated as "non-renewed" if non_renew exceeds this threshold. */
const NON_RENEW_THRESHOLD = 0.5;

/** A zone counts as "heavily staffed" if it has at least this many adjuster-days. */
const HIGH_ADJUSTER_DAYS = 2;

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export function reconcile(input: ReconcileInput): ReconcileOutput {
  const {
    portfolio,
    preflagged,
    vrp,
    cohort_zip3_map = {},
    zone_zip3_map = {},
  } = input;

  // ── 1. Build a quick lookup of cohort → action. ────────────────────────
  const actionByCohort = new Map<string, PortfolioAction>();
  for (const a of portfolio.actions) actionByCohort.set(a.cohort_id, a);

  // ── 2. Drop preflag entries whose cohort the MIP non-renewed. ──────────
  // Rationale: if non_renew > 0.5, the carrier's expected book at renewal
  // no longer contains a large share of those policies; pre-flagging them
  // is wasted operator attention.
  const filteredPreflag = preflagged.filter((p) => {
    const action = actionByCohort.get(p.cohort_id);
    if (!action) return true; // unknown cohort -> keep (fail-safe)
    return action.non_renew <= NON_RENEW_THRESHOLD;
  });

  // ── 3. Compute per-zone demand multipliers from cession shares. ────────
  // For every zone, find the cohorts that sit in the same zip3 and average
  // their *retained* loss share (= 1 - cede_qs - cede_xs). A zone with no
  // mapped cohorts gets no entry. Multipliers are clamped to [0, 1].
  const zoneZip3 = new Map<number, string>(
    Object.entries(zone_zip3_map).map(([k, v]) => [Number(k), v]),
  );
  const cohortZip3 = new Map<string, string>(Object.entries(cohort_zip3_map));

  // Build a reverse index: zip3 → list of retained shares.
  const retainedByZip3 = new Map<string, number[]>();
  for (const a of portfolio.actions) {
    const zip3 = cohortZip3.get(a.cohort_id);
    if (!zip3) continue;
    const retained = Math.max(0, Math.min(1, 1 - a.cede_qs - a.cede_xs));
    const arr = retainedByZip3.get(zip3) ?? [];
    arr.push(retained);
    retainedByZip3.set(zip3, arr);
  }

  const demandAdjustments: Record<number, number> = {};
  const zonesTouched = new Set<number>(vrp.assignments.map((a) => a.zone_id));
  for (const zoneId of zonesTouched) {
    const zip3 = zoneZip3.get(zoneId);
    if (!zip3) continue;
    const retainedList = retainedByZip3.get(zip3);
    if (!retainedList || retainedList.length === 0) continue;
    const avgRetained =
      retainedList.reduce((s, v) => s + v, 0) / retainedList.length;
    demandAdjustments[zoneId] = Math.max(0, Math.min(1, avgRetained));
  }

  // ── 4. Surface conflicts: high non-renew + lots of stationed adjusters. ─
  // Count assignments per zone (adjuster-days). For each "high non_renew"
  // cohort, check the zone that shares its zip3 — if that zone is heavily
  // staffed, the manager probably wants to revisit one of the decisions.
  const assignmentsPerZone = new Map<number, number>();
  for (const a of vrp.assignments) {
    assignmentsPerZone.set(a.zone_id, (assignmentsPerZone.get(a.zone_id) ?? 0) + 1);
  }

  // zip3 → zoneId(s) reverse index.
  const zonesByZip3 = new Map<string, number[]>();
  for (const [zoneId, zip3] of zoneZip3.entries()) {
    const arr = zonesByZip3.get(zip3) ?? [];
    arr.push(zoneId);
    zonesByZip3.set(zip3, arr);
  }

  const conflicts: ReconcileConflict[] = [];
  for (const a of portfolio.actions) {
    if (a.non_renew <= NON_RENEW_THRESHOLD) continue;
    const zip3 = cohortZip3.get(a.cohort_id);
    if (!zip3) continue;
    const zones = zonesByZip3.get(zip3) ?? [];
    for (const zoneId of zones) {
      const staffing = assignmentsPerZone.get(zoneId) ?? 0;
      if (staffing >= HIGH_ADJUSTER_DAYS) {
        conflicts.push({
          kind: 'high_nonrenew_with_adjusters',
          cohort_id: a.cohort_id,
          zone_id: zoneId,
          details:
            `Cohort ${a.cohort_id} flagged ${(a.non_renew * 100).toFixed(0)}% non-renew, ` +
            `but zone ${zoneId} has ${staffing} adjuster-day(s) scheduled. ` +
            `Revisit either the non-renewal call or the staging plan.`,
        });
      }
    }
  }

  return {
    portfolio,
    preflagged: filteredPreflag,
    vrp: {
      assignments: vrp.assignments,
      demand_adjustments: demandAdjustments,
    },
    conflicts,
  };
}
