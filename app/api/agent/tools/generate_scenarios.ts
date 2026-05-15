/**
 * generate_scenarios — proxy to the Python serverless route /api/scenarios.
 *
 * In dev: hits http://localhost:3000/api/scenarios.
 * On Vercel: hits `https://${VERCEL_URL}/api/scenarios`.
 */

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

function baseUrl(): string {
  if (process.env.FORGE_INTERNAL_BASE_URL) return process.env.FORGE_INTERNAL_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

function mockResponse(storm_id: string, n: number): Scenario[] {
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

export const generateScenarios = {
  name: 'generate_scenarios',
  description:
    'Generate ensemble hurricane scenarios (path + peak_wind + surge_grid + prob) for a storm_id. n defaults to 100 and is capped at 10000.',
  parameters: {
    type: 'object' as const,
    properties: {
      storm_id: { type: 'string', description: 'NHC storm identifier (e.g., AL092024)' },
      n: { type: 'number', description: 'Number of scenarios; default 100, max 10000.' },
    },
    required: ['storm_id'],
  },
  handler: async (args: GenerateScenariosArgs): Promise<Scenario[]> => {
    if (!args?.storm_id) throw new Error('storm_id required');
    const n = Math.min(Math.max(1, Number(args.n ?? 100)), 10000);
    if (process.env.FORGE_TOOLS_MODE === 'mock') {
      return mockResponse(args.storm_id, n);
    }
    try {
      const url = `${baseUrl()}/api/scenarios?storm_id=${encodeURIComponent(
        args.storm_id,
      )}&n=${n}`;
      const r = await fetch(url);
      if (!r.ok) return mockResponse(args.storm_id, n);
      return (await r.json()) as Scenario[];
    } catch {
      return mockResponse(args.storm_id, n);
    }
  },
};
