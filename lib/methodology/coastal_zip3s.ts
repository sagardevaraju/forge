/**
 * AUDIT.3 Phase 4 follow-up — server-side loader for the coastal-ZIP3
 * catalog rendered on `/methodology`.
 *
 * Reads the tracked `artifacts/coastal_zip3s.json` artifact written by
 * `scripts/precompute_coastal_zip3s.py`. The artifact is regenerated
 * deterministically against the seeded policy book + USGS EPQS at
 * artifact-build time; we do not pull EPQS on the request path
 * (the file is committed to git per `CLAUDE.md` Common pitfalls §3).
 *
 * Returns `null` when the artifact is missing instead of throwing so the
 * page can render a graceful "regenerate" callout matching the pattern
 * used by `app/treaty/page.tsx` and `app/calibration/page.tsx`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface CoastalZip3Entry {
  /** Elevation in meters at the ZIP3 centroid, sourced from USGS NED via EPQS. */
  elev_m: number;
  /** Centroid latitude (AVG over policies in the ZIP3). */
  lat: number;
  /** Centroid longitude (AVG over policies in the ZIP3). */
  lon: number;
  /** Number of seeded policies in this ZIP3 (gating threshold lives in `source.min_policies_per_zip3`). */
  n_policies: number;
}

export interface CoastalZip3Source {
  centroid: string;
  coastal_states: string[];
  elevation: string;
  epqs_url: string;
  min_policies_per_zip3: number;
}

export interface CoastalZip3Catalog {
  catalog: Record<string, CoastalZip3Entry>;
  n_zip3s: number;
  notes: string;
  source: CoastalZip3Source;
}

const ARTIFACT_PATH = path.join(
  process.cwd(),
  'artifacts',
  'coastal_zip3s.json',
);

export async function loadCoastalZip3Catalog(): Promise<CoastalZip3Catalog | null> {
  try {
    const raw = await readFile(ARTIFACT_PATH, 'utf-8');
    return JSON.parse(raw) as CoastalZip3Catalog;
  } catch {
    return null;
  }
}
