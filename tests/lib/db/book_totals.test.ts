// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { computeBookTotals } from '@/lib/db/book_totals';

describe('computeBookTotals', () => {
  test('returns the four landing scalars', async () => {
    const totals = await computeBookTotals();
    expect(totals.tiv).toBeGreaterThan(0);
    expect(totals.policies).toBeGreaterThan(0);
    expect(totals.cessionSpendYtd).toBeGreaterThanOrEqual(0);
    expect(totals.openAdvisories).toBeGreaterThanOrEqual(0);
  });
});
