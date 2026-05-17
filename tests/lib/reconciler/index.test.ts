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
            reprice_up: 0.05,
            reprice_down: 0,
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
            reprice_up: 0.2,
            reprice_down: 0,
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
            reprice_up: 0,
            reprice_down: 0,
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
            reprice_up: 0.05,
            reprice_down: 0,
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
            reprice_up: 0.05,
            reprice_down: 0,
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
            reprice_up: 0.05,
            reprice_down: 0,
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
    expect(stamped.original_action).toBe('non_renew');
    expect(stamped.downgrade_reason).toBe('insufficient_notice_period');
    // next renewal + 1 year
    const expectedStamp = (() => {
      const d = new Date(renewal + 'T00:00:00Z');
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d.toISOString().slice(0, 10);
    })();
    if (stamped.action !== 'non_renew_next_renewal') {
      throw new Error('expected notice-period stamp');
    }
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
            reprice_up: 0.05,
            reprice_down: 0,
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
            reprice_up: 0.05,
            reprice_down: 0,
            cede_qs: 0,
            cede_xs: 0,
          },
          {
            cohort_id: 'la_cohort',
            retain: 0.05,
            non_renew: 0.9,
            reprice_up: 0.05,
            reprice_down: 0,
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
            reprice_up: 0.05,
            reprice_down: 0,
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
    expect(out.stamped_actions[0].downgrade_reason).toBe('insufficient_notice_period');
  });

  test('missing renewal date: defaults to today + 365 days → inside any state notice window → unchanged', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_q3',
            retain: 0.05,
            non_renew: 0.9,
            reprice_up: 0.05,
            reprice_down: 0,
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
      reprice_up: 0.05,
      reprice_down: 0,
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
            reprice_up: 0.05,
            reprice_down: 0,
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
