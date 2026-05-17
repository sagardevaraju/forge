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
 * Task P2.32 — Per-(state, territory) regulatory caps. After P2.31 runs,
 * the surviving non-renew cohorts are grouped into ``(state, territory)``
 * buckets (FL:coastal, TX:tier_1, etc.). For each bucket the reconciler
 * sums non-renew TIV; if the total exceeds the bucket's cap (see
 * ``lib/regulatory/territory_caps.ts``), the smallest cohorts are downgraded
 * one at a time (least customer disruption first) until the bucket fits,
 * each emitting a ``non_renew_capped`` stamp. Precedence: a cohort already
 * deferred by P2.31 does NOT count toward this year's bucket cap; it has
 * already been pushed to next year's cycle.
 *
 * The reconciler is intentionally pure: same input → same output, no I/O,
 * no DB access. Inputs come in as plain objects; outputs are a new
 * `ReconcileOutput` (the original inputs are not mutated).
 */

import { noticeWindowForZip3 } from '@/lib/regulatory/notice_periods';
import {
  applyTerritoryCaps,
  type TerritoryCapStamp,
} from '@/lib/regulatory/territory_caps';
import type { ActionName } from '@/lib/portfolio-actions';

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
  /**
   * P2.32 — per-cohort total TIV, used to size the territory-cap denominator
   * and to choose downgrade order (smallest-first). Cohorts whose TIV is
   * unknown contribute zero to the bucket sum.
   */
  cohort_tiv_map?: Record<string, number>;
  /**
   * P2.32 — per-bucket total book TIV (e.g. ``{"FL:coastal": 1.2e9}``). When
   * a bucket's denominator is missing, the cap-application pass falls back
   * to the bucket's own non-renew TIV; see ``applyTerritoryCaps``.
   */
  bucket_total_tiv?: Record<string, number>;
  /**
   * P2.33 — operator pin overrides. Each pin forces a specific cohort's
   * recommended action regardless of the MIP's vote. Pins are stored
   * per-policy (see ``lib/db/pins.ts``); the reconciler maps each pinned
   * ``policy_id`` to its ``cohort_id`` via ``policy_to_cohort_map`` and
   * rewrites that cohort's action one-hot. Pinned cohorts are NOT exempt
   * from the P2.31 / P2.32 filters — a pin to ``non_renew`` can still be
   * downgraded by insufficient notice or an over-cap bucket.
   */
  pins?: ReadonlyArray<{
    policy_id: number;
    action: ActionName;
    operator: string;
    ts: string;
    rationale: string;
  }>;
  /** P2.33 — ``policy_id → cohort_id`` lookup for pin resolution. */
  policy_to_cohort_map?: Record<number, string>;
}

export interface ReconcileConflict {
  kind: 'high_nonrenew_with_adjusters';
  cohort_id: string;
  zone_id: number;
  details: string;
}

/**
 * P2.31 / P2.32 — Reconciler-side action labels. The MIP only emits the six
 * base actions in ``ActionName``; the reconciler emits these artifact labels
 * when a ``non_renew`` action either (P2.31) fails the state's statutory
 * notice window or (P2.32) exceeds a per-(state, territory) regulatory cap.
 *
 * A single cohort can carry both stamps simultaneously — they are surfaced
 * as separate entries in ``stamped_actions``. The P2.31 (notice-period)
 * downgrade takes precedence: a cohort already deferred to next year does
 * not count toward this year's bucket cap.
 */
export type ReconciledActionName = 'non_renew_next_renewal' | 'non_renew_capped';

/**
 * P2.31 — A stamped reconciler-side action for a cohort whose non-renewal
 * must be deferred to the next renewal cycle (notice-period filter).
 */
export interface NoticePeriodStamp {
  cohort_id: string;
  action: 'non_renew_next_renewal';
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

/**
 * P2.32 — A stamped reconciler-side action for a cohort the territory-cap
 * filter downgraded because its (state, territory) bucket would otherwise
 * exceed the regulatory annual non-renewal share.
 */
export interface TerritoryCapStampWithZip extends TerritoryCapStamp {
  /** ZIP3 prefix that drove the territory lookup (for traceability). */
  zip3?: string;
}

/**
 * P2.33 — A stamped reconciler-side artifact for a cohort whose recommended
 * action was forced by a human operator pin. The pin overrides the MIP's vote
 * (the cohort's ``action_summary`` is rewritten one-hot to ``pinned_action``)
 * and is surfaced separately from the P2.31 / P2.32 stamps so the UI / agent
 * channel can attribute the override to its operator + rationale.
 *
 * A single cohort can carry both a ``PinStamp`` AND a follow-on P2.31 /
 * P2.32 stamp — if the pin sets ``non_renew`` and the notice clock or
 * territory cap binds, the downgrade still happens. Pins to non-non_renew
 * actions (``retain``, ``reprice_*``, ``cede_*``) are immune to those
 * downgrades because P2.31 / P2.32 only fire on ``non_renew``.
 */
export interface PinStamp {
  cohort_id: string;
  action: 'pin';
  /** Policy whose pin forced the override. */
  policy_id: number;
  /** Action the operator pinned (one of the six MIP actions). */
  pinned_action: ActionName;
  /** Operator who set the pin (free-form string until Phase 3 auth). */
  operator: string;
  /** Operator's free-form justification (>=10 chars enforced upstream). */
  rationale: string;
  /** ISO-8601 timestamp the pin was last written. */
  ts: string;
  /** MIP's pre-pin dominant action — preserved so the audit trail is legible. */
  original_action: ActionName;
}

/**
 * P2.31 / P2.32 / P2.33 — Stamped reconciler artifact. Emitted alongside (not
 * in place of) the original ``PortfolioAction[]``: downstream consumers can
 * pick whichever matches their decision horizon.
 *
 * Precedence within a single ``reconcile()`` call:
 *   1. P2.33 — pin override forces the cohort's action one-hot.
 *   2. P2.31 — notice-period filter; downgrades a (possibly pinned) non_renew.
 *   3. P2.32 — territory-cap filter; downgrades surviving non_renew cohorts.
 */
export type StampedAction = NoticePeriodStamp | TerritoryCapStampWithZip | PinStamp;

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

/**
 * P2.33 — Dominant action for a continuous-share PortfolioAction. Used by the
 * pin pass to record the MIP's pre-pin vote on each ``PinStamp``.
 */
function dominantOf(a: PortfolioAction): ActionName {
  const ACTIONS: ActionName[] = [
    'retain',
    'reprice_up',
    'reprice_down',
    'non_renew',
    'cede_qs',
    'cede_xs',
  ];
  let best: ActionName = 'retain';
  let bestVal = -Infinity;
  for (const k of ACTIONS) {
    if (a[k] > bestVal) {
      bestVal = a[k];
      best = k;
    }
  }
  return best;
}

/** P2.33 — One-hot PortfolioAction with all share on ``action``. */
function oneHot(cohort_id: string, action: ActionName): PortfolioAction {
  return {
    cohort_id,
    retain: action === 'retain' ? 1 : 0,
    reprice_up: action === 'reprice_up' ? 1 : 0,
    reprice_down: action === 'reprice_down' ? 1 : 0,
    non_renew: action === 'non_renew' ? 1 : 0,
    cede_qs: action === 'cede_qs' ? 1 : 0,
    cede_xs: action === 'cede_xs' ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export function reconcile(input: ReconcileInput): ReconcileOutput {
  const {
    preflagged,
    vrp,
    cohort_zip3_map = {},
    zone_zip3_map = {},
    cohort_renewal_date_map = {},
    today = new Date(),
    cohort_tiv_map = {},
    bucket_total_tiv = {},
    pins = [],
    policy_to_cohort_map = {},
  } = input;

  // ── 0. P2.33 — Apply operator pin overrides. ───────────────────────────
  // Clone the input portfolio.actions so we never mutate the caller's
  // object. Pins rewrite the cohort's action one-hot to ``pinned_action`` —
  // the MIP's continuous shares are discarded for that cohort. A PinStamp
  // is emitted per pin so consumers can attribute the override; the
  // pre-pin dominant action is preserved on the stamp.
  //
  // The downstream filters (P2.31 / P2.32) read this cloned action list,
  // so a pin to ``non_renew`` still flows through the notice-period and
  // territory-cap passes — exactly the precedence the docstring above
  // promises. A pin to ``retain`` (or any non-``non_renew`` action) is
  // therefore implicitly immune to P2.31 / P2.32 because those filters
  // only fire when ``non_renew > NON_RENEW_THRESHOLD``.
  const clonedActions: PortfolioAction[] = input.portfolio.actions.map((a) => ({
    ...a,
  }));
  const pinStamps: PinStamp[] = [];
  if (pins.length > 0) {
    const actionIndex = new Map<string, number>();
    clonedActions.forEach((a, i) => actionIndex.set(a.cohort_id, i));
    for (const pin of pins) {
      const cohortId = policy_to_cohort_map[pin.policy_id];
      if (!cohortId) continue; // unknown policy — skip, do not stamp
      const idx = actionIndex.get(cohortId);
      if (idx === undefined) continue; // unknown cohort — skip
      const a = clonedActions[idx];
      const originalAction = dominantOf(a);
      const rewritten = oneHot(cohortId, pin.action);
      clonedActions[idx] = rewritten;
      pinStamps.push({
        cohort_id: cohortId,
        action: 'pin',
        policy_id: pin.policy_id,
        pinned_action: pin.action,
        operator: pin.operator,
        rationale: pin.rationale,
        ts: pin.ts,
        original_action: originalAction,
      });
    }
  }
  const portfolio = { actions: clonedActions };

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

  // Seed the stamped-actions list with the pin overrides applied above.
  // P2.31 / P2.32 will append their own entries below.
  const stampedActions: StampedAction[] = [...pinStamps];
  const noticeDeferredIds = new Set<string>();
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
      noticeDeferredIds.add(a.cohort_id);
    }
  }

  // ── 6. P2.32 — Per-(state, territory) regulatory caps. ─────────────────
  // After the notice-period pass, group the surviving non-renew cohorts by
  // their (state, territory) bucket and check each bucket's annual cap.
  // Cohorts already deferred by P2.31 are skipped — they roll to next cycle
  // and do not consume this year's bucket capacity. Downgrades are stamped
  // smallest-TIV-first (minimizes customer disruption per downgrade).
  const territoryCohortInputs = portfolio.actions
    .filter((a) => a.non_renew > NON_RENEW_THRESHOLD)
    .map((a) => ({
      cohort_id: a.cohort_id,
      zip3: cohortZip3.get(a.cohort_id) ?? '',
      total_tiv: cohort_tiv_map[a.cohort_id] ?? 0,
      non_renew_share: a.non_renew,
    }));
  const territoryResult = applyTerritoryCaps({
    non_renew_cohorts: territoryCohortInputs,
    bucket_total_tiv,
    already_deferred_cohort_ids: noticeDeferredIds,
  });
  for (const stamp of territoryResult.downgraded) {
    const zip3 = cohortZip3.get(stamp.cohort_id);
    stampedActions.push({ ...stamp, zip3 });
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
