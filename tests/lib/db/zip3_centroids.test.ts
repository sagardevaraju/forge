// @vitest-environment node
/**
 * zip3Centroids() — per-ZIP3 map centroids derived from real policy data.
 *
 * The Portfolio Map used to plot ZIP3 bubbles from a hand-coded centroid
 * table that had drifted from the seed (the seed samples each state from a
 * single Gaussian blob, so a ZIP3's label says nothing about where its
 * policies actually sit). This helper replaces that table with the live
 * mean(lat, lon) per ZIP3 — the same aggregation SimMap's policy overlay
 * performs client-side. These tests pin the invariants that make the
 * centroids trustworthy without hardcoding seed-specific coordinates.
 */
import { describe, test, expect } from 'vitest';
import { db } from '@/lib/db/client';
import { zip3Centroids } from '@/lib/db/zip3_centroids';

describe('zip3Centroids', () => {
  test('returns one [lon, lat] centroid per distinct ZIP3 in the book', async () => {
    const centroids = await zip3Centroids();
    const keys = Object.keys(centroids);

    // The seed ships ~38 ZIP3s; at minimum the book is non-empty here
    // (this suite runs after the seed, like book_totals.test.ts).
    expect(keys.length).toBeGreaterThan(0);

    const distinct = await db.execute(
      'SELECT COUNT(DISTINCT zip3) AS n FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
    );
    expect(keys.length).toBe(Number(distinct.rows[0]?.n ?? 0));

    for (const [zip3, centroid] of Object.entries(centroids)) {
      expect(zip3).toMatch(/^\d{3}$/);
      expect(centroid).toHaveLength(2);
      const [lon, lat] = centroid;
      // Continental US: western hemisphere (lon < 0), northern (lat > 0).
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
      expect(lon).toBeGreaterThan(-130);
      expect(lon).toBeLessThan(-60);
      expect(lat).toBeGreaterThan(20);
      expect(lat).toBeLessThan(55);
    }
  });

  test('every centroid lies inside the policy bounding box (mean-of-points invariant)', async () => {
    const centroids = await zip3Centroids();
    const bounds = await db.execute(
      `SELECT MIN(lat) AS mnla, MAX(lat) AS mxla, MIN(lon) AS mnlo, MAX(lon) AS mxlo
       FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL`,
    );
    const { mnla, mxla, mnlo, mxlo } = bounds.rows[0] as Record<string, number>;

    // A mean of points can never fall outside the points' bounding box.
    for (const [lon, lat] of Object.values(centroids)) {
      expect(lat).toBeGreaterThanOrEqual(Number(mnla));
      expect(lat).toBeLessThanOrEqual(Number(mxla));
      expect(lon).toBeGreaterThanOrEqual(Number(mnlo));
      expect(lon).toBeLessThanOrEqual(Number(mxlo));
    }
  });
});
