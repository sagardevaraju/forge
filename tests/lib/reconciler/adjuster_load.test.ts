/**
 * Task P2.28 — Unit tests for the per-ZIP3 adjuster-load helper.
 *
 * The helper rolls a list of pre-flagged policies plus the MIP cohort prior
 * up to a per-ZIP3 adjuster-need delta:
 *
 *   needed = ceil(sum(expected_loss_per_policy) / DOLLARS_PER_ADJUSTER)
 *   delta  = needed - baseline_staffing
 *
 * where:
 *   - `expected_loss_per_policy` is the MIP cohort `loss_p50` split
 *     proportionally to each policy's TIV inside that cohort,
 *   - `DOLLARS_PER_ADJUSTER` is a tuned constant on the helper module,
 *   - `baseline_staffing` is a per-ZIP3 default-staffing assumption (also
 *     a tuned constant). Until a real VRP / staffing feed lands, this is
 *     documented as a heuristic.
 *
 * The helper is pure: same input → same output, no I/O.
 */
import { describe, test, expect } from 'vitest';
import {
  computeAdjusterLoad,
  ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER,
  ADJUSTER_LOAD_BASELINE_PER_ZIP3,
} from '@/lib/reconciler/adjuster_load';
import type { PreflagPolicy } from '@/components/ClaimsTable';

describe('computeAdjusterLoad', () => {
  test('empty pre-flag set → empty rollup', () => {
    const result = computeAdjusterLoad([]);
    expect(result.rows).toEqual([]);
    expect(result.total_needed).toBe(0);
    expect(result.total_delta).toBe(0);
  });

  test('null expected_loss policies do not contribute', () => {
    const policies: PreflagPolicy[] = [
      { policy_id: 1, zip3: '337', tiv: 100_000, build_type: 'masonry', flood_zone: 'AE', severity: 'high', expected_loss: null },
    ];
    const result = computeAdjusterLoad(policies);
    // No expected loss → no derived demand → no rollup row.
    expect(result.rows).toEqual([]);
  });

  test('single ZIP3, single policy: needed = ceil(loss / dollars_per_adjuster)', () => {
    const loss = ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER * 2.5; // 2.5 adjusters' worth
    const policies: PreflagPolicy[] = [
      { policy_id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE', severity: 'high', expected_loss: loss },
    ];
    const result = computeAdjusterLoad(policies);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.zip3).toBe('337');
    // ceil(2.5) = 3
    expect(row.needed).toBe(3);
    expect(row.baseline).toBe(ADJUSTER_LOAD_BASELINE_PER_ZIP3);
    expect(row.delta).toBe(3 - ADJUSTER_LOAD_BASELINE_PER_ZIP3);
  });

  test('multiple ZIP3s: rolled-up independently, sorted by delta desc', () => {
    const policies: PreflagPolicy[] = [
      // 337: 5 adjusters' worth
      { policy_id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE', severity: 'high', expected_loss: ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER * 5 },
      // 342: 1 adjuster's worth
      { policy_id: 2, zip3: '342', tiv: 500_000, build_type: 'masonry', flood_zone: 'AE', severity: 'medium', expected_loss: ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER },
    ];
    const result = computeAdjusterLoad(policies);
    expect(result.rows).toHaveLength(2);
    // Higher-delta ZIP3 first (337 needs more than 342).
    expect(result.rows[0].zip3).toBe('337');
    expect(result.rows[1].zip3).toBe('342');
    // total_needed = 5 + 1 = 6
    expect(result.total_needed).toBe(6);
  });

  test('two policies in the same ZIP3 stack additively', () => {
    const half = ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER * 1.5; // 1.5 adjusters
    const policies: PreflagPolicy[] = [
      { policy_id: 1, zip3: '337', tiv: 500_000, build_type: 'masonry', flood_zone: 'AE', severity: 'high', expected_loss: half },
      { policy_id: 2, zip3: '337', tiv: 500_000, build_type: 'masonry', flood_zone: 'AE', severity: 'high', expected_loss: half },
    ];
    const result = computeAdjusterLoad(policies);
    expect(result.rows).toHaveLength(1);
    // sum = 3 adjusters' worth → ceil(3) = 3
    expect(result.rows[0].needed).toBe(3);
    expect(result.rows[0].policy_count).toBe(2);
  });

  test('total_delta = total_needed - (rows.length × baseline)', () => {
    const policies: PreflagPolicy[] = [
      { policy_id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE', severity: 'high', expected_loss: ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER * 3 },
      { policy_id: 2, zip3: '342', tiv: 500_000, build_type: 'masonry', flood_zone: 'AE', severity: 'medium', expected_loss: ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER * 2 },
    ];
    const result = computeAdjusterLoad(policies);
    // needed = 3 + 2 = 5; baseline pool = 2 zips × baseline
    expect(result.total_needed).toBe(5);
    expect(result.total_delta).toBe(5 - 2 * ADJUSTER_LOAD_BASELINE_PER_ZIP3);
  });
});
