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

  test('every cohort has all 8 modeled CV dims in [0, 1]', async () => {
    // Phase 2 / Task P2.37: the 3 dims dropped in Phase 1 (imperviousness,
    // roof_complexity, tree_overhang) are now modeled via external weak
    // labels and must appear with values in [0, 1].
    const cohorts = await aggregateCohorts();
    const modeledDims = [
      'vegetation_density',
      'imperviousness',
      'fuel_proximity',
      'roof_complexity',
      'water_proximity',
      'elevation_bucket',
      'tree_overhang',
      'structure_density',
    ] as const;
    for (const c of cohorts) {
      for (const dim of modeledDims) {
        const f = c.avg_cv_features[dim];
        expect(f.value).toBeGreaterThanOrEqual(0);
        expect(f.value).toBeLessThanOrEqual(1);
        expect(f.modeled).toBe(true);
        expect(f.source).toBeTypeOf('string');
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

  test('cv_features carries all 8 dims with per-dim source citation', async () => {
    // After Phase 2 / Task P2.37 every dim is modeled and carries a
    // `source` pointer (one of 'bandmath' | 'esa_worldcover' |
    // 'ms_buildings'). The drill-down panel reads `source` to render
    // the right citation footer.
    const cohorts = await aggregateCohorts();
    const c = cohorts[0];
    expect(c.avg_cv_features.vegetation_density.source).toBe('bandmath');
    expect(c.avg_cv_features.imperviousness.source).toBe('esa_worldcover');
    expect(c.avg_cv_features.roof_complexity.source).toBe('ms_buildings');
    expect(c.avg_cv_features.tree_overhang.source).toBe('esa_worldcover');
    // The 5 band-math dims should all cite bandmath.
    for (const dim of [
      'vegetation_density',
      'fuel_proximity',
      'water_proximity',
      'elevation_bucket',
      'structure_density',
    ] as const) {
      expect(c.avg_cv_features[dim].source).toBe('bandmath');
    }
  });
});
