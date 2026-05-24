// @vitest-environment node
/**
 * Task P3.10 — /api/cv/infer route tests (de-Vercel'd CV inference).
 *
 * Tests the mock-fallback shortcut path (FORGE_TOOLS_MODE=mock) so the
 * route can be exercised without spawning Python in unit tests. The
 * stdin shim contract is covered separately in
 * tests/api/test_cv_inference_stdin.py.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/cv/infer/route';

const originalEnv = { ...process.env };

beforeEach(() => {
  // Force the mock-fallback path so we don't spawn Python in CI.
  process.env.FORGE_TOOLS_MODE = 'mock';
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/cv/infer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/cv/infer (Task P3.10)', () => {
  test('returns 8-dim feature vector for a valid request', async () => {
    const res = await POST(makeRequest({ lat: 28.5, lon: -82.5 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.features)).toBe(true);
    expect(body.features).toHaveLength(8);
    for (const v of body.features) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(body.feature_names).toEqual([
      'vegetation_density',
      'impervious_surface',
      'fuel_proximity',
      'roof_condition_proxy',
      'water_proximity',
      'elevation_bucket',
      'ndvi_seasonal_var',
      'structure_density',
    ]);
    expect(body.mode_used).toBe('mock');
    expect(body.bypass_head_used).toBe(true);
  });

  test('rejects request without lat / lon', async () => {
    const res = await POST(makeRequest({ mode: 'mock' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/lat and lon are required/);
  });

  test('rejects invalid mode', async () => {
    const res = await POST(makeRequest({ lat: 28.5, lon: -82.5, mode: 'banana' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid mode/);
  });

  test('rejects mode=cached without policy_id', async () => {
    const res = await POST(makeRequest({ lat: 28.5, lon: -82.5, mode: 'cached' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/policy_id/);
  });

  test('rejects invalid JSON body', async () => {
    const req = new Request('http://localhost/api/cv/infer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test('different (lat, lon) yields different features (mock contract)', async () => {
    const a = await (await POST(makeRequest({ lat: 28.5, lon: -82.5 }))).json();
    const b = await (await POST(makeRequest({ lat: 35.0, lon: -97.0 }))).json();
    // Mock fallback is hash(lat, lon) based — distinct points yield
    // distinct vectors.
    expect(a.features).not.toEqual(b.features);
  });

  test('same (lat, lon) is deterministic', async () => {
    const a = await (await POST(makeRequest({ lat: 28.5, lon: -82.5 }))).json();
    const b = await (await POST(makeRequest({ lat: 28.5, lon: -82.5 }))).json();
    expect(a.features).toEqual(b.features);
  });

  test('mode=cached with policy_id is accepted (mock fallback path)', async () => {
    const res = await POST(makeRequest({
      lat: 28.5,
      lon: -82.5,
      mode: 'cached',
      policy_id: 12345,
    }));
    expect(res.status).toBe(200);
  });
});
