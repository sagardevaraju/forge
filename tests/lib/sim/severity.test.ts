import { describe, test, expect } from 'vitest';
import {
  damageRatio,
  intensityScale,
  damageMultiplier,
  severityLabel,
  legacyTier,
  severityFromLegacy,
  tornadoWidthM,
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

describe('damageMultiplier', () => {
  test('earthquake is linear in Mw, anchored M6/M7/M8 -> 0.55/1.0/1.45', () => {
    expect(damageMultiplier('earthquake', 6.0)).toBeCloseTo(0.55, 6);
    expect(damageMultiplier('earthquake', 7.0)).toBeCloseTo(1.0, 6);
    expect(damageMultiplier('earthquake', 8.0)).toBeCloseTo(1.45, 6);
  });
  test('hail is linear in stone diameter, anchored 25 mm -> 0.55, 45 mm -> 1.0', () => {
    expect(damageMultiplier('hail', 25)).toBeCloseTo(0.55, 6);
    expect(damageMultiplier('hail', 45)).toBeCloseTo(1.0, 6);
  });
  test('continuous multipliers clamp at a 0.05 floor', () => {
    expect(damageMultiplier('earthquake', 1.0)).toBe(0.05);
  });
  test('tornado EF levels return the documented multipliers', () => {
    expect(damageMultiplier('tornado', 'ef0')).toBe(0.325);
    expect(damageMultiplier('tornado', 'ef3')).toBe(1.0);
    expect(damageMultiplier('tornado', 'ef5')).toBe(1.45);
  });
  test('winter spans the five WSSI multipliers', () => {
    expect(damageMultiplier('winter', 'limited')).toBe(0.325);
    expect(damageMultiplier('winter', 'extreme')).toBe(1.90);
  });
  test('falls back to the legacy tier scale for a tier string', () => {
    expect(damageMultiplier('tornado', 'severe')).toBe(1.0);
    expect(damageMultiplier('hail', 'moderate')).toBe(0.55);
    expect(damageMultiplier('earthquake', 'catastrophic')).toBe(1.45);
  });
});

describe('severityLabel', () => {
  test('formats continuous values', () => {
    expect(severityLabel('earthquake', 7.2)).toBe('M7.2');
    expect(severityLabel('hail', 45)).toBe('45 mm');
  });
  test('returns the level label for discrete values', () => {
    expect(severityLabel('tornado', 'ef3')).toBe('EF3');
    expect(severityLabel('winter', 'extreme')).toBe('Extreme');
  });
});

describe('legacyTier', () => {
  test('buckets a severity value into the nearest legacy tier', () => {
    expect(legacyTier('earthquake', 7.0)).toBe('severe');
    expect(legacyTier('earthquake', 5.5)).toBe('moderate');
    expect(legacyTier('earthquake', 9.0)).toBe('catastrophic');
    expect(legacyTier('tornado', 'ef0')).toBe('moderate');
    expect(legacyTier('tornado', 'ef5')).toBe('catastrophic');
  });
});

describe('severityFromLegacy', () => {
  test('derives a representative severity from a legacy tier', () => {
    expect(severityFromLegacy('earthquake', 'severe')).toBe(7.0);
    expect(severityFromLegacy('hail', 'severe')).toBe(45);
    expect(severityFromLegacy('tornado', 'severe')).toBe('ef3');
    expect(severityFromLegacy('flood', 'moderate')).toBe('minor');
  });
  test('round-trips through legacyTier for every peril and tier', () => {
    for (const peril of PERILS) {
      for (const tier of ['moderate', 'severe', 'catastrophic'] as const) {
        expect(legacyTier(peril, severityFromLegacy(peril, tier))).toBe(tier);
      }
    }
  });
});

describe('tornadoWidthM', () => {
  test('returns the Brooks 2004 path width for an EF level', () => {
    expect(tornadoWidthM('ef0')).toBe(30);
    expect(tornadoWidthM('ef3')).toBe(240);
    expect(tornadoWidthM('ef5')).toBe(550);
  });
});
