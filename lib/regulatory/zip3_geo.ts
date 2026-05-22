/**
 * Real ZIP3 geography — one verified anchor per ZIP3 prefix.
 *
 * Each entry is the real state, county, principal city and centroid of a
 * USPS ZIP3 prefix, sourced from USPS SCF tables + Census/Wikipedia. This is
 * the single source of truth for the seeded book's geography:
 *
 *   - `scripts/seed_policy_book.py` reads `zip3_geo.json` and places every
 *     policy's `lat`/`lon` (jittered) and `county` to match its ZIP3 anchor,
 *     so a policy's `(zip3, county, lat, lon)` are mutually coherent.
 *   - `tests/lib/regulatory/zip3_geo.test.ts` asserts the live `policies`
 *     table agrees with this file — it cannot silently drift from the book.
 *
 * It replaced two fabricated lookups: `zip3_to_county.ts` (county labels
 * disconnected from where the seed actually placed policies) and the interim
 * `zip3_state.ts`.
 */
import zip3GeoJson from './zip3_geo.json';

export interface Zip3Geo {
  state: string;
  county: string;
  city: string;
  lat: number;
  lon: number;
}

export const ZIP3_GEO = zip3GeoJson as Record<string, Zip3Geo>;

/** Full geo anchor for a ZIP3, or `null` for a ZIP3 outside the seeded book. */
export function zip3Geo(zip3: string): Zip3Geo | null {
  return ZIP3_GEO[zip3] ?? null;
}

/** US state code for a ZIP3, or `null` if unknown. */
export function zip3State(zip3: string): string | null {
  return ZIP3_GEO[zip3]?.state ?? null;
}

/** Real county name for a ZIP3, or `null` if unknown. */
export function zip3County(zip3: string): string | null {
  return ZIP3_GEO[zip3]?.county ?? null;
}

/**
 * Human-readable "County, ST" label for a ZIP3 — what UI surfaces show on a
 * ZIP3 group. Falls back to `'Unknown'` for a ZIP3 outside the seeded book.
 */
export function zip3CountyLabel(zip3: string): string {
  const g = ZIP3_GEO[zip3];
  return g ? `${g.county}, ${g.state}` : 'Unknown';
}
