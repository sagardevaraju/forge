// @vitest-environment node
/**
 * fetch_active_storms — auto-discover currently-active NHC storms.
 *
 * Covers:
 *   - FORGE_TOOLS_MODE=mock returns the demo storm (Helene)
 *   - Live success returns parsed storms with `source: 'live'`
 *   - Empty live response returns `[]` with `source: 'live'` (NOT a mock
 *     fallback — empty is a legitimate "Atlantic basin quiet" signal)
 *   - HTTP failure falls back to mock
 *   - Thrown fetch falls back to mock
 *   - `basin` filter narrows the result
 *   - `pickRelevantStorm` ranks MH > HU > TS > TD, then by intensity, then
 *     by distance to the FL reference point.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchActiveStorms,
  pickRelevantStorm,
  type ActiveStorm,
} from '@/app/api/agent/tools/fetch_active_storms';

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

describe('fetch_active_storms — mock fallback', () => {
  test('FORGE_TOOLS_MODE=mock returns the demo AL092024 storm', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const out = await fetchActiveStorms.handler({});
    expect(out.source).toBe('mock');
    expect(out.storms).toHaveLength(1);
    expect(out.storms[0].id).toBe('AL092024');
    expect(out.storms[0].name).toBe('HELENE');
    expect(out.storms[0].classification).toBe('HU');
    expect(out.storms[0].basin).toBe('AL');
  });

  test('basin filter removes non-matching storms in mock', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const ep = await fetchActiveStorms.handler({ basin: 'EP' });
    expect(ep.storms).toHaveLength(0);
    const al = await fetchActiveStorms.handler({ basin: 'al' });
    expect(al.storms).toHaveLength(1);
  });
});

describe('fetch_active_storms — live path', () => {
  test('parses NHC CurrentStorms.json into ActiveStorm[]', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          activeStorms: [
            {
              id: 'AL012026',
              name: 'Alex',
              classification: 'HU',
              intensity: '95',
              pressure: 970,
              latitudeNumeric: 26.4,
              longitudeNumeric: -81.2,
              lastUpdate: '2026-08-15T18:00:00Z',
            },
            {
              id: 'EP022026',
              name: 'Blas',
              classification: 'TS',
              intensity: 55,
              latitude: '20.1N',
              longitude: '110.0W',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await fetchActiveStorms.handler({});
    expect(out.source).toBe('live');
    expect(out.storms).toHaveLength(2);
    const alex = out.storms.find((s) => s.id === 'AL012026')!;
    expect(alex.name).toBe('Alex');
    expect(alex.classification).toBe('HU');
    expect(alex.intensity_kt).toBe(95);
    expect(alex.pressure_mb).toBe(970);
    expect(alex.latitude).toBeCloseTo(26.4, 3);
    expect(alex.longitude).toBeCloseTo(-81.2, 3);
    const blas = out.storms.find((s) => s.id === 'EP022026')!;
    expect(blas.latitude).toBeCloseTo(20.1, 3);
    expect(blas.longitude).toBeCloseTo(-110.0, 3);
    expect(blas.basin).toBe('EP');
  });

  test('empty activeStorms returns [] with source=live (no mock fallback)', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ activeStorms: [] }), { status: 200 }),
    );
    const out = await fetchActiveStorms.handler({});
    expect(out.source).toBe('live');
    expect(out.storms).toEqual([]);
  });

  test('basin filter narrows the live response', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          activeStorms: [
            { id: 'AL012026', classification: 'TS', intensity: 50 },
            { id: 'EP022026', classification: 'HU', intensity: 90 },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await fetchActiveStorms.handler({ basin: 'AL' });
    expect(out.storms).toHaveLength(1);
    expect(out.storms[0].id).toBe('AL012026');
  });

  test('HTTP failure falls back to mock', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('boom', { status: 500 }),
    );
    const out = await fetchActiveStorms.handler({});
    expect(out.source).toBe('mock');
    expect(out.storms[0].id).toBe('AL092024');
  });

  test('thrown fetch falls back to mock', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down');
    });
    const out = await fetchActiveStorms.handler({});
    expect(out.source).toBe('mock');
    expect(out.storms[0].id).toBe('AL092024');
  });

  test('malformed records (missing id) are skipped, not thrown', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          activeStorms: [
            { name: 'Anonymous' }, // no id → skipped
            { id: 'AL012026', classification: 'TS' },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await fetchActiveStorms.handler({});
    expect(out.source).toBe('live');
    expect(out.storms).toHaveLength(1);
    expect(out.storms[0].id).toBe('AL012026');
  });
});

describe('pickRelevantStorm', () => {
  const mk = (over: Partial<ActiveStorm>): ActiveStorm => ({
    id: over.id ?? 'AL010000',
    basin: 'AL',
    name: null,
    classification: null,
    intensity_kt: null,
    pressure_mb: null,
    latitude: null,
    longitude: null,
    last_update: null,
    ...over,
  });

  test('returns null on empty input', () => {
    expect(pickRelevantStorm([])).toBeNull();
  });

  test('MH outranks HU outranks TS outranks TD', () => {
    const td = mk({ id: 'AL01', classification: 'TD', intensity_kt: 35 });
    const ts = mk({ id: 'AL02', classification: 'TS', intensity_kt: 55 });
    const hu = mk({ id: 'AL03', classification: 'HU', intensity_kt: 80 });
    const mh = mk({ id: 'AL04', classification: 'MH', intensity_kt: 115 });
    expect(pickRelevantStorm([td, ts, hu, mh])!.id).toBe('AL04');
    expect(pickRelevantStorm([td, ts, hu])!.id).toBe('AL03');
    expect(pickRelevantStorm([td, ts])!.id).toBe('AL02');
  });

  test('breaks ties by intensity', () => {
    const a = mk({ id: 'AL01', classification: 'HU', intensity_kt: 80 });
    const b = mk({ id: 'AL02', classification: 'HU', intensity_kt: 110 });
    expect(pickRelevantStorm([a, b])!.id).toBe('AL02');
  });

  test('breaks further ties by proximity to FL reference', () => {
    // Same classification + intensity; storm closer to (28, -82) wins.
    const close = mk({
      id: 'AL01',
      classification: 'HU',
      intensity_kt: 90,
      latitude: 27,
      longitude: -83,
    });
    const far = mk({
      id: 'AL02',
      classification: 'HU',
      intensity_kt: 90,
      latitude: 15,
      longitude: -55,
    });
    expect(pickRelevantStorm([far, close])!.id).toBe('AL01');
  });
});
