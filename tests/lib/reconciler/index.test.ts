import { describe, test, expect } from 'vitest';
import { reconcile } from '@/lib/reconciler';

describe('reconcile', () => {
  test('removes non-renewed cohorts from preflag list', () => {
    const out = reconcile({
      portfolio: {
        actions: [
          {
            cohort_id: '330_wood_frame_d3',
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
          cohort_id: '330_wood_frame_d3',
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
            cohort_id: '330_wood_frame_d3',
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
          cohort_id: '330_wood_frame_d3',
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
