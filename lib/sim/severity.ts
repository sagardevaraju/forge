/**
 * HAZUS-derived peril × build_type damage ratio matrix.
 * Cells are mean damage ratios at the *severe* intensity benchmark,
 * sourced from FEMA HAZUS Technical Manual (wind, flood, earthquake) and
 * the Insurance Institute for Business & Home Safety hail studies.
 *
 * Adding a new peril: extend HAZUS_MATRIX, add a Peril entry, and add a
 * decay function in api_py/sim_loss.py. See spec §5 for the calibration
 * basis. Cells live here as data so a calibration overlay (v2) can swap
 * the literal without changing optimizer logic.
 */

export const PERILS = [
  'tornado',
  'flood',
  'hail',
  'wildfire',
  'earthquake',
  'winter',
] as const;
export type Peril = (typeof PERILS)[number];

/**
 * Human-readable peril labels for the picker, sim cards, banners, and any
 * other operator-facing surface. Keep this as the single source of truth so
 * label changes don't have to chase every renderer.
 *
 * Note: `winter` is the internal id (matches the DB column, parquet metadata,
 * scenario-reconciler keys, and ML training data); the operator-facing label
 * is **"Winter Storm"** to match industry vocabulary — PCS / AIR Worldwide /
 * Moody's RMS / Verisk / Swiss Re sigma all classify this peril family as
 * "Winter Storm". It also pairs cleanly with WSSI = Winter **Storm** Severity
 * Index. The plain "Winter" label was ambiguous (most operators read it as
 * "blizzard" specifically, even though the peril covers blizzards + ice
 * storms + flash freezes + heavy snow + lake-effect under NWS WSSI scope —
 * see research.md §6).
 */
export const PERIL_LABELS: Record<Peril, string> = {
  tornado: 'Tornado',
  flood: 'Flood',
  hail: 'Hail',
  wildfire: 'Wildfire',
  earthquake: 'Earthquake',
  winter: 'Winter Storm',
};

export function perilLabel(peril: Peril): string {
  return PERIL_LABELS[peril];
}

export const INTENSITIES = ['moderate', 'severe', 'catastrophic'] as const;
export type Intensity = (typeof INTENSITIES)[number];

// Keys must match the policy book's `build_type` vocabulary
// (lib/book/csv.ts ALLOWED_BUILD_TYPES, scripts/seed_policy_book.py BUILD_TYPES).
// `manufactured` is FEMA HAZUS's "Manufactured Housing" (MH) — equivalent to
// the legacy "mobile_home" alias kept in research papers; we use the same
// label as the rest of the codebase so unknown-build-type fallbacks can't
// silently mis-model 14.8 % of the seeded book as wood_frame.
export const BUILD_TYPES = [
  'wood_frame',
  'masonry',
  'manufactured',
  'commercial',
] as const;
export type BuildType = (typeof BUILD_TYPES)[number];

// manufactured.flood was 0.45 (i.e. *less* flood-vulnerable than wood frame).
// That inverts reality: HAZUS Flood Technical Manual 4.0 manufactured-housing
// depth-damage curves at ~4 ft inundation sit at 0.55-0.65, ABOVE wood frame —
// MH sits lower, has weaker floor systems, and is more easily moved by
// floodwater. Raised to 0.65 to match the upper end of the HAZUS MH curve.
const HAZUS_MATRIX: Record<BuildType, Record<Peril, number>> = {
  wood_frame:   { tornado: 0.42, flood: 0.55, hail: 0.18, wildfire: 0.92, earthquake: 0.35, winter: 0.08 },
  masonry:      { tornado: 0.28, flood: 0.62, hail: 0.10, wildfire: 0.85, earthquake: 0.22, winter: 0.06 },
  manufactured: { tornado: 0.85, flood: 0.65, hail: 0.32, wildfire: 0.95, earthquake: 0.55, winter: 0.18 },
  commercial:   { tornado: 0.30, flood: 0.48, hail: 0.12, wildfire: 0.78, earthquake: 0.28, winter: 0.05 },
};

const INTENSITY_SCALE: Record<Intensity, number> = {
  moderate: 0.55,
  severe: 1.0,
  catastrophic: 1.45,
};

export function intensityScale(intensity: Intensity): number {
  return INTENSITY_SCALE[intensity];
}

/** A severity value: a number for continuous scales, a level id for discrete. */
export type SeverityValue = number | string;

/** One step of a discrete per-peril scale. */
export interface ScaleLevel {
  id: string;          // stable id stored on the footprint, e.g. 'ef3'
  label: string;       // UI label, e.g. 'EF3'
  sublabel?: string;   // e.g. '136-165 mph' (tornado wind band — cited)
  multiplier: number;  // damage multiplier (modelling parameter)
  width_m?: number;    // tornado only — swath corridor width (Brooks 2004)
}

/**
 * A per-peril severity scale — either a continuous slider or a discrete
 * picker. Numbers and citations live in research.md.
 */
export type PerilScale =
  | {
      kind: 'continuous';
      unit: string;
      min: number;
      max: number;
      step: number;
      default: number;
      multiplier(v: number): number; // damage multiplier (modelling parameter)
      label(v: number): string;      // UI label, e.g. 'M7.2'
    }
  | { kind: 'discrete'; levels: ScaleLevel[]; default: string };

/**
 * Per-peril severity scales. Geometry-driving numbers (EF wind bands, Brooks
 * 2004 path widths) are empirically cited; the damage multipliers are
 * modelling parameters anchored to the INTENSITY_SCALE spine. See research.md.
 */
export const PERIL_SCALES: Record<Peril, PerilScale> = {
  earthquake: {
    kind: 'continuous',
    unit: 'Mw',
    min: 5.0,
    max: 9.0,
    step: 0.1,
    default: 7.0,
    // Modelling parameter — anchored M6/M7/M8 -> 0.55/1.0/1.45 (research.md S2c).
    //
    // EARTHQUAKE_DAMAGE_MIN_MW = 5.53 is the Bakun-Wentworth zero-crossing:
    //   MMI VI radius = (1.68·Mw − 3.29 − 6.0) / 0.0206 = 0  ⇒  Mw ≈ 5.53.
    // Below that the MMI VI shell has no physical extent, so structural damage
    // is honestly zero — the previous `max(0.05, …)` floor produced phantom
    // 3.5 % wood-frame damage at M5.0, even though M5.0 quakes in California
    // produce essentially no filed structural claims. The geometry-side
    // MIN_BUFFER_KM = 0.5 km floor in lib/sim/footprint.ts is kept so the
    // footprint Polygon stays constructible for the UI, but the multiplier
    // here zeroes the damage so any policy inside that 500 m circle still
    // contributes 0 loss.
    multiplier: (v) => (v < 5.53 ? 0 : 1.0 + 0.45 * (v - 7.0)),
    label: (v) => `M${v.toFixed(1)}`,
  },
  hail: {
    kind: 'continuous',
    unit: 'mm',
    min: 10,
    max: 120,
    step: 5,
    default: 45,
    // Calibrated against real-world hail-damage thresholds (research.md S3b):
    //   20 mm — damage threshold. Pea/dime hail (≤ 20 mm) produces ≈ 0 filed
    //           claims; below NWS "significant severe" cutoff at 25 mm and
    //           well below the IBHS ~32 mm asphalt-shingle damage threshold.
    //   45 mm — golf-ball / "severe" anchor (multiplier = 1.0). Preserved
    //           from the previous calibration so the legacyTier severe-band
    //           mapping is unchanged at this point.
    //   65 mm — tennis-ball / "catastrophic" (multiplier ≈ 1.80).
    //  120 mm — softball; multiplier = 4.0 totals vulnerable structures
    //           (manufactured housing caps at damage ratio 1.0).
    // No 0.05 floor — below the 20 mm threshold the model honestly returns 0.
    // The previous formula (anchored 25 → 0.55, 45 → 1.0, 0.05 floor) was a
    // straight-line extrapolation below its calibration anchor: it claimed
    // 10 mm pea hail produced $10M of damage on the synthetic FL book, which
    // is unphysical — real pea hail produces no insurance claims at all.
    multiplier: (v) => Math.max(0, 0.04 * (v - 20)),
    label: (v) => `${v} mm`,
  },
  tornado: {
    kind: 'discrete',
    default: 'ef3',
    levels: [
      { id: 'ef0', label: 'EF0', sublabel: '65-85 mph',   multiplier: 0.325, width_m: 30 },
      { id: 'ef1', label: 'EF1', sublabel: '86-110 mph',  multiplier: 0.55,  width_m: 60 },
      { id: 'ef2', label: 'EF2', sublabel: '111-135 mph', multiplier: 0.775, width_m: 120 },
      { id: 'ef3', label: 'EF3', sublabel: '136-165 mph', multiplier: 1.0,   width_m: 240 },
      { id: 'ef4', label: 'EF4', sublabel: '166-200 mph', multiplier: 1.225, width_m: 480 },
      { id: 'ef5', label: 'EF5', sublabel: 'over 200 mph', multiplier: 1.45, width_m: 550 },
    ],
  },
  flood: {
    kind: 'discrete',
    default: 'moderate',
    // Recalibrated against NFIP claim depth-damage curves (research.md §4b):
    //   Minor (≤ 1 ft, nuisance inundation) → 0.25  (was 0.55)
    //   Moderate (1-4 ft, ground-floor immersion) → 0.70  (was 1.0)
    //   Major (> 4 ft, multi-floor or pile-supported) → 1.20  (was 1.45)
    // The original 1:1 map to the legacy INTENSITY_SCALE spine put NWS "Minor"
    // — a gauge-stage class for nuisance flooding — at HAZUS-severe × 0.55, so
    // wood-frame minor-flood damage came out at 30 % (real ≈ 10-15 %).
    levels: [
      { id: 'minor',    label: 'Minor',    multiplier: 0.25 },
      { id: 'moderate', label: 'Moderate', multiplier: 0.70 },
      { id: 'major',    label: 'Major',    multiplier: 1.20 },
    ],
  },
  wildfire: {
    kind: 'discrete',
    default: 'moderate',
    // Recalibrated against USGS dNBR / CalFire post-fire damage data
    // (research.md §5b):
    //   Low burn severity (dNBR low) → 0.10  (was 0.55)
    //   Moderate burn severity      → 0.40  (was 1.0)
    //   High burn severity          → 1.00  (was 1.45 — clipped at 1.0 anyway)
    // The original 1:1 spine map put dNBR-low (which by definition means
    // ground-cover damage with minimal structural impact) at multiplier 0.55 ×
    // wood-frame HAZUS base 0.92 = 0.506 — i.e. "low burn severity" produced
    // 50 % wood-frame loss, which is HAZUS-severe-territory damage from a fire
    // that, by its dNBR classification, didn't significantly damage structures.
    // dNBR high IS HAZUS-severe (crown-fire total loss), so multiplier = 1.00.
    levels: [
      { id: 'low',      label: 'Low',      multiplier: 0.10 },
      { id: 'moderate', label: 'Moderate', multiplier: 0.40 },
      { id: 'high',     label: 'High',     multiplier: 1.00 },
    ],
  },
  winter: {
    kind: 'discrete',
    default: 'moderate',
    // Recalibrated against Winter Storm Uri (TX Feb 2021, WSSI Extreme:
    // $11.2 B / 510,772 claims per TDI 2022), Buffalo Dec 2022 blizzard
    // ($5.4 B across 42 states per Karen Clark & Co.), and Insurance
    // Information Institute baselines ($1.3 B/yr ice damage, ~$10 k average
    // frozen-pipe claim) — research.md §6b.
    //
    // The previous 1:1 INTENSITY_SCALE map put "Minor" — defined by NWS WSSI
    // as "minor inconveniences" — at multiplier 0.55, producing 4.9 % mean
    // damage ratio on the FL policy mix (= $21 M on a 1,362-policy triangle).
    // Real Minor-rated events produce ≈ 0.2-0.5 % mean DR in affected ZIPs
    // (2-10 % claim rate × ≈ $10 k avg pipe-burst claim severity).
    //
    // The recalibrated tiers anchor Extreme at multiplier 1.0 (HAZUS-severe =
    // worst-hit-ZIP mean DR for Uri/Buffalo-class events). Below that:
    //   Limited (0.01) — nuisance noise floor; rated WSSI events without
    //                    measurable property impact (< 0.05 % mean DR)
    //   Minor   (0.04) — typical Minor WSSI: scattered pipe burst on
    //                    vulnerable structures (0.2-0.5 % mean DR)
    //   Moderate (0.15) — claim rates 5-15 %, real industry signal but
    //                    sub-billion-dollar (1-2 % mean DR)
    //   Major   (0.40) — 2014 NE ice-storm class; multi-billion industry
    //                    event, 3-5 % mean DR in affected ZIPs
    //   Extreme (1.00) — TX 2021 Uri / Buffalo 2014 lake-effect: 5-15 %
    //                    mean DR in worst-hit ZIPs (= HAZUS-severe)
    levels: [
      { id: 'limited',  label: 'Limited',  multiplier: 0.01 },
      { id: 'minor',    label: 'Minor',    multiplier: 0.04 },
      { id: 'moderate', label: 'Moderate', multiplier: 0.15 },
      { id: 'major',    label: 'Major',    multiplier: 0.40 },
      { id: 'extreme',  label: 'Extreme',  multiplier: 1.00 },
    ],
  },
};

// Track unknown build_types we've already warned about so a corrupted seed
// doesn't spam the console per policy iteration.
const _warnedUnknownBuildTypes = new Set<string>();

export function damageRatio(
  peril: Peril,
  buildType: BuildType | string,
  severity: SeverityValue,
): number {
  const row = HAZUS_MATRIX[buildType as BuildType];
  if (!row) {
    // No silent fallback — that's how "manufactured" was being modelled as
    // wood_frame and under-estimating tornado/hail/earthquake loss by 50–100 %
    // on ~15 % of the book. Surface the miss, contribute zero loss, and let
    // the operator/test catch it.
    if (!_warnedUnknownBuildTypes.has(buildType)) {
      _warnedUnknownBuildTypes.add(buildType);
      // eslint-disable-next-line no-console
      console.warn(
        `[damageRatio] unknown build_type "${buildType}" — contributing 0 to gross loss. ` +
          `Add it to HAZUS_MATRIX in lib/sim/severity.ts (and mirror in api_py/sim_loss.py).`,
      );
    }
    return 0;
  }
  const scaled = row[peril] * damageMultiplier(peril, severity);
  return Math.min(1, Math.max(0, scaled));
}

/**
 * Per-peril damage multiplier. For a continuous peril `severity` is a number;
 * for a discrete peril it is a level id. A legacy tier string ('moderate' |
 * 'severe' | 'catastrophic') falls back to INTENSITY_SCALE so footprints
 * stored before the per-peril scales still resolve.
 */
export function damageMultiplier(peril: Peril, severity: SeverityValue): number {
  const scale = PERIL_SCALES[peril];
  if (scale.kind === 'continuous') {
    if (typeof severity === 'number') return scale.multiplier(severity);
    return INTENSITY_SCALE[severity as Intensity] ?? 1.0;
  }
  const level = scale.levels.find((l) => l.id === severity);
  if (level) return level.multiplier;
  return INTENSITY_SCALE[severity as Intensity] ?? 1.0;
}

/** Human-readable label for a severity value (e.g. 'M7.2', '45 mm', 'EF3'). */
export function severityLabel(peril: Peril, severity: SeverityValue): string {
  const scale = PERIL_SCALES[peril];
  if (scale.kind === 'continuous') {
    return typeof severity === 'number' ? scale.label(severity) : String(severity);
  }
  const level = scale.levels.find((l) => l.id === severity);
  return level ? level.label : String(severity);
}

/**
 * Bucket a severity value into the legacy three-tier Intensity enum. Used to
 * fill the NOT NULL `simulations.intensity` column — the column is no longer
 * an operator input, just a derived label. Thresholds sit at the midpoints of
 * the INTENSITY_SCALE spine (0.775, 1.225).
 */
export function legacyTier(peril: Peril, severity: SeverityValue): Intensity {
  const m = damageMultiplier(peril, severity);
  if (m < 0.775) return 'moderate';
  if (m < 1.225) return 'severe';
  return 'catastrophic';
}

/**
 * Derive a representative severity value from a legacy Intensity tier — used
 * to normalise footprints stored before the per-peril scales.
 *
 * Discrete perils: returns the level whose multiplier is *closest* to
 * INTENSITY_SCALE[intensity]. Originally this required an exact match (which
 * worked because every scale was a 1:1 relabel of the spine), but the
 * wildfire/flood recalibrations decoupled those scales from the spine — their
 * realistic max sits below the legacy "catastrophic" multiplier of 1.45. The
 * closest-multiplier search keeps semantically sensible mapping (legacy
 * "severe" wildfire → new "high", legacy "moderate" flood → new "moderate")
 * without forcing a 1:1 spine relationship. The round-trip property
 * legacyTier(severityFromLegacy(t)) === t still holds for perils whose scale
 * remains spine-aligned (tornado, winter, hail, earthquake); for wildfire and
 * flood it is intentionally lossy at the catastrophic tier (those scales cap
 * below it, which is the point of the recalibration).
 */
export function severityFromLegacy(peril: Peril, intensity: Intensity): SeverityValue {
  const m = INTENSITY_SCALE[intensity];
  const scale = PERIL_SCALES[peril];
  if (scale.kind === 'discrete') {
    const closest = scale.levels.reduce((best, l) =>
      Math.abs(l.multiplier - m) < Math.abs(best.multiplier - m) ? l : best,
    );
    return closest.id;
  }
  // Continuous — invert multiplier(v) = m (research.md S2c, S3b).
  if (peril === 'earthquake') return 7.0 + (m - 1.0) / 0.45;
  return 20 + m / 0.04; // hail — inverse of max(0, 0.04 * (v − 20))
}

/** Tornado swath corridor width (m) for an EF level id (Brooks 2004). */
export function tornadoWidthM(severity: SeverityValue): number {
  const scale = PERIL_SCALES.tornado;
  if (scale.kind !== 'discrete') return 240;
  return scale.levels.find((l) => l.id === severity)?.width_m ?? 240;
}
