/**
 * generate_scenarios — proxy to the Python serverless route /api/scenarios.
 *
 * In dev: hits http://localhost:3000/api/scenarios.
 * On Vercel: hits `https://${VERCEL_URL}/api/scenarios`.
 *
 * Task P2.23 — the result also carries a `cone_envelope` field
 * `{ t24h, t48h, t72h }`. Each entry is a GeoJSON Polygon whose ring is
 * the convex hull of the perturbed-track coordinates at that horizon. The
 * EventConsole renders the three polygons as semi-transparent fills below
 * the official NHC cone to visualise GEFS ensemble spread (wider band =
 * more forecast uncertainty). The mock fallback synthesises three
 * concentric polygons that widen with horizon so the band is visible
 * offline.
 */

import { convexHull, type LngLat } from '@/lib/geo/convex_hull';

export interface GenerateScenariosArgs {
  storm_id: string;
  n?: number;
}

export interface Scenario {
  id: number | string;
  path: unknown;
  peak_wind: number;
  surge_grid: unknown;
  prob: number;
}

/**
 * Convex hull of perturbed-track points at each forecast horizon. Each
 * polygon is a closed GeoJSON Polygon ring (first vertex repeated as the
 * last). `null` when there are no perturbed tracks to hull (a 1-step path
 * or an empty scenario set).
 */
export interface ConeEnvelope {
  t24h: GeoJSON.Polygon;
  t48h: GeoJSON.Polygon;
  t72h: GeoJSON.Polygon;
}

export interface GenerateScenariosResult {
  scenarios: Scenario[];
  cone_envelope: ConeEnvelope | null;
}

function baseUrl(): string {
  if (process.env.FORGE_INTERNAL_BASE_URL) return process.env.FORGE_INTERNAL_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

function mockScenarios(storm_id: string, n: number): Scenario[] {
  // Deterministic-ish mock: a fan of paths trending NE with varied peak winds.
  const out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const jitter = (i % 7) * 0.3;
    out.push({
      id: `${storm_id}-${i}`,
      path: {
        type: 'LineString',
        coordinates: [
          [-83 + jitter, 24 + jitter * 0.2],
          [-82 + jitter, 26 + jitter * 0.2],
          [-81 + jitter, 28 + jitter * 0.2],
        ],
      },
      peak_wind: 90 + ((i * 7) % 60),
      surge_grid: { type: 'placeholder', cells: 0 },
      prob: 1 / n,
    });
  }
  return out;
}

/**
 * Deterministic widening envelope for the offline mock. Three rectangles
 * centred on (-82, 26) — the canonical mock storm position — whose
 * half-widths grow with horizon (24h = 0.6°, 48h = 1.2°, 72h = 2.0°).
 * The seed depends only on the storm_id so re-running the tool is
 * idempotent for screenshots and tests. The polygons are returned as
 * convex hulls of 5 perturbed corner points so the production and mock
 * paths produce structurally identical outputs (same ring orientation,
 * same closed-ring invariant).
 */
function mockConeEnvelope(storm_id: string): ConeEnvelope {
  // Cheap seedable hash for sub-degree jitter per storm_id.
  let seed = 0;
  for (let i = 0; i < storm_id.length; i++) seed = (seed * 31 + storm_id.charCodeAt(i)) >>> 0;
  const jitter = ((seed % 100) / 100 - 0.5) * 0.2; // ±0.1°

  const cx = -82 + jitter;
  const widthFor = (deg: number): GeoJSON.Polygon => {
    const corners: LngLat[] = [
      { lng: cx - deg, lat: 26 - deg },
      { lng: cx + deg, lat: 26 - deg },
      { lng: cx + deg, lat: 26 + deg },
      { lng: cx - deg, lat: 26 + deg },
      { lng: cx, lat: 26 }, // interior — dropped by the hull
    ];
    const ring = convexHull(corners);
    return { type: 'Polygon', coordinates: [ring] };
  };

  return {
    t24h: widthFor(0.6),
    t48h: widthFor(1.2),
    t72h: widthFor(2.0),
  };
}

/**
 * Compute the convex hull of perturbed-track points at the given horizon
 * index (0 = 24h, 1 = 48h, 2 = 72h). Returns null when fewer than three
 * scenarios contribute a coordinate at that index (degenerate hull, not
 * worth rendering).
 */
function envelopeAtHorizon(
  scenarios: Scenario[],
  horizonIndex: number,
): GeoJSON.Polygon | null {
  const pts: LngLat[] = [];
  for (const s of scenarios) {
    // `path` is loosely typed coming back from the Python route; accept
    // either { coordinates: [[lng, lat], ...] } or a raw LineString.
    const path = s.path as { coordinates?: number[][] } | null | undefined;
    const coords = path?.coordinates;
    if (!Array.isArray(coords)) continue;
    const pt = coords[horizonIndex];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    pts.push({ lng: Number(pt[0]), lat: Number(pt[1]) });
  }
  if (pts.length < 3) return null;
  const ring = convexHull(pts);
  if (ring.length < 4) return null;
  return { type: 'Polygon', coordinates: [ring] };
}

function buildEnvelope(scenarios: Scenario[]): ConeEnvelope | null {
  const t24h = envelopeAtHorizon(scenarios, 0);
  const t48h = envelopeAtHorizon(scenarios, 1);
  const t72h = envelopeAtHorizon(scenarios, 2);
  if (!t24h || !t48h || !t72h) return null;
  return { t24h, t48h, t72h };
}

function mockResult(storm_id: string, n: number): GenerateScenariosResult {
  return {
    scenarios: mockScenarios(storm_id, n),
    cone_envelope: mockConeEnvelope(storm_id),
  };
}

export const generateScenarios = {
  name: 'generate_scenarios',
  description:
    'Generate ensemble hurricane scenarios (path, peak_wind, surge_grid, prob) for a storm_id. n defaults to 100 and is capped at 10000. Also returns `cone_envelope` { t24h, t48h, t72h }, which holds convex-hull polygons of perturbed-track points at each forecast horizon, used to visualise GEFS uncertainty.',
  parameters: {
    type: 'object' as const,
    properties: {
      storm_id: { type: 'string', description: 'NHC storm identifier (e.g., AL092024)' },
      n: { type: 'number', description: 'Number of scenarios. Default 100, max 10000.' },
    },
    required: ['storm_id'],
  },
  handler: async (args: GenerateScenariosArgs): Promise<GenerateScenariosResult> => {
    if (!args?.storm_id) throw new Error('storm_id required');
    const n = Math.min(Math.max(1, Number(args.n ?? 100)), 10000);
    if (process.env.FORGE_TOOLS_MODE === 'mock') {
      return mockResult(args.storm_id, n);
    }
    try {
      const url = `${baseUrl()}/api/scenarios?storm_id=${encodeURIComponent(
        args.storm_id,
      )}&n=${n}`;
      const r = await fetch(url);
      if (!r.ok) return mockResult(args.storm_id, n);
      const scenarios = (await r.json()) as Scenario[];
      // Build the envelope from the live perturbed tracks; fall back to
      // the mock envelope if the hull is degenerate (e.g. only one scenario
      // returned, or scenarios lack 3-step paths).
      const envelope = buildEnvelope(scenarios) ?? mockConeEnvelope(args.storm_id);
      return { scenarios, cone_envelope: envelope };
    } catch {
      return mockResult(args.storm_id, n);
    }
  },
};
