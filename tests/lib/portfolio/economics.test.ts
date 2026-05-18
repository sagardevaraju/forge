// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { ECONOMICS_TABLE } from '@/lib/portfolio/economics';

describe('ECONOMICS_TABLE', () => {
  test('lists all eleven P2.8 actions with reprice/loss/cession constants', () => {
    for (const action of [
      'retain',
      'reprice_n20',
      'reprice_n10',
      'reprice_0',
      'reprice_p5',
      'reprice_p10',
      'reprice_p15',
      'reprice_p20',
      'non_renew',
      'cede_qs',
      'cede_xs',
    ] as const) {
      const row = ECONOMICS_TABLE[action];
      expect(typeof row.reprice).toBe('number');
      expect(typeof row.loss).toBe('number');
      expect(typeof row.cession).toBe('number');
      expect(row.source).toMatch(/optimize_portfolio\.py/);
    }
  });
});
