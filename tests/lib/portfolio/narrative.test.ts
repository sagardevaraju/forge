// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { renderRecommendation } from '@/lib/portfolio/narrative';

describe('renderRecommendation', () => {
  test('summarizes a single dominant action', () => {
    // P2.8 rewrite: dominant_action moved from the legacy `reprice_up`
    // scalar to a discretized rate-grid action (`reprice_p10` = +10%
    // rate move). The narrative renderer simply lowercases the label,
    // so the assertion now checks for the rendered label form
    // ("reprice +10%") rather than the bare key.
    const r = renderRecommendation([
      {
        cohort_id: '337_wood_frame_q3',
        retain: 0,
        reprice_n20: 0,
        reprice_n10: 0,
        reprice_0: 0,
        reprice_p5: 0,
        reprice_p10: 0.95,
        reprice_p15: 0,
        reprice_p20: 0,
        non_renew: 0,
        cede_qs: 0,
        cede_xs: 0.05,
        dominant_action: 'reprice_p10',
        dominant_share: 0.95,
      },
    ]);
    expect(r).toMatch(/reprice \+10%/i);
    expect(r).toMatch(/337_wood_frame_q3/);
  });
  test('counts multi-cohort recommendations by dominant action', () => {
    const r = renderRecommendation([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { cohort_id: 'a', dominant_action: 'reprice_p10', dominant_share: 0.9 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { cohort_id: 'b', dominant_action: 'reprice_p10', dominant_share: 0.8 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { cohort_id: 'c', dominant_action: 'cede_xs',     dominant_share: 0.6 } as any,
    ]);
    expect(r).toMatch(/reprice \+10% 2 cohort/i);
    expect(r).toMatch(/cede.*1/i);
  });
});
