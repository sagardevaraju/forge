/**
 * SimulationFootprint — the JSON contract crossing the TS → Python boundary.
 * See spec §4 (drawing toolkit) and §6 (persistence).
 *
 * The schema is intentionally a discriminated union by `peril`. Optional
 * fields are peril-specific (centerline+width_m for tornado, epicenter for
 * earthquake, etc.) but the canonical `geometry` is always a Polygon — for
 * tornado that means the *buffered* swath, not the centerline.
 *
 * Task 4: SimulationFootprint contract + validators
 */
import buffer from '@turf/buffer';
import { lineString } from '@turf/helpers';
import { isValidSimId } from './id';
import type { Peril, Intensity } from './severity';

export interface SimulationFootprint {
  peril: Peril;
  intensity: Intensity;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
  magnitude?: number;
  mmi_radii_km?: Record<string, number>;
  effective_date: string;
  metadata: {
    drawn_by: string;
    drawn_at: string;
    chips?: string[];
  };
}

export interface BuildFootprintArgs {
  peril: Peril;
  intensity: Intensity;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
  magnitude?: number;
  mmi_radii_km?: Record<string, number>;
  effective_date: string;
  drawn_by: string;
  chips?: string[];
}

export function buildFootprint(args: BuildFootprintArgs): SimulationFootprint {
  return {
    peril: args.peril,
    intensity: args.intensity,
    geometry: args.geometry,
    inner_geometry: args.inner_geometry,
    centerline: args.centerline,
    width_m: args.width_m,
    epicenter: args.epicenter,
    magnitude: args.magnitude,
    mmi_radii_km: args.mmi_radii_km,
    effective_date: args.effective_date,
    metadata: {
      drawn_by: args.drawn_by,
      drawn_at: new Date().toISOString(),
      chips: args.chips,
    },
  };
}

/**
 * Buffer a tornado centerline by half the swath width on each side.
 * width_m is the TOTAL corridor width; turf/buffer takes a radius, so we
 * pass width_m/2 in kilometers.
 */
export function bufferTornadoSwath(
  centerline: GeoJSON.LineString,
  width_m: number,
): GeoJSON.Polygon {
  const radiusKm = (width_m / 2) / 1000;
  const feature = buffer(lineString(centerline.coordinates), radiusKm, { units: 'kilometers' });
  if (!feature || feature.geometry.type !== 'Polygon') {
    throw new Error('Tornado swath buffer produced a non-Polygon geometry');
  }
  return feature.geometry as GeoJSON.Polygon;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateFootprint(fp: SimulationFootprint): ValidationResult {
  const ring = fp.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    return { ok: false, reason: 'Polygon ring must have ≥ 4 vertices (3 unique + closing)' };
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return { ok: false, reason: 'Polygon ring must be closed (first vertex repeated as last)' };
  }
  if (fp.peril === 'tornado' && (!fp.width_m || fp.width_m <= 0)) {
    return { ok: false, reason: 'Tornado footprint requires positive width_m' };
  }
  if (fp.peril === 'earthquake' && !fp.epicenter) {
    return { ok: false, reason: 'Earthquake footprint requires epicenter' };
  }
  return { ok: true };
}

export { isValidSimId };
