// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { computeBookTotals } from '@/lib/db/book_totals';

describe('computeBookTotals', () => {
  test('returns DB-derived book scalars', async () => {
    const totals = await computeBookTotals();
    expect(totals.tiv).toBeGreaterThan(0);
    expect(totals.policies).toBeGreaterThan(0);
  });
});
