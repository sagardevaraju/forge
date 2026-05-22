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

export const INTENSITIES = ['moderate', 'severe', 'catastrophic'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const BUILD_TYPES = [
  'wood_frame',
  'masonry',
  'mobile_home',
  'commercial',
] as const;
export type BuildType = (typeof BUILD_TYPES)[number];

const HAZUS_MATRIX: Record<BuildType, Record<Peril, number>> = {
  wood_frame:  { tornado: 0.42, flood: 0.55, hail: 0.18, wildfire: 0.92, earthquake: 0.35, winter: 0.08 },
  masonry:     { tornado: 0.28, flood: 0.62, hail: 0.10, wildfire: 0.85, earthquake: 0.22, winter: 0.06 },
  mobile_home: { tornado: 0.85, flood: 0.45, hail: 0.32, wildfire: 0.95, earthquake: 0.55, winter: 0.18 },
  commercial:  { tornado: 0.30, flood: 0.48, hail: 0.12, wildfire: 0.78, earthquake: 0.28, winter: 0.05 },
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
    multiplier: (v) => Math.max(0.05, 1.0 + 0.45 * (v - 7.0)),
    label: (v) => `M${v.toFixed(1)}`,
  },
  hail: {
    kind: 'continuous',
    unit: 'mm',
    min: 10,
    max: 120,
    step: 5,
    default: 45,
    // Modelling parameter — anchored 25 mm -> 0.55, 45 mm -> 1.0 (research.md S3b).
    multiplier: (v) => Math.max(0.05, 0.55 + 0.0225 * (v - 25)),
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
    levels: [
      { id: 'minor',    label: 'Minor',    multiplier: 0.55 },
      { id: 'moderate', label: 'Moderate', multiplier: 1.0 },
      { id: 'major',    label: 'Major',    multiplier: 1.45 },
    ],
  },
  wildfire: {
    kind: 'discrete',
    default: 'moderate',
    levels: [
      { id: 'low',      label: 'Low',      multiplier: 0.55 },
      { id: 'moderate', label: 'Moderate', multiplier: 1.0 },
      { id: 'high',     label: 'High',     multiplier: 1.45 },
    ],
  },
  winter: {
    kind: 'discrete',
    default: 'moderate',
    levels: [
      { id: 'limited',  label: 'Limited',  multiplier: 0.325 },
      { id: 'minor',    label: 'Minor',    multiplier: 0.55 },
      { id: 'moderate', label: 'Moderate', multiplier: 1.0 },
      { id: 'major',    label: 'Major',    multiplier: 1.45 },
      { id: 'extreme',  label: 'Extreme',  multiplier: 1.90 },
    ],
  },
};

export function damageRatio(
  peril: Peril,
  buildType: BuildType | string,
  intensity: Intensity,
): number {
  const row = HAZUS_MATRIX[buildType as BuildType] ?? HAZUS_MATRIX.wood_frame;
  const base = row[peril];
  const scaled = base * INTENSITY_SCALE[intensity];
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
 * to normalise footprints stored before the per-peril scales. The result is
 * the scale value whose multiplier equals INTENSITY_SCALE[intensity], so it
 * round-trips back through legacyTier().
 */
export function severityFromLegacy(peril: Peril, intensity: Intensity): SeverityValue {
  const m = INTENSITY_SCALE[intensity];
  const scale = PERIL_SCALES[peril];
  if (scale.kind === 'discrete') {
    const level = scale.levels.find((l) => l.multiplier === m);
    return (level ?? scale.levels.find((l) => l.id === scale.default)!).id;
  }
  // Continuous — invert multiplier(v) = m (research.md S2c, S3b).
  if (peril === 'earthquake') return 7.0 + (m - 1.0) / 0.45;
  return 25 + (m - 0.55) / 0.0225; // hail
}

/** Tornado swath corridor width (m) for an EF level id (Brooks 2004). */
export function tornadoWidthM(severity: SeverityValue): number {
  const scale = PERIL_SCALES.tornado;
  if (scale.kind !== 'discrete') return 240;
  return scale.levels.find((l) => l.id === severity)?.width_m ?? 240;
}
