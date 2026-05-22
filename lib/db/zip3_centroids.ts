/**
 * Per-ZIP3 map centroids derived from the live policy book.
 *
 * Each centroid is the mean (lat, lon) of every policy in that ZIP3 — the
 * same aggregation SimMap's "Policies" overlay performs client-side
 * (`components/sim/SimMap.tsx`, `zipBubbles`). The Portfolio Map consumes
 * this so its ZIP3 bubbles sit where the book genuinely is.
 *
 * Why this exists: the previous hand-coded `ZIP3_CENTROIDS` table in
 * `PortfolioMapPane.tsx` placed each ZIP3 at its real-world geographic
 * center, but `scripts/seed_policy_book.py` samples every policy's lat/lon
 * from a single per-state Gaussian and assigns `zip3` as an unrelated
 * label. So the hand-coded table drifted ~100-460 km from where policies
 * actually sit, and the Portfolio Map disagreed with the /simulate map.
 * Deriving centroids from the data keeps the two maps consistent and makes
 * the cone-classification math in `PortfolioMap` operate on real positions.
 *
 * Both DB paths (Turso remote + local SQLite file) are honored via
 * `lib/db/client.ts`. AVG() is null-safe and the WHERE clause drops rows
 * with missing coordinates, so a fresh-clone DB just yields `{}`.
 */
import { db } from './client';

/** Map centroid in GeoJSON [lon, lat] order. */
export type Zip3Centroid = [number, number];

export async function zip3Centroids(): Promise<Record<string, Zip3Centroid>> {
  const r = await db.execute({
    sql: `SELECT zip3, AVG(lat) AS lat, AVG(lon) AS lon
          FROM policies
          WHERE lat IS NOT NULL AND lon IS NOT NULL AND zip3 IS NOT NULL
          GROUP BY zip3`,
    args: [],
  });
  const out: Record<string, Zip3Centroid> = {};
  for (const row of r.rows) {
    const zip3 =
      typeof row.zip3 === 'string' ? row.zip3 : String(row.zip3 ?? '');
    if (!zip3) continue;
    out[zip3] = [Number(row.lon), Number(row.lat)];
  }
  return out;
}
