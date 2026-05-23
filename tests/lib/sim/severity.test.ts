import { describe, test, expect, vi } from 'vitest';
import {
  damageRatio,
  intensityScale,
  damageMultiplier,
  severityLabel,
  legacyTier,
  severityFromLegacy,
  tornadoWidthM,
  perilLabel,
  PERIL_LABELS,
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
    expect(damageRatio('wildfire', 'manufactured', 'catastrophic')).toBe(1.0); // 0.95 * 1.45 = 1.38 → clipped
    expect(damageRatio('tornado', 'wood_frame', 'catastrophic')).toBeCloseTo(0.42 * 1.45, 4);
  });
  test('every peril × build_type has a value', () => {
    for (const peril of PERILS) {
      for (const bt of ['wood_frame', 'masonry', 'manufactured', 'commercial'] as const) {
        const v = damageRatio(peril, bt, 'severe');
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
  test('unknown build_type contributes zero (no silent wood_frame fallback)', () => {
    // The seed's `manufactured` policies used to silently fall back to wood_frame,
    // under-estimating tornado / hail / earthquake loss on ~15 % of the book.
    // Unknown build_types now contribute 0 and a console.warn is emitted.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(damageRatio('tornado', 'unknown' as unknown as 'wood_frame', 'severe')).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  test('manufactured uses the manufactured-housing HAZUS row (not wood_frame)', () => {
    // Regression for the silent mobile_home/manufactured alias bug: a
    // `manufactured` policy must use base 0.32 for hail (not 0.18 for wood_frame).
    expect(damageRatio('hail', 'manufactured', 'severe')).toBeCloseTo(0.32, 4);
    expect(damageRatio('tornado', 'manufactured', 'severe')).toBeCloseTo(0.85, 4);
    expect(damageRatio('earthquake', 'manufactured', 'severe')).toBeCloseTo(0.55, 4);
  });
});

describe('intensityScale', () => {
  test('returns the documented multipliers', () => {
    expect(intensityScale('moderate' as Intensity)).toBe(0.55);
    expect(intensityScale('severe' as Intensity)).toBe(1.00);
    expect(intensityScale('catastrophic' as Intensity)).toBe(1.45);
  });
});

describe('PERIL_LABELS', () => {
  test('has a label for every peril', () => {
    for (const p of PERILS) expect(PERIL_LABELS[p]).toBeTruthy();
  });
  test('renders winter as "Winter Storm" (industry vocabulary, not the season)', () => {
    // The peril id `winter` covers the full WSSI scope (blizzards + ice
    // storms + flash freezes + heavy snow + lake-effect). The operator-
    // facing label disambiguates from blizzard-only reading and matches
    // PCS / AIR / RMS / Verisk / Swiss Re classification.
    expect(perilLabel('winter')).toBe('Winter Storm');
    expect(PERIL_LABELS.winter).toBe('Winter Storm');
  });
  test('every other peril label is its title-cased id', () => {
    expect(perilLabel('tornado')).toBe('Tornado');
    expect(perilLabel('flood')).toBe('Flood');
    expect(perilLabel('hail')).toBe('Hail');
    expect(perilLabel('wildfire')).toBe('Wildfire');
    expect(perilLabel('earthquake')).toBe('Earthquake');
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
  test('hail is linear in stone diameter, anchored 20 mm -> 0 (damage threshold), 45 mm -> 1.0', () => {
    // Pea/dime hail (≤ 20 mm) produces no real insurance claims — the
    // model honestly returns 0 there. 45 mm = golf-ball "severe" anchor.
    expect(damageMultiplier('hail', 10)).toBe(0);
    expect(damageMultiplier('hail', 20)).toBe(0);
    expect(damageMultiplier('hail', 25)).toBeCloseTo(0.2, 6);
    expect(damageMultiplier('hail', 45)).toBeCloseTo(1.0, 6);
    expect(damageMultiplier('hail', 65)).toBeCloseTo(1.8, 6);
  });
  test('continuous multipliers return zero below their damage threshold', () => {
    // Earthquake returns 0 below Mw 5.53 — the Bakun-Wentworth zero-crossing
    // for the MMI VI shell. The previous `max(0.05, …)` floor produced
    // phantom 3.5 % wood-frame damage at M5.0 even though M5.0 quakes
    // produce essentially no filed claims. Hail returns 0 below 20 mm (NWS
    // significant-severe / IBHS shingle-damage threshold).
    expect(damageMultiplier('earthquake', 5.0)).toBe(0);
    expect(damageMultiplier('earthquake', 1.0)).toBe(0);
    // Just above the threshold the linear formula resumes.
    expect(damageMultiplier('earthquake', 6.0)).toBeCloseTo(0.55, 6);
    expect(damageMultiplier('hail', 0)).toBe(0);
  });
  test('tornado EF levels return the documented multipliers', () => {
    expect(damageMultiplier('tornado', 'ef0')).toBe(0.325);
    expect(damageMultiplier('tornado', 'ef3')).toBe(1.0);
    expect(damageMultiplier('tornado', 'ef5')).toBe(1.45);
  });
  test('winter spans the five WSSI multipliers (recalibrated off the legacy spine)', () => {
    // WSSI's own definitions ("Minor" = minor inconveniences; "Extreme" =
    // widespread severe property damage) anchor the recalibration:
    //   - Limited 0.01 — nuisance noise floor
    //   - Minor 0.04 — pipe-burst-only events (0.2-0.5 % mean DR)
    //   - Moderate 0.15 — claim rates 5-15 %, sub-billion industry signal
    //   - Major 0.40 — 2014 NE ice-storm class
    //   - Extreme 1.00 — TX 2021 Uri / Buffalo 2014 (HAZUS-severe anchor)
    expect(damageMultiplier('winter', 'limited')).toBe(0.01);
    expect(damageMultiplier('winter', 'minor')).toBe(0.04);
    expect(damageMultiplier('winter', 'moderate')).toBe(0.15);
    expect(damageMultiplier('winter', 'major')).toBe(0.40);
    expect(damageMultiplier('winter', 'extreme')).toBe(1.00);
  });
  test('flood multipliers are recalibrated off the legacy spine', () => {
    // NWS Minor / Moderate / Major mapped 1:1 onto INTENSITY_SCALE produced
    // 30 % wood-frame damage on nuisance floods — HAZUS-severe-territory
    // damage from < 1 ft inundation. Recalibrated against NFIP claim
    // depth-damage curves so minor is nuisance flooding, major caps at
    // multi-floor / pile-supported loss.
    expect(damageMultiplier('flood', 'minor')).toBe(0.25);
    expect(damageMultiplier('flood', 'moderate')).toBe(0.70);
    expect(damageMultiplier('flood', 'major')).toBe(1.20);
  });
  test('wildfire multipliers reflect dNBR semantics (not legacy spine)', () => {
    // dNBR low means minimal structural impact — the previous 0.55 multiplier
    // (1:1 spine relabel) produced 50.6 % wood-frame damage from a burn that
    // by definition didn't significantly damage structures. dNBR high IS
    // HAZUS-severe (sustained crown fire), so high = 1.00.
    expect(damageMultiplier('wildfire', 'low')).toBe(0.10);
    expect(damageMultiplier('wildfire', 'moderate')).toBe(0.40);
    expect(damageMultiplier('wildfire', 'high')).toBe(1.00);
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
    // Legacy "moderate" flood now maps to the new NWS "moderate" tier
    // (multiplier 0.70, closest to INTENSITY_SCALE.moderate = 0.55) rather
    // than "minor" — the recalibration decoupled flood from the legacy
    // spine, so closest-multiplier search picks the new mid-tier.
    expect(severityFromLegacy('flood', 'moderate')).toBe('moderate');
    // Legacy "severe" wildfire maps to dNBR "high" — the only tier on the
    // recalibrated wildfire scale that produces HAZUS-severe damage.
    expect(severityFromLegacy('wildfire', 'severe')).toBe('high');
  });
  test('round-trips through legacyTier for spine-anchored perils', () => {
    // Tornado, hail, earthquake keep their multipliers anchored to the
    // legacy spine; the round-trip property still holds for them.
    const spinePerils: Peril[] = ['tornado', 'hail', 'earthquake'];
    for (const peril of spinePerils) {
      for (const tier of ['moderate', 'severe', 'catastrophic'] as const) {
        expect(legacyTier(peril, severityFromLegacy(peril, tier))).toBe(tier);
      }
    }
  });
  test('legacy catastrophic on wildfire/flood/winter is intentionally lossy', () => {
    // The recalibrated wildfire, flood, and winter scales cap below the
    // legacy catastrophic multiplier of 1.45 — that's the point of the fix:
    //   - dNBR has no "catastrophic" class beyond "high"
    //   - NFIP "Major" already covers multi-floor inundation
    //   - WSSI "Extreme" matches HAZUS-severe (multiplier 1.0), not
    //     catastrophic — real Uri/Buffalo events produced 5-15 % mean DR,
    //     not the 1.45 × HAZUS-severe damage the old spine map implied
    // Legacy "catastrophic" footprints map to the maximum new tier, but
    // round-tripping back lands one tier shy of catastrophic.
    expect(severityFromLegacy('wildfire', 'catastrophic')).toBe('high');
    expect(legacyTier('wildfire', severityFromLegacy('wildfire', 'catastrophic'))).toBe('severe');
    expect(severityFromLegacy('flood', 'catastrophic')).toBe('major');
    expect(legacyTier('flood', severityFromLegacy('flood', 'catastrophic'))).toBe('severe');
    expect(severityFromLegacy('winter', 'catastrophic')).toBe('extreme');
    expect(legacyTier('winter', severityFromLegacy('winter', 'catastrophic'))).toBe('severe');
  });
  test('winter moderate and severe still round-trip via closest-multiplier', () => {
    // Legacy "moderate" winter (m=0.55) → closest is new "major" (0.40)
    // → legacyTier(0.40) = 'moderate' ✓
    // Legacy "severe" winter (m=1.0) → closest is new "extreme" (1.00)
    // → legacyTier(1.00) = 'severe' ✓
    // Only catastrophic is lossy (above).
    expect(severityFromLegacy('winter', 'moderate')).toBe('major');
    expect(legacyTier('winter', severityFromLegacy('winter', 'moderate'))).toBe('moderate');
    expect(severityFromLegacy('winter', 'severe')).toBe('extreme');
    expect(legacyTier('winter', severityFromLegacy('winter', 'severe'))).toBe('severe');
  });
});

describe('tornadoWidthM', () => {
  test('returns the Brooks 2004 path width for an EF level', () => {
    expect(tornadoWidthM('ef0')).toBe(30);
    expect(tornadoWidthM('ef3')).toBe(240);
    expect(tornadoWidthM('ef5')).toBe(550);
  });
});

describe('damageRatio with per-peril severity', () => {
  test('a continuous severity drives the ratio (hail 45 mm -> multiplier 1.0)', () => {
    expect(damageRatio('hail', 'wood_frame', 45)).toBeCloseTo(0.18, 4);
  });
  test('sub-threshold hail (≤ 20 mm) produces zero damage on every build type', () => {
    // Real pea/dime hail produces no insurance claims. Regression against the
    // pre-recalibration linear-extrapolation formula that claimed 10 mm hail
    // damaged wood frame at 0.038 (multiplier 0.2125 × base 0.18).
    for (const bt of ['wood_frame', 'masonry', 'manufactured', 'commercial'] as const) {
      expect(damageRatio('hail', bt, 10)).toBe(0);
      expect(damageRatio('hail', bt, 20)).toBe(0);
    }
  });
  test('a discrete severity drives the ratio (tornado EF1 -> multiplier 0.55)', () => {
    expect(damageRatio('tornado', 'wood_frame', 'ef1')).toBeCloseTo(0.42 * 0.55, 4);
  });
  test('a legacy tier string still resolves via the fallback', () => {
    expect(damageRatio('tornado', 'wood_frame', 'severe')).toBeCloseTo(0.42, 4);
  });
});
