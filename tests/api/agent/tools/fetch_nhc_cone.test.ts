// @vitest-environment node
/**
 * Task P2.38 — NHC GEFS ensemble swap.
 *
 * Extends the fetch_nhc_cone tool to additionally return a `gefs_ensemble`
 * field holding the GEFS ensemble members for the most recent advisory.
 * The field is additive on top of the P2.22 `prior_cones` ribbon; existing
 * callers ignore it without change. Mock fallback ships 5 deterministic
 * members so the offline / no-key path exercises the ensemble code path.
 *
 * Live path: the tool pulls ATCF data from
 *   https://ftp.nhc.noaa.gov/atcf/aid_public/a<basin><NN><YYYY>.dat
 * and filters to GEFS ensemble member tech codes (AC01..AC20, AP01..AP20).
 * A 404 / empty body collapses gefs_ensemble to null so downstream code
 * can fall back to the parametric scenario generator.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
}

beforeEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});

describe('fetch_nhc_cone — GEFS ensemble (Task P2.38)', () => {
  test('mock fallback returns gefs_ensemble with 5 members', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.gefs_ensemble).toBeTruthy();
    expect(out.gefs_ensemble?.members).toHaveLength(5);
  });

  test('each mock member has a track array with >=1 forecast point and the expected per-point fields', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    for (const m of out.gefs_ensemble!.members) {
      expect(typeof m.member_id).toBe('string');
      expect(m.member_id.length).toBeGreaterThan(0);
      expect(Array.isArray(m.track)).toBe(true);
      expect(m.track.length).toBeGreaterThanOrEqual(1);
      for (const pt of m.track) {
        expect(typeof pt.lat).toBe('number');
        expect(typeof pt.lng).toBe('number');
        expect(typeof pt.t_hours).toBe('number');
        expect(typeof pt.peak_wind).toBe('number');
      }
    }
  });

  test('mock ensemble is deterministic across calls (fixed seed)', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const a = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    const b = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(a.gefs_ensemble).toEqual(b.gefs_ensemble);
  });

  test('mock members differ from each other (perturbation applied)', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    const firstLngs = out.gefs_ensemble!.members.map((m) => m.track[0]!.lng);
    const uniq = new Set(firstLngs);
    expect(uniq.size).toBe(firstLngs.length);
    const peakWinds = out.gefs_ensemble!.members.map((m) => m.track[0]!.peak_wind);
    const uniqW = new Set(peakWinds);
    expect(uniqW.size).toBeGreaterThan(1);
  });

  test('live path: fetches GEFS ensemble from NHC AIDS endpoint', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    // First call serves the CONE_latest payload; second call serves the
    // ATCF ensemble feed. Subsequent CONE_<N>.json calls (priors) return
    // 404 so we don't drag in P2.22 noise here.
    let callIndex = 0;
    const atcfBody = [
      // Two ensemble members (AC01, AC02), 3 forecast hours each.
      'AL, 09, 2024091800, 03, AC01, 12, 240N,  830W,  85, 1000, HU',
      'AL, 09, 2024091800, 03, AC01, 24, 250N,  840W,  95,  990, HU',
      'AL, 09, 2024091800, 03, AC01, 36, 260N,  850W, 105,  980, HU',
      'AL, 09, 2024091800, 03, AC02, 12, 241N,  828W,  80, 1002, HU',
      'AL, 09, 2024091800, 03, AC02, 24, 252N,  836W,  90,  995, HU',
      // Non-ensemble runs (HWRF, official) must be filtered out.
      'AL, 09, 2024091800, 03, HWRF, 12, 245N,  835W,  92,  995, HU',
      'AL, 09, 2024091800, 03, OFCL, 12, 245N,  835W,  92,  995, HU',
    ].join('\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      callIndex++;
      const url = String(input);
      if (url.includes('CONE_latest')) {
        return new Response(
          JSON.stringify({
            features: [
              {
                properties: { ADVISNUM: '7', MAXWIND: 110 },
                geometry: { type: 'Polygon', coordinates: [[[0, 0]]] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('aid_public') || url.endsWith('.dat')) {
        return new Response(atcfBody, { status: 200 });
      }
      // Prior CONE_<N>.json calls — 404 to keep this test focused on ensemble.
      return new Response('not found', { status: 404 });
    });
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.source).toBe('live');
    expect(out.gefs_ensemble).toBeTruthy();
    // 2 ensemble members (AC01, AC02); non-ensemble runs filtered out.
    const ids = out.gefs_ensemble!.members.map((m) => m.member_id).sort();
    expect(ids).toEqual(['AC01', 'AC02']);
    const ac01 = out.gefs_ensemble!.members.find((m) => m.member_id === 'AC01')!;
    expect(ac01.track).toHaveLength(3);
    expect(ac01.track[0]!.lat).toBeCloseTo(24.0, 1);
    expect(ac01.track[0]!.lng).toBeCloseTo(-83.0, 1);
    expect(ac01.track[0]!.peak_wind).toBe(85);
    expect(ac01.track[0]!.t_hours).toBe(12);
    // fetch was invoked for both the CONE_latest and the ATCF feed.
    expect(callIndex).toBeGreaterThanOrEqual(2);
  });

  test('live path: returns null gefs_ensemble on fetch failure (graceful)', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('CONE_latest')) {
        return new Response(
          JSON.stringify({
            features: [
              {
                properties: { ADVISNUM: '7', MAXWIND: 110 },
                geometry: { type: 'Polygon', coordinates: [[[0, 0]]] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('aid_public') || url.endsWith('.dat')) {
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    });
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.source).toBe('live');
    expect(out.gefs_ensemble).toBeNull();
  });

  test('live path: returns null gefs_ensemble when ATCF body has no ensemble rows', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    // Body contains only non-ensemble model runs — must collapse to null.
    const atcfBody = [
      'AL, 09, 2024091800, 03, HWRF, 12, 245N,  835W,  92,  995, HU',
      'AL, 09, 2024091800, 03, OFCL, 12, 245N,  835W,  92,  995, HU',
    ].join('\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('CONE_latest')) {
        return new Response(
          JSON.stringify({
            features: [
              {
                properties: { ADVISNUM: '7', MAXWIND: 110 },
                geometry: { type: 'Polygon', coordinates: [[[0, 0]]] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('aid_public') || url.endsWith('.dat')) {
        return new Response(atcfBody, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.source).toBe('live');
    expect(out.gefs_ensemble).toBeNull();
  });
});
