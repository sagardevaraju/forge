// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { renderRecommendation } from '@/lib/portfolio/narrative';

describe('renderRecommendation', () => {
  test('summarizes a single dominant action', () => {
    const r = renderRecommendation([
      { cohort_id: '337_wood_frame_q3', retain: 0, reprice_up: 0.95, reprice_down: 0, non_renew: 0, cede_qs: 0, cede_xs: 0.05, dominant_action: 'reprice_up', dominant_share: 0.95 },
    ]);
    expect(r).toMatch(/reprice up/i);
    expect(r).toMatch(/337_wood_frame_q3/);
  });
  test('counts multi-cohort recommendations by dominant action', () => {
    const r = renderRecommendation([
      { cohort_id: 'a', dominant_action: 'reprice_up', dominant_share: 0.9 } as any,
      { cohort_id: 'b', dominant_action: 'reprice_up', dominant_share: 0.8 } as any,
      { cohort_id: 'c', dominant_action: 'cede_xs',    dominant_share: 0.6 } as any,
    ]);
    expect(r).toMatch(/reprice up 2 cohort/i);
    expect(r).toMatch(/cede.*1/i);
  });
});
