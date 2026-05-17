/**
 * Task P2.23 — generate_scenarios cone-envelope tests.
 *
 * The tool is required to return an additional `cone_envelope`
 * { t24h, t48h, t72h } field — each a GeoJSON Polygon whose ring is the
 * convex hull of the perturbed track points at that horizon. Uncertainty
 * grows with horizon, so the t72h polygon must be strictly larger (by
 * bounding-box area) than the t24h polygon.
 *
 * Mock mode is asserted directly (FORGE_TOOLS_MODE=mock). The "live mode
 * returns convex hull of perturbed tracks" assertion stubs global fetch so
 * we can return a deterministic perturbed-track payload without spinning
 * up Python.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateScenarios } from '@/app/api/agent/tools/generate_scenarios';

function bboxArea(poly: GeoJSON.Polygon): number {
  const ring = poly.coordinates[0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}

describe('generate_scenarios · cone_envelope (Task P2.23)', () => {
  const origMode = process.env.FORGE_TOOLS_MODE;

  beforeEach(() => {
    process.env.FORGE_TOOLS_MODE = 'mock';
  });

  afterEach(() => {
    if (origMode === undefined) delete process.env.FORGE_TOOLS_MODE;
    else process.env.FORGE_TOOLS_MODE = origMode;
    vi.restoreAllMocks();
  });

  test('returns cone_envelope with three closed polygons in mock mode', async () => {
    const out = await generateScenarios.handler({ storm_id: 'AL092024', n: 50 });
    expect(out.cone_envelope).not.toBeNull();
    const env = out.cone_envelope!;
    for (const horizon of ['t24h', 't48h', 't72h'] as const) {
      const poly = env[horizon];
      expect(poly.type).toBe('Polygon');
      const ring = poly.coordinates[0];
      // At least a triangle (3 unique pts + closing repeat).
      expect(ring.length).toBeGreaterThanOrEqual(4);
      // Ring is closed.
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  test('uncertainty grows with horizon: t72h polygon bbox > t48h > t24h', async () => {
    const out = await generateScenarios.handler({ storm_id: 'AL092024', n: 50 });
    const env = out.cone_envelope!;
    const a24 = bboxArea(env.t24h);
    const a48 = bboxArea(env.t48h);
    const a72 = bboxArea(env.t72h);
    expect(a48).toBeGreaterThan(a24);
    expect(a72).toBeGreaterThan(a48);
  });

  test('scenarios array still works (regression-safe against P2.22 / older callers)', async () => {
    const out = await generateScenarios.handler({ storm_id: 'AL092024', n: 5 });
    expect(Array.isArray(out.scenarios)).toBe(true);
    expect(out.scenarios.length).toBe(5);
    // Each scenario still carries the old fields.
    for (const s of out.scenarios) {
      expect(s.peak_wind).toBeTypeOf('number');
      expect(s.prob).toBeTypeOf('number');
    }
  });

  test('live mode: computes convex hull from perturbed tracks returned by /api/scenarios', async () => {
    delete process.env.FORGE_TOOLS_MODE; // force the live path
    // Synthetic perturbed track set: each scenario has a 3-step LineString.
    // Points at index 0 → 24h, index 1 → 48h, index 2 → 72h. The 24h
    // cluster is tight, the 72h cluster is fanned out — so bbox at 72h
    // must be strictly larger than bbox at 24h.
    const fakeScenarios = [
      { id: 0, path: { type: 'LineString', coordinates: [[-83, 24], [-82, 27], [-80, 30]] }, peak_wind: 95, surge_grid: {}, prob: 0.25 },
      { id: 1, path: { type: 'LineString', coordinates: [[-83.05, 24.05], [-81.5, 27.5], [-78, 31]] }, peak_wind: 105, surge_grid: {}, prob: 0.25 },
      { id: 2, path: { type: 'LineString', coordinates: [[-82.95, 23.95], [-82.5, 26.5], [-82, 29]] }, peak_wind: 100, surge_grid: {}, prob: 0.25 },
      { id: 3, path: { type: 'LineString', coordinates: [[-83.02, 24.02], [-82.1, 27.1], [-77, 32]] }, peak_wind: 110, surge_grid: {}, prob: 0.25 },
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(fakeScenarios), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await generateScenarios.handler({ storm_id: 'AL092024', n: 4 });
    expect(fetchSpy).toHaveBeenCalled();
    expect(out.cone_envelope).not.toBeNull();
    const env = out.cone_envelope!;
    const a24 = bboxArea(env.t24h);
    const a72 = bboxArea(env.t72h);
    expect(a72).toBeGreaterThan(a24);
    // Hull at t24h should contain the tight cluster (all points within ~0.1°).
    expect(a24).toBeLessThan(1.0);
    // Hull at t72h spans roughly 5° lng × 3° lat.
    expect(a72).toBeGreaterThan(5.0);
  });
});
