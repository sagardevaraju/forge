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
 * Task P2.31 — Notice-period filter. For each cohort the MIP voted to
 * **non-renew**, check whether the carrier has enough days of statutory
 * notice to non-renew at the upcoming renewal cycle. If not, the action is
 * **downgraded** to ``non_renew_next_renewal`` and stamped with the next
 * renewal cycle's effective date (+1 year). This is a post-solve artifact
 * emitted alongside the original portfolio actions; the MIP itself never
 * sees the new label.
 *
 * The reconciler is intentionally pure: same input → same output, no I/O,
 * no DB access. Inputs come in as plain objects; outputs are a new
 * `ReconcileOutput` (the original inputs are not mutated).
 */

import { noticeWindowForZip3 } from '@/lib/regulatory/notice_periods';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PortfolioAction {
  cohort_id: string;
  retain: number;
  reprice_up: number;
  reprice_down: number;
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
  /**
   * P2.31 — cohort_id → next renewal effective date (ISO ``YYYY-MM-DD``).
   * Optional; when missing, the reconciler defaults to ``today + 365 days``.
   */
  cohort_renewal_date_map?: Record<string, string>;
  /**
   * P2.31 — clock injection for deterministic tests. Defaults to ``new Date()``
   * at call time.
   */
  today?: Date;
}

export interface ReconcileConflict {
  kind: 'high_nonrenew_with_adjusters';
  cohort_id: string;
  zone_id: number;
  details: string;
}

/**
 * P2.31 — Reconciler-side action label. The MIP only emits the six base
 * actions in ``ActionName``; the reconciler emits this artifact label when a
 * ``non_renew`` action violates the state's statutory notice window and must
 * be deferred to the next renewal cycle.
 */
export type ReconciledActionName = 'non_renew_next_renewal';

/**
 * P2.31 — A stamped reconciler-side action. Emitted alongside (not in place
 * of) the original ``PortfolioAction[]``: downstream consumers can pick
 * whichever matches their decision horizon.
 */
export interface StampedAction {
  cohort_id: string;
  action: ReconciledActionName;
  original_action: 'non_renew';
  downgrade_reason: 'insufficient_notice_period';
  /** ISO ``YYYY-MM-DD`` — next renewal date + 1 year. */
  effective_date_stamp: string;
  /** ZIP3 prefix that drove the state lookup (for traceability). */
  zip3?: string;
  /** Statutory notice window days for the state. */
  notice_days: number;
  /** Days from ``today`` to the renewal we would have non-renewed at. */
  days_to_renewal: number;
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
  /**
   * P2.31 — per-cohort downgrades of ``non_renew`` actions that fail the
   * state notice-period clock. Empty when every non-renewal call had
   * sufficient lead time.
   */
  stamped_actions: StampedAction[];
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A cohort is treated as "non-renewed" if non_renew exceeds this threshold. */
const NON_RENEW_THRESHOLD = 0.5;

/** A zone counts as "heavily staffed" if it has at least this many adjuster-days. */
const HIGH_ADJUSTER_DAYS = 2;

/** P2.31 — milliseconds per day, used for date arithmetic. */
const MS_PER_DAY = 86_400_000;

/**
 * P2.31 — Parse an ISO ``YYYY-MM-DD`` date into a UTC ``Date``. Returns
 * ``null`` if the input is not a recognizable ISO date.
 */
function parseISODate(iso: string): Date | null {
  if (!iso) return null;
  // Accept full ISO timestamps too, but normalize to the date-only boundary.
  const ymd = iso.slice(0, 10);
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** P2.31 — Format a UTC ``Date`` as ``YYYY-MM-DD``. */
function formatISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** P2.31 — Add ``days`` (integer) to a UTC ``Date`` and return a new Date. */
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

/** P2.31 — Add one calendar year to a UTC ``Date`` and return a new Date. */
function addOneYear(d: Date): Date {
  const r = new Date(d.getTime());
  r.setUTCFullYear(r.getUTCFullYear() + 1);
  return r;
}

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
    cohort_renewal_date_map = {},
    today = new Date(),
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

  // ── 5. P2.31 — Notice-period filter on non_renew actions. ──────────────
  // A cohort flagged for non-renewal must clear the state's statutory notice
  // window relative to its upcoming renewal effective date. If the carrier
  // cannot give the required days of notice in time, the action is
  // **downgraded** to ``non_renew_next_renewal`` with the next cycle's
  // effective-date stamp; downstream consumers display the deferred decision.
  //
  // The original ``portfolio.actions`` are NOT mutated — the MIP's continuous
  // shares are still useful for reporting. The stamps are emitted as a
  // separate ``stamped_actions`` array so callers can join the two.
  //
  // Defaults: missing renewal date → today + 365 days. Unknown state →
  // ``noticeWindowForZip3`` returns a conservative 60-day fallback.
  const todayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const defaultRenewal = addDays(todayStart, 365);

  const stampedActions: StampedAction[] = [];
  for (const a of portfolio.actions) {
    if (a.non_renew <= NON_RENEW_THRESHOLD) continue;
    const zip3 = cohortZip3.get(a.cohort_id);
    const renewalISO = cohort_renewal_date_map[a.cohort_id];
    const renewal = (renewalISO && parseISODate(renewalISO)) || defaultRenewal;
    const daysToRenewal = Math.round(
      (renewal.getTime() - todayStart.getTime()) / MS_PER_DAY,
    );
    const noticeDays = noticeWindowForZip3(zip3 ?? '');
    if (daysToRenewal < noticeDays) {
      stampedActions.push({
        cohort_id: a.cohort_id,
        action: 'non_renew_next_renewal',
        original_action: 'non_renew',
        downgrade_reason: 'insufficient_notice_period',
        effective_date_stamp: formatISODate(addOneYear(renewal)),
        zip3,
        notice_days: noticeDays,
        days_to_renewal: daysToRenewal,
      });
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
    stamped_actions: stampedActions,
  };
}
