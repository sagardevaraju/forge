// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { computeBookTotals, getBookStates } from '@/lib/db/book_totals';

describe('computeBookTotals', () => {
  test('returns DB-derived book scalars', async () => {
    const totals = await computeBookTotals();
    expect(totals.tiv).toBeGreaterThan(0);
    expect(totals.policies).toBeGreaterThan(0);
  });
});

describe('getBookStates', () => {
  test('returns distinct uppercased state codes', async () => {
    const states = await getBookStates();
    // Seed ships 38 ZIP3s across the US South — at least FL is always
    // present. Empty array is also valid (fresh-clone DB with no policies
    // seeded yet), but in that case computeBookTotals would have failed
    // first; this test runs after the seed.
    expect(Array.isArray(states)).toBe(true);
    for (const s of states) {
      expect(s).toMatch(/^[A-Z]{2}$/);
    }
    if (states.length > 0) {
      // Sorted ascending and unique — the SELECT applies ORDER BY state
      // and DISTINCT guarantees uniqueness.
      const sorted = [...states].sort();
      expect(states).toEqual(sorted);
      expect(new Set(states).size).toBe(states.length);
    }
  });
});
