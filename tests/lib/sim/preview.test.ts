// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { previewImpact, type Policy } from '@/lib/sim/preview';

const TAMPA_POLY: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[[-82.5, 27.5], [-82, 27.5], [-82, 28], [-82.5, 28], [-82.5, 27.5]]],
};

const POLICIES: Policy[] = [
  { id: 1, lat: 27.7, lon: -82.3, tiv: 500_000, build_type: 'wood_frame', zip3: '337' },     // inside
  { id: 2, lat: 27.8, lon: -82.2, tiv: 800_000, build_type: 'masonry',    zip3: '337' },     // inside
  { id: 3, lat: 30.0, lon: -85.0, tiv: 400_000, build_type: 'mobile_home', zip3: '325' },    // outside
];

describe('previewImpact', () => {
  test('inside-polygon policies aggregate into estimated loss', () => {
    const result = previewImpact(POLICIES, {
      peril: 'hail',
      intensity: 'severe',
      severity: 45,
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    });
    expect(result.policies_in_footprint).toBe(2);
    expect(result.tiv_in_footprint).toBe(1_300_000);
    // 500k * 0.18 + 800k * 0.10 = 90k + 80k = 170k
    expect(result.gross_loss_estimate).toBeCloseTo(170_000, 0);
    expect(result.cohorts_affected).toBeGreaterThan(0);
  });
  test('empty polygon returns zeros', () => {
    const result = previewImpact([], {
      peril: 'hail',
      intensity: 'severe',
      severity: 45,
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    });
    expect(result.policies_in_footprint).toBe(0);
    expect(result.gross_loss_estimate).toBe(0);
  });
  test('top_cohorts is sorted by loss descending', () => {
    const result = previewImpact(POLICIES, {
      peril: 'hail',
      intensity: 'severe',
      severity: 45,
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    });
    for (let i = 1; i < result.top_cohorts.length; i++) {
      expect(result.top_cohorts[i].loss).toBeLessThanOrEqual(result.top_cohorts[i - 1].loss);
    }
  });
});

describe('previewImpact honours per-peril severity', () => {
  test('a higher hail diameter produces a larger gross loss', () => {
    const base = {
      peril: 'hail' as const,
      intensity: 'severe' as const,
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    };
    const small = previewImpact(POLICIES, { ...base, severity: 25 });
    const large = previewImpact(POLICIES, { ...base, severity: 90 });
    expect(large.gross_loss_estimate).toBeGreaterThan(small.gross_loss_estimate);
  });
});
