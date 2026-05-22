// @vitest-environment node
/**
 * `zip3_geo.json` is the geographic reference the seed conforms to. These
 * tests prove it stays consistent with the real `policies` table: every
 * ZIP3 in the book resolves, to the same state and county the DB records,
 * and the book carries no ZIP3 the reference is missing. If the seed and the
 * reference ever drift apart, this fails — which keeps the geography honest.
 */
import { describe, test, expect } from 'vitest';
import { db } from '@/lib/db/client';
import {
  ZIP3_GEO,
  zip3Geo,
  zip3State,
  zip3County,
} from '@/lib/regulatory/zip3_geo';

describe('zip3_geo', () => {
  test('agrees with the actual policy book on state and county', async () => {
    const r = await db.execute(
      'SELECT DISTINCT zip3, state, county FROM policies ' +
        'WHERE zip3 IS NOT NULL AND state IS NOT NULL',
    );
    expect(r.rows.length).toBeGreaterThan(0);

    const zip3sInBook = new Set<string>();
    for (const row of r.rows) {
      const zip3 = String(row.zip3);
      zip3sInBook.add(zip3);
      expect(zip3State(zip3)).toBe(String(row.state));
      expect(zip3County(zip3)).toBe(String(row.county));
    }
    // The reference covers every ZIP3 the book uses, and no extras.
    expect([...zip3sInBook].sort()).toEqual(Object.keys(ZIP3_GEO).sort());
  });

  test('every anchor centroid sits inside the policy bounding box', async () => {
    // The seed jitters policies around each anchor, so each anchor must lie
    // within (or on) the book's overall lat/lon extent.
    const b = (
      await db.execute(
        'SELECT MIN(lat) mnla, MAX(lat) mxla, MIN(lon) mnlo, MAX(lon) mxlo FROM policies',
      )
    ).rows[0] as Record<string, number>;
    for (const g of Object.values(ZIP3_GEO)) {
      expect(g.lat).toBeGreaterThanOrEqual(Number(b.mnla) - 0.5);
      expect(g.lat).toBeLessThanOrEqual(Number(b.mxla) + 0.5);
      expect(g.lon).toBeGreaterThanOrEqual(Number(b.mnlo) - 0.5);
      expect(g.lon).toBeLessThanOrEqual(Number(b.mxlo) + 0.5);
    }
  });

  test('returns null for a ZIP3 outside the seeded book', () => {
    expect(zip3Geo('999')).toBeNull();
    expect(zip3State('999')).toBeNull();
    expect(zip3County('999')).toBeNull();
  });
});
