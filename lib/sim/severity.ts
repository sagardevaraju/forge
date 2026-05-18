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
