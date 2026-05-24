// @vitest-environment node
/**
 * Task P3.18 — basin-aware mock fallback for fetch_nhc_cone.
 *
 * The mock fallback historically emitted a Florida-shaped cone regardless
 * of the storm_id. P3.18 makes the mock dispatch on a `_CB` / `_CA`
 * suffix on the storm_id so the offline / demo path can exercise:
 *
 *   AL092024     → US Atlantic (Gulf-of-Mexico / Ian-shape) cone
 *   AL092024_CB  → Caribbean (Maria/Matthew-shape) cone
 *   AL092024_CA  → Atlantic Canada (Dorian/Fiona-shape) cone
 *
 * Live-path tests are in fetch_nhc_cone.test.ts; this file covers only
 * the mock dispatch + region-specific cone shape.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
}

beforeEach(() => {
  process.env.FORGE_TOOLS_MODE = 'mock';
});
afterEach(() => {
  restoreEnv();
});

interface PolygonGeom { type: 'Polygon'; coordinates: number[][][]; }
type Feature = { properties?: Record<string, unknown>; geometry: PolygonGeom };

function centroid(ring: number[][]): { lat: number; lon: number } {
  let sx = 0, sy = 0, n = 0;
  for (const [lon, lat] of ring) {
    sx += lon; sy += lat; n += 1;
  }
  return { lat: sy / n, lon: sx / n };
}

describe('fetch_nhc_cone — basin-aware mock (Task P3.18)', () => {
  test('storm_id with no suffix → US Atlantic / Gulf cone', async () => {
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    const feat = out.cone as Feature;
    const c = centroid(feat.geometry.coordinates[0]!);
    // US Atlantic mock cone centroid sits in the eastern Gulf of Mexico
    // (~ -83 lon, ~ 27 lat).
    expect(c.lat).toBeGreaterThan(23);
    expect(c.lat).toBeLessThan(31);
    expect(c.lon).toBeGreaterThan(-87);
    expect(c.lon).toBeLessThan(-80);
    expect(out.peak_wind).toBe(142);
  });

  test('storm_id with _CB suffix → Caribbean cone centroid', async () => {
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024_CB' });
    const feat = out.cone as Feature;
    const c = centroid(feat.geometry.coordinates[0]!);
    // Caribbean cone centroid sits near the Greater Antilles (~ 18 lat,
    // -73 lon — between Haiti and Jamaica).
    expect(c.lat).toBeGreaterThan(13);
    expect(c.lat).toBeLessThan(23);
    expect(c.lon).toBeGreaterThan(-80);
    expect(c.lon).toBeLessThan(-65);
    expect(out.peak_wind).toBe(145);
    // Region tag surfaces on the cone feature for downstream consumers.
    expect((feat.properties as { region?: string }).region).toBe('caribbean');
  });

  test('storm_id with _CA suffix → Atlantic Canada cone centroid', async () => {
    const out = await fetchNhcCone.handler({ storm_id: 'AL182019_CA' });
    const feat = out.cone as Feature;
    const c = centroid(feat.geometry.coordinates[0]!);
    // Atlantic Canada cone centroid sits offshore Nova Scotia
    // (~ 44 lat, -61 lon).
    expect(c.lat).toBeGreaterThan(39);
    expect(c.lat).toBeLessThan(49);
    expect(c.lon).toBeGreaterThan(-68);
    expect(c.lon).toBeLessThan(-54);
    expect(out.peak_wind).toBe(110);
    expect((feat.properties as { region?: string }).region).toBe('atlantic_canada');
  });

  test('basin tag is propagated to properties.region', async () => {
    const us = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    const cb = await fetchNhcCone.handler({ storm_id: 'AL092024_CB' });
    const ca = await fetchNhcCone.handler({ storm_id: 'AL182019_CA' });
    expect(((us.cone as Feature).properties as { region?: string }).region).toBe('us_atlantic');
    expect(((cb.cone as Feature).properties as { region?: string }).region).toBe('caribbean');
    expect(((ca.cone as Feature).properties as { region?: string }).region).toBe('atlantic_canada');
  });

  test('peak_wind delta-since-prior matches archetype', async () => {
    const us = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    const cb = await fetchNhcCone.handler({ storm_id: 'AL092024_CB' });
    const ca = await fetchNhcCone.handler({ storm_id: 'AL182019_CA' });
    expect(us.peak_wind - (us.prior_peak_wind ?? 0)).toBe(7);     // US: +7
    expect(cb.peak_wind - (cb.prior_peak_wind ?? 0)).toBe(15);    // CB: +15 intensifying
    expect(ca.peak_wind - (ca.prior_peak_wind ?? 0)).toBe(5);     // CA: +5 post-tropical
  });
});
