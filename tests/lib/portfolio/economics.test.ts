// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { ECONOMICS_TABLE } from '@/lib/portfolio/economics';

describe('ECONOMICS_TABLE', () => {
  test('lists all six actions with reprice/loss/cession constants', () => {
    for (const action of ['retain', 'reprice_up', 'reprice_down', 'non_renew', 'cede_qs', 'cede_xs'] as const) {
      const row = ECONOMICS_TABLE[action];
      expect(typeof row.reprice).toBe('number');
      expect(typeof row.loss).toBe('number');
      expect(typeof row.cession).toBe('number');
      expect(row.source).toMatch(/optimize_portfolio\.py/);
    }
  });
});
