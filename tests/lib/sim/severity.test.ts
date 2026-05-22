import { describe, test, expect } from 'vitest';
import {
  damageRatio,
  intensityScale,
  PERILS,
  PERIL_SCALES,
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

describe('PERIL_SCALES', () => {
  test('has an entry for every peril', () => {
    for (const p of PERILS) expect(PERIL_SCALES[p]).toBeDefined();
  });
  test('earthquake and hail are continuous; the rest are discrete', () => {
    expect(PERIL_SCALES.earthquake.kind).toBe('continuous');
    expect(PERIL_SCALES.hail.kind).toBe('continuous');
    for (const p of ['tornado', 'flood', 'wildfire', 'winter'] as const) {
      expect(PERIL_SCALES[p].kind).toBe('discrete');
    }
  });
  test('the earthquake slider spans Mw 5.0-9.0 with a 7.0 default', () => {
    const s = PERIL_SCALES.earthquake;
    if (s.kind !== 'continuous') throw new Error('expected continuous');
    expect([s.min, s.max, s.step, s.default]).toEqual([5.0, 9.0, 0.1, 7.0]);
  });
  test('tornado has six EF levels, each carrying a Brooks-2004 width_m', () => {
    const t = PERIL_SCALES.tornado;
    if (t.kind !== 'discrete') throw new Error('expected discrete');
    expect(t.levels.map((l) => l.id)).toEqual(['ef0', 'ef1', 'ef2', 'ef3', 'ef4', 'ef5']);
    expect(t.levels.map((l) => l.width_m)).toEqual([30, 60, 120, 240, 480, 550]);
    expect(t.default).toBe('ef3');
  });
  test('winter has the five WSSI loss-bearing categories', () => {
    const w = PERIL_SCALES.winter;
    if (w.kind !== 'discrete') throw new Error('expected discrete');
    expect(w.levels.map((l) => l.id)).toEqual(['limited', 'minor', 'moderate', 'major', 'extreme']);
  });
});
