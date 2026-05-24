/**
 * Task P3.23 — US state cartographic boundaries (TopoJSON-shaped).
 *
 * Bounded-box state polygons for the FORGE choropleth scaffold. v1
 * carries simplified bounding-box rectangles per US state so the
 * `PortfolioChoropleth` component renders end-to-end without dragging
 * in a 100+ KB cartographic-boundary file at this stage of the
 * autonomous handoff.
 *
 * **Swap-point for real census polygons:** Replace the bounding-box
 * geometries below with the US Census Bureau cartographic boundary
 * file when ready:
 *
 *     https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html
 *     cb_2022_us_state_20m.json   (~100 KB simplified TopoJSON)
 *
 * The Census file is in the public domain. To swap:
 *   1. Download `cb_2022_us_state_20m.json` to `lib/geo/`
 *   2. Replace the `STATE_FEATURES` export below with the loaded
 *      FeatureCollection
 *   3. The component contract is unchanged — `iso_code` (USPS state
 *      abbreviation) + GeoJSON Polygon coordinates.
 *
 * License note: Census Bureau cartographic boundary files are in the
 * public domain (https://www.census.gov/data-tools/developers/about/terms-of-service.html).
 * The bounding-box stand-in in this file is FORGE-authored.
 */

export interface StateFeature {
  /** USPS two-letter state code (e.g. 'FL'). */
  iso_code: string;
  /** Display name (e.g. 'Florida'). */
  name: string;
  /** GeoJSON Polygon geometry. */
  geometry: GeoJSON.Polygon;
}

/**
 * Build a Polygon ring from a bounding box (lat / lon min/max).
 * Coordinate order is [lon, lat] per GeoJSON spec.
 */
function bboxRing(
  latMin: number,
  lonMin: number,
  latMax: number,
  lonMax: number,
): GeoJSON.Polygon {
  return {
    type: 'Polygon',
    coordinates: [[
      [lonMin, latMin],
      [lonMax, latMin],
      [lonMax, latMax],
      [lonMin, latMax],
      [lonMin, latMin],
    ]],
  };
}

/**
 * Hand-tabulated state bounding boxes (NOAA NWS regional product
 * spec, approximated to whole / half degrees). These are placeholders
 * for the real Census Bureau cartographic boundary files (see file
 * docstring for the swap recipe).
 *
 * Coverage: the lower-48 states. Alaska + Hawaii are placeholder
 * bounding boxes — fine for FORGE's CONUS-focused demo but not
 * cartographically accurate.
 */
export const STATE_FEATURES: StateFeature[] = [
  { iso_code: 'AL', name: 'Alabama',        geometry: bboxRing(30.2, -88.5, 35.0, -85.0) },
  { iso_code: 'AK', name: 'Alaska',         geometry: bboxRing(54.0, -170.0, 71.0, -130.0) },
  { iso_code: 'AZ', name: 'Arizona',        geometry: bboxRing(31.3, -114.8, 37.0, -109.0) },
  { iso_code: 'AR', name: 'Arkansas',       geometry: bboxRing(33.0, -94.6, 36.5, -89.7) },
  { iso_code: 'CA', name: 'California',     geometry: bboxRing(32.5, -124.5, 42.0, -114.0) },
  { iso_code: 'CO', name: 'Colorado',       geometry: bboxRing(37.0, -109.1, 41.0, -102.0) },
  { iso_code: 'CT', name: 'Connecticut',    geometry: bboxRing(40.9, -73.7, 42.1, -71.8) },
  { iso_code: 'DE', name: 'Delaware',       geometry: bboxRing(38.4, -75.8, 39.9, -75.0) },
  { iso_code: 'FL', name: 'Florida',        geometry: bboxRing(24.5, -87.6, 31.0, -80.0) },
  { iso_code: 'GA', name: 'Georgia',        geometry: bboxRing(30.4, -85.6, 35.0, -80.7) },
  { iso_code: 'HI', name: 'Hawaii',         geometry: bboxRing(18.9, -161.0, 22.3, -154.8) },
  { iso_code: 'ID', name: 'Idaho',          geometry: bboxRing(42.0, -117.2, 49.0, -111.0) },
  { iso_code: 'IL', name: 'Illinois',       geometry: bboxRing(36.9, -91.5, 42.5, -87.5) },
  { iso_code: 'IN', name: 'Indiana',        geometry: bboxRing(37.8, -88.1, 41.8, -84.8) },
  { iso_code: 'IA', name: 'Iowa',           geometry: bboxRing(40.4, -96.7, 43.5, -90.1) },
  { iso_code: 'KS', name: 'Kansas',         geometry: bboxRing(36.9, -102.1, 40.0, -94.6) },
  { iso_code: 'KY', name: 'Kentucky',       geometry: bboxRing(36.5, -89.6, 39.1, -81.9) },
  { iso_code: 'LA', name: 'Louisiana',      geometry: bboxRing(28.9, -94.0, 33.0, -88.8) },
  { iso_code: 'ME', name: 'Maine',          geometry: bboxRing(43.0, -71.1, 47.5, -66.9) },
  { iso_code: 'MD', name: 'Maryland',       geometry: bboxRing(37.9, -79.5, 39.7, -75.0) },
  { iso_code: 'MA', name: 'Massachusetts',  geometry: bboxRing(41.2, -73.5, 42.9, -69.9) },
  { iso_code: 'MI', name: 'Michigan',       geometry: bboxRing(41.7, -90.4, 48.3, -82.4) },
  { iso_code: 'MN', name: 'Minnesota',      geometry: bboxRing(43.5, -97.2, 49.4, -89.5) },
  { iso_code: 'MS', name: 'Mississippi',    geometry: bboxRing(30.2, -91.7, 35.0, -88.1) },
  { iso_code: 'MO', name: 'Missouri',       geometry: bboxRing(35.9, -95.8, 40.6, -89.1) },
  { iso_code: 'MT', name: 'Montana',        geometry: bboxRing(44.4, -116.1, 49.0, -104.0) },
  { iso_code: 'NE', name: 'Nebraska',       geometry: bboxRing(40.0, -104.1, 43.0, -95.3) },
  { iso_code: 'NV', name: 'Nevada',         geometry: bboxRing(35.0, -120.0, 42.0, -114.0) },
  { iso_code: 'NH', name: 'New Hampshire',  geometry: bboxRing(42.7, -72.6, 45.3, -70.6) },
  { iso_code: 'NJ', name: 'New Jersey',     geometry: bboxRing(38.9, -75.6, 41.4, -73.9) },
  { iso_code: 'NM', name: 'New Mexico',     geometry: bboxRing(31.3, -109.1, 37.0, -103.0) },
  { iso_code: 'NY', name: 'New York',       geometry: bboxRing(40.5, -79.8, 45.0, -71.9) },
  { iso_code: 'NC', name: 'North Carolina', geometry: bboxRing(33.8, -84.4, 36.6, -75.5) },
  { iso_code: 'ND', name: 'North Dakota',   geometry: bboxRing(45.9, -104.1, 49.0, -96.6) },
  { iso_code: 'OH', name: 'Ohio',           geometry: bboxRing(38.4, -84.8, 42.0, -80.5) },
  { iso_code: 'OK', name: 'Oklahoma',       geometry: bboxRing(33.6, -103.0, 37.0, -94.4) },
  { iso_code: 'OR', name: 'Oregon',         geometry: bboxRing(42.0, -124.6, 46.3, -116.5) },
  { iso_code: 'PA', name: 'Pennsylvania',   geometry: bboxRing(39.7, -80.5, 42.3, -74.7) },
  { iso_code: 'RI', name: 'Rhode Island',   geometry: bboxRing(41.1, -71.9, 42.0, -71.1) },
  { iso_code: 'SC', name: 'South Carolina', geometry: bboxRing(32.0, -83.4, 35.2, -78.5) },
  { iso_code: 'SD', name: 'South Dakota',   geometry: bboxRing(42.5, -104.1, 45.9, -96.4) },
  { iso_code: 'TN', name: 'Tennessee',      geometry: bboxRing(35.0, -90.3, 36.7, -81.7) },
  { iso_code: 'TX', name: 'Texas',          geometry: bboxRing(25.8, -106.7, 36.5, -93.5) },
  { iso_code: 'UT', name: 'Utah',           geometry: bboxRing(37.0, -114.1, 42.0, -109.0) },
  { iso_code: 'VT', name: 'Vermont',        geometry: bboxRing(42.7, -73.5, 45.0, -71.5) },
  { iso_code: 'VA', name: 'Virginia',       geometry: bboxRing(36.5, -83.7, 39.5, -75.2) },
  { iso_code: 'WA', name: 'Washington',     geometry: bboxRing(45.5, -124.8, 49.0, -116.9) },
  { iso_code: 'WV', name: 'West Virginia',  geometry: bboxRing(37.2, -82.7, 40.6, -77.7) },
  { iso_code: 'WI', name: 'Wisconsin',      geometry: bboxRing(42.5, -92.9, 47.1, -86.8) },
  { iso_code: 'WY', name: 'Wyoming',        geometry: bboxRing(41.0, -111.1, 45.0, -104.1) },
];

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
 * Feature carries the iso_code + name in `properties` so a `fill`
 * layer can use property-based paint expressions.
 */
export function statesFeatureCollection(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: STATE_FEATURES.map((s) => ({
      type: 'Feature',
      properties: { iso_code: s.iso_code, name: s.name },
      geometry: s.geometry,
    })),
  };
}
