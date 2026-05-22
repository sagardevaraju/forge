/**
 * SimulationFootprint — the JSON contract crossing the TS -> Python boundary.
 * See spec S4 (drawing toolkit) and S6 (persistence).
 *
 * The schema is a discriminated union by `peril`. Optional fields are
 * peril-specific (centerline+width_m for tornado, epicenter for earthquake).
 * The canonical `geometry` is always a Polygon — for tornado the *buffered*
 * swath, not the centerline.
 *
 * `severity` is the canonical per-peril severity value (a Mw number, a
 * stone-diameter number, or a discrete scale-level id like 'ef3'). `intensity`
 * is *derived* from it via legacyTier() — it satisfies the NOT NULL
 * `simulations.intensity` column and is the fallback for footprints stored
 * before the per-peril severity scales existed.
 *
 * Task 4 / peril-intensity-scales: per-peril severity contract.
 */
import buffer from '@turf/buffer';
import { lineString, point } from '@turf/helpers';
import { isValidSimId } from './id';
import {
  legacyTier,
  tornadoWidthM,
  type Peril,
  type Intensity,
  type SeverityValue,
} from './severity';

export interface SimulationFootprint {
  peril: Peril;
  severity: SeverityValue;
  intensity: Intensity;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
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
  severity: SeverityValue;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
  mmi_radii_km?: Record<string, number>;
  effective_date: string;
  drawn_by: string;
  chips?: string[];
}

/** Build a footprint from operator input. `intensity` is derived, not passed. */
export function buildFootprint(args: BuildFootprintArgs): SimulationFootprint {
  return {
    peril: args.peril,
    severity: args.severity,
    intensity: legacyTier(args.peril, args.severity),
    geometry: args.geometry,
    inner_geometry: args.inner_geometry,
    centerline: args.centerline,
    width_m: args.width_m,
    epicenter: args.epicenter,
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

/**
 * Earthquake footprint geometry.
 *
 * The operator drops a single epicenter point and dials a moment magnitude
 * (Mw) on the severity slider. The damage footprint is the circular area
 * inside which shaking reaches the Modified Mercalli damage threshold
 * (MMI VI — onset of structural damage). The radius comes from the Bakun &
 * Wentworth (1997) California intensity-attenuation relation, inverted for
 * distance:
 *
 *   MMI = 1.68*Mw - 3.29 - 0.0206*Delta        (Delta = epicentral distance, km)
 *
 * Source: Bakun, W.H. & Wentworth, C.M. (1997), "Estimating earthquake
 * location and magnitude from seismic intensity data", BSSA 87(6), 1502-1521.
 * The three attenuation coefficients below are the empirical part and must not
 * be edited without a new citation (research.md S2b).
 */

// Bakun & Wentworth (1997) California MMI attenuation coefficients.
const BW_MAGNITUDE_COEF = 1.68;
const BW_CONSTANT = 3.29;
const BW_DISTANCE_COEF = 0.0206;

// Modified Mercalli VI — onset of structural damage. Bounds the footprint.
const DAMAGE_THRESHOLD_MMI = 6;

// Below ~Mw 5.5 the MMI-VI contour has zero radius. The footprint contract
// still needs a constructible Polygon, so the buffer is floored at this small
// epsilon — a degenerate-case guard, not a measurement. mmi_radii_km still
// honestly omits any shell whose true radius is 0.
const MIN_BUFFER_KM = 0.5;

/**
 * Epicentral distance (km) at which Bakun-Wentworth shaking decays to the
 * given Modified Mercalli intensity. Clamped at 0 — a magnitude too small to
 * ever reach `mmi` (even at the epicenter) yields no radius.
 */
export function mmiRadiusKm(magnitude: number, mmi: number): number {
  const km = (BW_MAGNITUDE_COEF * magnitude - BW_CONSTANT - mmi) / BW_DISTANCE_COEF;
  return Math.max(0, km);
}

/** Buffer an epicenter point into a circular Polygon of `radiusKm`. */
export function bufferEpicenterCircle(
  epicenter: GeoJSON.Point,
  radiusKm: number,
): GeoJSON.Polygon {
  if (!(radiusKm > 0)) {
    throw new Error('Earthquake footprint requires a positive radius');
  }
  const feature = buffer(point(epicenter.coordinates), radiusKm, {
    units: 'kilometers',
    steps: 64,
  });
  if (!feature || feature.geometry.type !== 'Polygon') {
    throw new Error('Earthquake circle buffer produced a non-Polygon geometry');
  }
  return feature.geometry as GeoJSON.Polygon;
}

export interface EarthquakeGeometry {
  geometry: GeoJSON.Polygon;
  mmi_radii_km: Record<string, number>;
}

/**
 * Derive the earthquake footprint geometry from an epicenter + a moment
 * magnitude: the MMI-VI damage circle (`geometry`) plus the MMI VI/VII/VIII
 * shell radii (`mmi_radii_km`, omitting any non-positive radius).
 */
export function earthquakeFootprintGeometry(
  epicenter: GeoJSON.Point,
  magnitude: number,
): EarthquakeGeometry {
  const mmi_radii_km: Record<string, number> = {};
  for (const mmi of [6, 7, 8]) {
    const r = mmiRadiusKm(magnitude, mmi);
    if (r > 0) mmi_radii_km[String(mmi)] = r;
  }
  const radiusKm = Math.max(MIN_BUFFER_KM, mmiRadiusKm(magnitude, DAMAGE_THRESHOLD_MMI));
  return { geometry: bufferEpicenterCircle(epicenter, radiusKm), mmi_radii_km };
}

/**
 * Rebuild a footprint under a new severity / effective date — used when the
 * operator changes the SeverityStrip after a footprint already exists.
 *
 * - earthquake: the circle radius is a function of Mw, so geometry and the
 *   MMI shell radii are recomputed from the stored epicenter.
 * - tornado: the swath width is a function of the EF level, so the stored
 *   centerline is re-buffered to the new width.
 * - hail / flood / wildfire / winter: geometry is severity-independent, so
 *   only severity, the derived intensity, and effective_date change.
 */
export function rebuildFootprint(
  fp: SimulationFootprint,
  severity: SeverityValue,
  effectiveDate: string,
): SimulationFootprint {
  if (fp.peril === 'earthquake' && fp.epicenter) {
    const eq = earthquakeFootprintGeometry(fp.epicenter, severity as number);
    return buildFootprint({
      peril: 'earthquake',
      severity,
      geometry: eq.geometry,
      epicenter: fp.epicenter,
      mmi_radii_km: eq.mmi_radii_km,
      effective_date: effectiveDate,
      drawn_by: fp.metadata.drawn_by,
      chips: fp.metadata.chips,
    });
  }
  if (fp.peril === 'tornado' && fp.centerline) {
    const width_m = tornadoWidthM(severity);
    return buildFootprint({
      peril: 'tornado',
      severity,
      geometry: bufferTornadoSwath(fp.centerline, width_m),
      centerline: fp.centerline,
      width_m,
      effective_date: effectiveDate,
      drawn_by: fp.metadata.drawn_by,
      chips: fp.metadata.chips,
    });
  }
  return buildFootprint({
    peril: fp.peril,
    severity,
    geometry: fp.geometry,
    inner_geometry: fp.inner_geometry,
    centerline: fp.centerline,
    width_m: fp.width_m,
    effective_date: effectiveDate,
    drawn_by: fp.metadata.drawn_by,
    chips: fp.metadata.chips,
  });
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateFootprint(fp: SimulationFootprint): ValidationResult {
  const ring = fp.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    return { ok: false, reason: 'Polygon ring must have >= 4 vertices (3 unique + closing)' };
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
