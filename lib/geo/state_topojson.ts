/**
 * Task P3.23 — US state cartographic boundaries.
 *
 * Real Census Bureau cartographic boundary polygons for the FORGE
 * choropleth. Sourced from us-atlas v3 (Apache-2.0), which is a
 * curated re-publication of the US Census Bureau's public-domain
 * cartographic boundary files. Re-run `python -m scripts.build_state_geojson`
 * to regenerate the underlying JSON when bumping the us-atlas pin.
 *
 * History
 * -------
 * v1 (P3.23, original): hand-tabulated bounding-box rectangles for the
 * 50 lower-48 + AK + HI states. Worked end-to-end but looked like a
 * 1985 weather-channel map — rectangular Florida, square Michigan,
 * no Aleutian arc, no Channel Islands.
 *
 * v2 (Phase 4 sweep): real Census polygons via us-atlas. 51 features
 * (50 states + DC). Geometries are Polygon (single-body states like TX
 * or single-tile entries like DC) or MultiPolygon (states with islands
 * or exclaves — CA, MI, FL, HI, MA, AK, etc.). MapLibre's addSource
 * handles both without modification.
 *
 * Data lives in lib/geo/data/us-states.geo.json (committed). License:
 * Apache-2.0 (us-atlas packaging) + public-domain (the underlying
 * Census shapefiles).
 */

import statesGeoJson from './data/us-states.geo.json';

export interface StateFeature {
  /** USPS two-letter state code (e.g. 'FL', 'DC'). */
  iso_code: string;
  /** Display name (e.g. 'Florida', 'District of Columbia'). */
  name: string;
  /** FIPS 2-digit state code (e.g. '12' for FL). Surfaced for joins
   *  against Census or BEA tables; not needed by the choropleth itself. */
  fips: string;
  /** GeoJSON Polygon (single-body) or MultiPolygon (islands / exclaves). */
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

/** Cached at module-load; the JSON is ~556 KB raw, ~216 KB gzipped. */
export const STATE_FEATURES: StateFeature[] = (
  statesGeoJson as { features: Array<{
    properties: { iso_code: string; name: string; fips: string };
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  }> }
).features.map((f) => ({
  iso_code: f.properties.iso_code,
  name: f.properties.name,
  fips: f.properties.fips,
  geometry: f.geometry,
}));

/**
 * Lookup by USPS abbreviation. Returns null for unknown codes
 * (lowercase / mixed-case inputs are normalised to uppercase).
 */
export function stateByIsoCode(iso: string): StateFeature | null {
  const upper = iso.trim().toUpperCase();
  return STATE_FEATURES.find((f) => f.iso_code === upper) ?? null;
}

/**
 * GeoJSON FeatureCollection wrapper for MapLibre `addSource`. Each
 * Feature carries the iso_code + name + fips in `properties` so a
 * `fill` layer can use property-based paint expressions.
 */
export function statesFeatureCollection(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: STATE_FEATURES.map((s) => ({
      type: 'Feature',
      properties: { iso_code: s.iso_code, name: s.name, fips: s.fips },
      geometry: s.geometry,
    })),
  };
}
