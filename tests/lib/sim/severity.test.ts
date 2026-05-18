import { describe, test, expect } from 'vitest';
import {
  damageRatio,
  intensityScale,
  PERILS,
  type Peril,
  type Intensity,
} from '@/lib/sim/severity';

describe('damageRatio', () => {
  test('returns the HAZUS reference value at severe intensity', () => {
    expect(damageRatio('tornado', 'wood_frame', 'severe')).toBeCloseTo(0.42, 4);
    expect(damageRatio('hail', 'masonry', 'severe')).toBeCloseTo(0.10, 4);
  });
  test('moderate scales the row by 0.55', () => {
    expect(damageRatio('tornado', 'wood_frame', 'moderate')).toBeCloseTo(0.42 * 0.55, 4);
  });
  test('catastrophic scales by 1.45 then clips at 1.0', () => {
    expect(damageRatio('wildfire', 'mobile_home', 'catastrophic')).toBe(1.0); // 0.95 * 1.45 = 1.38 → clipped
    expect(damageRatio('tornado', 'wood_frame', 'catastrophic')).toBeCloseTo(0.42 * 1.45, 4);
  });
  test('every peril × build_type has a value', () => {
    for (const peril of PERILS) {
      for (const bt of ['wood_frame', 'masonry', 'mobile_home', 'commercial'] as const) {
        const v = damageRatio(peril, bt, 'severe');
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
  test('unknown build_type falls back to wood_frame', () => {
    expect(damageRatio('tornado', 'unknown' as any, 'severe')).toBe(damageRatio('tornado', 'wood_frame', 'severe'));
  });
});

describe('intensityScale', () => {
  test('returns the documented multipliers', () => {
    expect(intensityScale('moderate' as Intensity)).toBe(0.55);
    expect(intensityScale('severe' as Intensity)).toBe(1.00);
    expect(intensityScale('catastrophic' as Intensity)).toBe(1.45);
  });
});
