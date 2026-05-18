/**
 * Task P2.21 — ZIP3 centroid lookup table (demo seed).
 *
 * data_source: "synthetic_demo"
 *
 * Approximate (lon, lat) centroids for the ZIP3s the seeded policy book
 * (`scripts/seed_policy_book.py`) draws from. These are picked from each
 * ZIP3's largest population center and are accurate to ~10-20 km, which is
 * sufficient resolution for the cone-vs-outside binary classification the
 * Event Console mini-map needs.
 *
 * Real ZIP3 centroid lookup (Census ZCTA shapefile -> per-ZCTA centroid ->
 * area-weighted aggregation per ZIP3) is a Phase 3 follow-up. We do not need
 * sub-mile precision to compute "policy in cone or not" — the NHC cone is
 * 100+ km wide and the ZIP3 itself spans ~50 km.
 *
 * Every ZIP3 in `STATE_CONFIG` of `seed_policy_book.py` is covered. Lookups
 * for unknown ZIP3s return `null` so the mini-map drops them from both sides
 * of the ratio (rather than silently bucketing them as "outside").
 */

export interface Zip3Centroid {
  zip3: string;
  state: string;
  lon: number;
  lat: number;
}

// data_source: "synthetic_demo" — coastal population centers, approximate.
const ZIP3_CENTROIDS: Record<string, Zip3Centroid> = {
  // Florida (FL)
  '330': { zip3: '330', state: 'FL', lon: -80.19, lat: 25.77 }, // Miami
  '331': { zip3: '331', state: 'FL', lon: -80.30, lat: 25.85 }, // Hialeah
  '332': { zip3: '332', state: 'FL', lon: -80.14, lat: 26.12 }, // Fort Lauderdale
  '334': { zip3: '334', state: 'FL', lon: -80.05, lat: 26.71 }, // West Palm Beach
  '335': { zip3: '335', state: 'FL', lon: -82.46, lat: 27.95 }, // Tampa
  '337': { zip3: '337', state: 'FL', lon: -82.64, lat: 27.77 }, // St. Petersburg
  '338': { zip3: '338', state: 'FL', lon: -81.95, lat: 28.04 }, // Lakeland
  '339': { zip3: '339', state: 'FL', lon: -81.87, lat: 26.64 }, // Fort Myers
  '341': { zip3: '341', state: 'FL', lon: -82.46, lat: 27.34 }, // Sarasota
  '342': { zip3: '342', state: 'FL', lon: -81.79, lat: 26.14 }, // Naples
  '346': { zip3: '346', state: 'FL', lon: -82.57, lat: 28.81 }, // Brooksville
  '349': { zip3: '349', state: 'FL', lon: -80.62, lat: 27.21 }, // Stuart
  '320': { zip3: '320', state: 'FL', lon: -81.66, lat: 30.33 }, // Jacksonville

  // Texas (TX)
  '770': { zip3: '770', state: 'TX', lon: -95.37, lat: 29.76 }, // Houston
  '774': { zip3: '774', state: 'TX', lon: -95.22, lat: 29.59 }, // Pasadena
  '775': { zip3: '775', state: 'TX', lon: -94.93, lat: 29.30 }, // Galveston area
  '776': { zip3: '776', state: 'TX', lon: -94.10, lat: 30.09 }, // Beaumont
  '777': { zip3: '777', state: 'TX', lon: -94.66, lat: 30.40 }, // Lufkin / E. TX edge
  '778': { zip3: '778', state: 'TX', lon: -96.33, lat: 30.63 }, // Bryan / College Station
  '783': { zip3: '783', state: 'TX', lon: -97.40, lat: 27.80 }, // Corpus Christi
  '784': { zip3: '784', state: 'TX', lon: -97.50, lat: 27.50 }, // Corpus Christi south

  // Louisiana (LA)
  '703': { zip3: '703', state: 'LA', lon: -90.07, lat: 29.95 }, // New Orleans
  '704': { zip3: '704', state: 'LA', lon: -90.18, lat: 30.02 }, // Metairie
  '705': { zip3: '705', state: 'LA', lon: -90.83, lat: 29.69 }, // Houma
  '706': { zip3: '706', state: 'LA', lon: -91.18, lat: 30.45 }, // Baton Rouge
  '707': { zip3: '707', state: 'LA', lon: -91.94, lat: 30.22 }, // Lafayette
  '708': { zip3: '708', state: 'LA', lon: -93.22, lat: 30.23 }, // Lake Charles
  '714': { zip3: '714', state: 'LA', lon: -93.75, lat: 32.51 }, // Shreveport

  // North Carolina (NC)
  '275': { zip3: '275', state: 'NC', lon: -78.64, lat: 35.78 }, // Raleigh
  '280': { zip3: '280', state: 'NC', lon: -80.84, lat: 35.23 }, // Charlotte
  '281': { zip3: '281', state: 'NC', lon: -80.83, lat: 35.27 }, // Charlotte east
  '282': { zip3: '282', state: 'NC', lon: -82.55, lat: 35.60 }, // Asheville
  '283': { zip3: '283', state: 'NC', lon: -78.90, lat: 34.23 }, // Wilmington
  '284': { zip3: '284', state: 'NC', lon: -77.93, lat: 34.23 }, // Wilmington coast
  '285': { zip3: '285', state: 'NC', lon: -77.04, lat: 35.61 }, // Greenville
  '286': { zip3: '286', state: 'NC', lon: -77.40, lat: 35.13 }, // Kinston
  '287': { zip3: '287', state: 'NC', lon: -78.59, lat: 35.79 }, // Raleigh outer
  '289': { zip3: '289', state: 'NC', lon: -75.96, lat: 35.91 }, // Outer Banks
};

/**
 * Resolve a ZIP3 to its (lon, lat) centroid, or `null` if unknown. Callers
 * should treat `null` as "drop this cohort from the ratio" — never silently
 * assume it's outside the cone.
 */
export function zip3Centroid(zip3: string): Zip3Centroid | null {
  return ZIP3_CENTROIDS[zip3] ?? null;
}

/** Test/debug helper — expose the underlying table read-only. */
export function allZip3Centroids(): readonly Zip3Centroid[] {
  return Object.values(ZIP3_CENTROIDS);
}
