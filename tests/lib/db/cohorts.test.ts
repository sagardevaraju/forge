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

  test('every cohort has 8-dim avg_cv_features', async () => {
    const cohorts = await aggregateCohorts();
    for (const c of cohorts) {
      expect(c.avg_cv_features).toHaveLength(8);
      for (const f of c.avg_cv_features) expect(f).toBeGreaterThanOrEqual(0);
      for (const f of c.avg_cv_features) expect(f).toBeLessThanOrEqual(1);
    }
  });

  test('policy_count across cohorts sums to 10000', async () => {
    const cohorts = await aggregateCohorts();
    expect(cohorts.reduce((s, c) => s + c.policy_count, 0)).toBe(10000);
  });
});
