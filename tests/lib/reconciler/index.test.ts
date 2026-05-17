// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { reconcile } from '@/lib/reconciler';

describe('reconcile', () => {
  test('removes non-renewed cohorts from preflag list', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [
        {
          policy_id: 100,
          cohort_id: '330_wood_frame_q3',
          severity: 'high',
          expected_loss: 50000,
        },
      ],
      vrp: { assignments: [] },
    });
    expect(out.preflagged).toHaveLength(0);
  });

  test('keeps preflag entries when non_renew is low', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.7,
            non_renew: 0.1,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0,
            reprice_p10: 0.2,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [
        {
          policy_id: 100,
          cohort_id: '330_wood_frame_q3',
          severity: 'high',
          expected_loss: 50000,
        },
      ],
      vrp: { assignments: [] },
    });
    expect(out.preflagged).toHaveLength(1);
  });

  test('records demand-adjustment factor from cession share', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: 'X',
            retain: 0.4,
            cede_qs: 0.5,
            cede_xs: 0.1,
            non_renew: 0,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [{ adjuster_id: 1, zone_id: 100, day: 0, drive_hours: 2 }] },
      cohort_zip3_map: { X: '330' },
      zone_zip3_map: { 100: '330' },
    });
    // Cede_qs takes 50% of losses; demand at that zone should reduce
    // proportionally. Actual factor is implementation-defined — assert it's
    // strictly between 0 and 1.
    const adj = out.vrp.demand_adjustments[100];
    expect(adj).toBeGreaterThan(0);
    expect(adj).toBeLessThan(1);
  });

  test('flags conflict when high-nonrenew cohort overlaps adjuster-staffed zone', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: 'X',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: {
        assignments: [
          { adjuster_id: 1, zone_id: 100, day: 0, drive_hours: 2 },
          { adjuster_id: 2, zone_id: 100, day: 0, drive_hours: 2 },
        ],
      },
      cohort_zip3_map: { X: '330' },
      zone_zip3_map: { 100: '330' },
    });
    expect(out.conflicts.length).toBeGreaterThan(0);
    expect(out.conflicts[0].cohort_id).toBe('X');
  });
});

// ---------------------------------------------------------------------------
// Task P2.31 — Notice-period filter
// ---------------------------------------------------------------------------

describe('reconcile — notice-period filter (P2.31)', () => {
  const today = new Date('2026-05-17T00:00:00Z');
  const addDays = (d: Date, days: number): string => {
    const r = new Date(d.getTime());
    r.setUTCDate(r.getUTCDate() + days);
    return r.toISOString().slice(0, 10);
  };

  test('inside-notice-window policy: FL 120-day, 150 days to renewal → non_renew passes through unchanged', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' }, // FL
      cohort_renewal_date_map: { '330_wood_frame_q3': addDays(today, 150) },
      today,
    });
    expect(out.stamped_actions).toEqual([]);
  });

  test('outside-notice-window policy: FL 120-day, 60 days to renewal → downgraded to non_renew_next_renewal', () => {
    const renewal = addDays(today, 60);
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' }, // FL
      cohort_renewal_date_map: { '330_wood_frame_q3': renewal },
      today,
    });
    expect(out.stamped_actions).toHaveLength(1);
    const stamped = out.stamped_actions[0];
    expect(stamped.cohort_id).toBe('330_wood_frame_q3');
    expect(stamped.action).toBe('non_renew_next_renewal');
    if (stamped.action !== 'non_renew_next_renewal') {
      throw new Error('expected notice-period stamp');
    }
    expect(stamped.original_action).toBe('non_renew');
    expect(stamped.downgrade_reason).toBe('insufficient_notice_period');
    // next renewal + 1 year
    const expectedStamp = (() => {
      const d = new Date(renewal + 'T00:00:00Z');
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d.toISOString().slice(0, 10);
    })();
    expect(stamped.effective_date_stamp).toBe(expectedStamp);
  });

  test('non-non-renew action: FL, retain dominant, 5 days to renewal → unchanged (filter only applies to non_renew)', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.9,
            non_renew: 0.05,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' }, // FL
      cohort_renewal_date_map: { '330_wood_frame_q3': addDays(today, 5) },
      today,
    });
    expect(out.stamped_actions).toEqual([]);
  });

  test('different states: TX (60-day) and LA (30-day) — each respects its own window', () => {
    // TX 60-day: 45 days to renewal → outside window → downgraded.
    // LA 30-day: 45 days to renewal → inside window → unchanged.
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: 'tx_cohort',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
          {
            cohort_id: 'la_cohort',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { tx_cohort: '770', la_cohort: '703' },
      cohort_renewal_date_map: {
        tx_cohort: addDays(today, 45),
        la_cohort: addDays(today, 45),
      },
      today,
    });
    const stampedCohorts = out.stamped_actions.map((s) => s.cohort_id);
    expect(stampedCohorts).toContain('tx_cohort');
    expect(stampedCohorts).not.toContain('la_cohort');
  });

  test('unknown state: zip3 not in map → conservative 60-day default applied', () => {
    // 30 days to renewal, unknown zip3 → default 60-day → outside window → downgrade.
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: 'unknown_cohort',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { unknown_cohort: '999' }, // not in NOTICE_PERIOD_DAYS
      cohort_renewal_date_map: { unknown_cohort: addDays(today, 30) },
      today,
    });
    expect(out.stamped_actions).toHaveLength(1);
    const stamp = out.stamped_actions[0];
    if (stamp.action !== 'non_renew_next_renewal') {
      throw new Error('expected notice-period stamp');
    }
    expect(stamp.downgrade_reason).toBe('insufficient_notice_period');
  });

  test('missing renewal date: defaults to today + 365 days → inside any state notice window → unchanged', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' }, // FL, 120-day
      // no cohort_renewal_date_map → default today + 365 > 120 → pass through
      today,
    });
    expect(out.stamped_actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task P2.32 — Per-(state, territory) regulatory caps
// ---------------------------------------------------------------------------

describe('reconcile — territory caps (P2.32)', () => {
  const today = new Date('2026-05-17T00:00:00Z');
  const addDays = (d: Date, days: number): string => {
    const r = new Date(d.getTime());
    r.setUTCDate(r.getUTCDate() + days);
    return r.toISOString().slice(0, 10);
  };

  test('end-to-end: notice-period + territory-cap stamps coexist on the same call', () => {
    // 4 FL:coastal cohorts non-renew 1M of a 10M FL:coastal book = 10% > 3% cap.
    // One of them is also outside the FL 120-day notice window (60-day to
    // renewal) and so gets a notice-period stamp; that cohort does NOT count
    // toward this cycle's bucket cap, so the remaining 3 cohorts (700k total)
    // are still well over the 3% (300k) cap and the smallest two get downgraded.
    const longRenewal = addDays(today, 365); // inside FL 120-day window
    const shortRenewal = addDays(today, 60); // outside FL 120-day window
    const action = (cohort_id: string) => ({
      cohort_id,
      retain: 0.05,
      non_renew: 0.9,
      reprice_n20: 0,
      reprice_n10: 0,
      reprice_0: 0,
      reprice_p5: 0.05,
      reprice_p10: 0,
      reprice_p15: 0,
      reprice_p20: 0,
      cede_qs: 0,
      cede_xs: 0,
    });
    const out = reconcile({
      portfolio: {
        actions: [
          action('deferred_big'), // 300k — gets a notice-period stamp
          action('small'), // 100k
          action('mid'), // 200k
          action('big'), // 400k
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: {
        deferred_big: '330',
        small: '331',
        mid: '332',
        big: '339',
      },
      cohort_renewal_date_map: {
        deferred_big: shortRenewal,
        small: longRenewal,
        mid: longRenewal,
        big: longRenewal,
      },
      cohort_tiv_map: {
        deferred_big: 300_000,
        small: 100_000,
        mid: 200_000,
        big: 400_000,
      },
      bucket_total_tiv: { 'FL:coastal': 10_000_000 },
      today,
    });
    const noticeStamps = out.stamped_actions.filter(
      (s) => s.action === 'non_renew_next_renewal',
    );
    const capStamps = out.stamped_actions.filter(
      (s) => s.action === 'non_renew_capped',
    );
    expect(noticeStamps.map((s) => s.cohort_id)).toEqual(['deferred_big']);
    // small + mid go over cap (700k total, cap 300k → must drop 400k).
    // smallest-first: drop small (100k → 600k), drop mid (200k → 400k still over),
    // drop big (400k → 0k OK). All three remaining cohorts downgraded.
    expect(capStamps.map((s) => s.cohort_id).sort()).toEqual(['big', 'mid', 'small']);
  });

  test('stamp shape — non_renew_capped carries bucket, cap_fraction, observed_fraction', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: 'C',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { C: '330' }, // FL:coastal
      cohort_tiv_map: { C: 500_000 },
      bucket_total_tiv: { 'FL:coastal': 10_000_000 },
      today,
    });
    const capStamp = out.stamped_actions.find((s) => s.action === 'non_renew_capped');
    expect(capStamp).toBeDefined();
    expect(capStamp!.bucket).toBe('FL:coastal');
    expect(capStamp!.cap_fraction).toBeCloseTo(0.03, 6);
    expect(capStamp!.observed_fraction).toBeCloseTo(0.05, 6); // 500k / 10M
    expect(capStamp!.original_action).toBe('non_renew');
    expect(capStamp!.downgrade_reason).toBe('territory_cap_exceeded');
  });
});

// ---------------------------------------------------------------------------
// Task P2.33 — Operator pin overrides
// ---------------------------------------------------------------------------

describe('reconcile — operator pins (P2.33)', () => {
  const today = new Date('2026-05-17T00:00:00Z');
  const addDays = (d: Date, days: number): string => {
    const r = new Date(d.getTime());
    r.setUTCDate(r.getUTCDate() + days);
    return r.toISOString().slice(0, 10);
  };

  test('pinned cohort: reconciler forces the pinned action and emits a PinStamp', () => {
    // MIP wants this cohort to retain; operator pins it to reprice_p10.
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            non_renew: 0.05,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' },
      pins: [
        {
          policy_id: 12345,
          action: 'reprice_p10',
          operator: 'demo_operator',
          ts: '2026-05-17T00:00:00Z',
          rationale: 'manual override — exposure too high',
        },
      ],
      policy_to_cohort_map: { 12345: '330_wood_frame_q3' },
      today,
    });
    const pinStamps = out.stamped_actions.filter((s) => s.action === 'pin');
    expect(pinStamps).toHaveLength(1);
    const stamp = pinStamps[0];
    if (stamp.action !== 'pin') throw new Error('expected pin stamp');
    expect(stamp.cohort_id).toBe('330_wood_frame_q3');
    expect(stamp.policy_id).toBe(12345);
    expect(stamp.action).toBe('pin');
    expect(stamp.pinned_action).toBe('reprice_p10');
    expect(stamp.operator).toBe('demo_operator');
    expect(stamp.rationale).toMatch(/exposure too high/);
    expect(stamp.original_action).toBe('retain');
    // action_summary is replaced: the dominant action for the cohort is now
    // the pinned action.
    const a = out.portfolio.actions.find((x) => x.cohort_id === '330_wood_frame_q3');
    expect(a).toBeDefined();
    expect(a!.reprice_p10).toBeCloseTo(1.0, 6);
    expect(a!.retain).toBeCloseTo(0, 6);
  });

  test('pin → P2.31 downgrade chain: pin to non_renew + short notice → both stamps emitted', () => {
    // MIP wants retain. Operator pins non_renew. Short notice window means
    // P2.31 ALSO downgrades the now-pinned non_renew to non_renew_next_renewal.
    const renewal = addDays(today, 60); // outside FL 120-day window
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            non_renew: 0.05,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' },
      cohort_renewal_date_map: { '330_wood_frame_q3': renewal },
      pins: [
        {
          policy_id: 9001,
          action: 'non_renew',
          operator: 'demo_operator',
          ts: '2026-05-17T00:00:00Z',
          rationale: 'operator confirms cohort exit despite MIP',
        },
      ],
      policy_to_cohort_map: { 9001: '330_wood_frame_q3' },
      today,
    });
    const pinStamps = out.stamped_actions.filter((s) => s.action === 'pin');
    const noticeStamps = out.stamped_actions.filter(
      (s) => s.action === 'non_renew_next_renewal',
    );
    expect(pinStamps).toHaveLength(1);
    expect(noticeStamps).toHaveLength(1);
    expect(noticeStamps[0].cohort_id).toBe('330_wood_frame_q3');
  });

  test('pin to retain: P2.31 / P2.32 do NOT touch the pinned cohort', () => {
    // MIP wants non_renew (would normally trigger notice-period + cap pass).
    // Operator pins retain — those filters must see retain, not non_renew.
    const renewal = addDays(today, 60); // would fail FL 120-day notice
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            non_renew: 0.9,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' },
      cohort_renewal_date_map: { '330_wood_frame_q3': renewal },
      cohort_tiv_map: { '330_wood_frame_q3': 500_000 },
      bucket_total_tiv: { 'FL:coastal': 10_000_000 },
      pins: [
        {
          policy_id: 1234,
          action: 'retain',
          operator: 'demo_operator',
          ts: '2026-05-17T00:00:00Z',
          rationale: 'long-standing customer, retain regardless of model',
        },
      ],
      policy_to_cohort_map: { 1234: '330_wood_frame_q3' },
      today,
    });
    // Pin stamp emitted; no notice-period / cap stamps for this cohort.
    const pinStamps = out.stamped_actions.filter((s) => s.action === 'pin');
    const noticeStamps = out.stamped_actions.filter(
      (s) => s.action === 'non_renew_next_renewal',
    );
    const capStamps = out.stamped_actions.filter((s) => s.action === 'non_renew_capped');
    expect(pinStamps).toHaveLength(1);
    expect(noticeStamps).toHaveLength(0);
    expect(capStamps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task P2.34 — Agent-channel notification emit
// ---------------------------------------------------------------------------

describe('reconcile — agent notifications (P2.34)', () => {
  const today = new Date('2026-05-17T00:00:00Z');
  const addDays = (d: Date, days: number): string => {
    const r = new Date(d.getTime());
    r.setUTCDate(r.getUTCDate() + days);
    return r.toISOString().slice(0, 10);
  };

  test('direct non_renew emits one non_renew_decision notification', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' },
      // Long renewal so the notice-period filter does NOT downgrade.
      cohort_renewal_date_map: { '330_wood_frame_q3': addDays(today, 365) },
      cohort_tiv_map: { '330_wood_frame_q3': 100_000 },
      // No bucket denominator → cap pass treats observed = 1.0; we expect the
      // cap to fire too, but for this test we focus on the "non_renew direct"
      // path by giving the bucket plenty of headroom.
      bucket_total_tiv: { 'FL:coastal': 100_000_000 },
      today,
    });
    expect(out.notifications).toBeDefined();
    expect(out.notifications).toHaveLength(1);
    const n = out.notifications[0];
    expect(n.type).toBe('non_renew_decision');
    expect(n.cohort_id).toBe('330_wood_frame_q3');
    expect(n.action).toBe('non_renew');
    expect(n.total_tiv).toBe(100_000);
    expect(typeof n.rationale).toBe('string');
    expect(n.rationale.length).toBeGreaterThan(0);
    expect(typeof n.ts).toBe('string');
    // ISO-8601 sanity check.
    expect(Number.isNaN(Date.parse(n.ts))).toBe(false);
    expect(Array.isArray(n.stamps)).toBe(true);
  });

  test('non_renew_next_renewal emits notification with deferred action + notice stamp context', () => {
    const renewal = addDays(today, 60); // outside FL 120-day window
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' },
      cohort_renewal_date_map: { '330_wood_frame_q3': renewal },
      cohort_tiv_map: { '330_wood_frame_q3': 250_000 },
      bucket_total_tiv: { 'FL:coastal': 100_000_000 },
      today,
    });
    expect(out.notifications).toHaveLength(1);
    const n = out.notifications[0];
    expect(n.cohort_id).toBe('330_wood_frame_q3');
    expect(n.action).toBe('non_renew_next_renewal');
    expect(n.total_tiv).toBe(250_000);
    // Notice-period stamp should be attached for context.
    expect(n.stamps.some((s) => s.action === 'non_renew_next_renewal')).toBe(true);
    // Rationale should mention notice / next renewal.
    expect(n.rationale.toLowerCase()).toMatch(/notice|renewal/);
  });

  test('non_renew_capped emits notification mentioning bucket + cap fraction', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: 'C',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { C: '330' }, // FL:coastal
      cohort_tiv_map: { C: 500_000 },
      bucket_total_tiv: { 'FL:coastal': 10_000_000 },
      today,
    });
    expect(out.notifications).toHaveLength(1);
    const n = out.notifications[0];
    expect(n.action).toBe('non_renew_capped');
    expect(n.cohort_id).toBe('C');
    // Rationale carries the bucket key + a cap-vs-observed fraction.
    expect(n.rationale).toMatch(/FL:coastal/);
    expect(n.rationale).toMatch(/3(\.\d+)?%|0\.03/); // cap
    expect(n.stamps.some((s) => s.action === 'non_renew_capped')).toBe(true);
  });

  test('retain action does NOT emit notification', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.9,
            non_renew: 0.05,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { '330_wood_frame_q3': '330' },
      today,
    });
    expect(out.notifications).toEqual([]);
  });

  test('multiple non-renew cohorts: notification count matches non-renew action count', () => {
    // Two cohorts, both non-renew, plenty of cap headroom + long notice.
    const longRenewal = addDays(today, 365);
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: 'A',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
          {
            cohort_id: 'B',
            retain: 0.05,
            non_renew: 0.9,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
          {
            cohort_id: 'C_retain',
            retain: 0.9,
            non_renew: 0.05,
            reprice_n20: 0,
            reprice_n10: 0,
            reprice_0: 0,
            reprice_p5: 0.05,
            reprice_p10: 0,
            reprice_p15: 0,
            reprice_p20: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
        ],
      },
      preflagged: [],
      vrp: { assignments: [] },
      cohort_zip3_map: { A: '330', B: '330', C_retain: '330' },
      cohort_renewal_date_map: { A: longRenewal, B: longRenewal },
      cohort_tiv_map: { A: 100_000, B: 100_000 },
      bucket_total_tiv: { 'FL:coastal': 1_000_000_000 },
      today,
    });
    // Two non-renew cohorts → two notifications. The retain cohort is silent.
    expect(out.notifications).toHaveLength(2);
    const cohorts = out.notifications.map((n) => n.cohort_id).sort();
    expect(cohorts).toEqual(['A', 'B']);
    for (const n of out.notifications) {
      expect(n.action).toBe('non_renew');
    }
  });
});
