// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { aggregateCohorts } from '@/lib/db/cohorts';

describe('aggregateCohorts', () => {
  test('aggregates 10k policies into ~200-500 cohorts', async () => {
    const cohorts = await aggregateCohorts();
    expect(cohorts.length).toBeGreaterThan(150);
    expect(cohorts.length).toBeLessThan(600);
  });

  test('total TIV across cohorts equals book TIV', async () => {
    const cohorts = await aggregateCohorts();
    const totalTiv = cohorts.reduce((s, c) => s + c.total_tiv, 0);
    // Round to dollar to avoid float drift.
    expect(Math.round(totalTiv)).toBeGreaterThan(2_000_000_000); // ~$3B book
  });

  test('every cohort has the 5 modeled CV dims in [0, 1]', async () => {
    const cohorts = await aggregateCohorts();
    const modeledDims = [
      'vegetation_density',
      'fuel_proximity',
      'water_proximity',
      'elevation_bucket',
      'structure_density',
    ] as const;
    for (const c of cohorts) {
      for (const dim of modeledDims) {
        const f = c.avg_cv_features[dim];
        expect(f.value).toBeGreaterThanOrEqual(0);
        expect(f.value).toBeLessThanOrEqual(1);
        expect(f.modeled).toBe(true);
      }
    }
  });

  test('policy_count across cohorts sums to 10000', async () => {
    const cohorts = await aggregateCohorts();
    expect(cohorts.reduce((s, c) => s + c.policy_count, 0)).toBe(10000);
  });

  test('cohort id uses _q{N} not _d{N}', async () => {
    const cohorts = await aggregateCohorts();
    for (const c of cohorts) {
      expect(c.id).toMatch(/_q[0-4]$/);
      expect(c.id).not.toMatch(/_d[0-4]$/);
    }
  });

  test('cv_features carries named dims with unmodeled flags', async () => {
    const cohorts = await aggregateCohorts();
    const c = cohorts[0];
    expect(c.avg_cv_features.vegetation_density.value).toBeTypeOf('number');
    expect(c.avg_cv_features.vegetation_density.modeled).toBe(true);
    // Three dims are unmodeled in Phase 1:
    for (const dim of ['imperviousness', 'roof_complexity', 'tree_overhang']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((c.avg_cv_features as any)[dim]).toBeUndefined(); // or modeled === false
    }
  });
});
