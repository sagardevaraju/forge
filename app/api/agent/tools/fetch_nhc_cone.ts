/**
 * fetch_nhc_cone — National Hurricane Center cone forecast lookup.
 *
 * The NHC publishes per-storm graphics + JSON under
 *   https://www.nhc.noaa.gov/storm_graphics/api/<storm_id>_CONE_latest.json
 * Real fetch is attempted first; falls back to a deterministic mock when the
 * env requests it (FORGE_TOOLS_MODE=mock), the storm_id matches a demo id, or
 * the fetch fails for any reason.
 *
 * Task P2.22 — the result also carries up to 4 prior advisories' cones as a
 * `prior_cones` ribbon. The EventConsole stacks these as faint outlines
 * under the current cone so the operator can see how the forecast has
 * shifted over the last ~24h. The field is additive: legacy callers that
 * ignore it get the previous behaviour; missing/empty priors render as a
 * single cone with no regression. The live path fetches each prior URL
 * independently and tolerates individual 404s — one missing advisory does
 * not block the rest of the response.
 */

export interface FetchNhcConeArgs {
  storm_id: string;
}

/**
 * A single prior advisory's cone, surfaced as part of the multi-advisory
 * ribbon (Task P2.22). `advisory_number` is numeric (so we can sort desc),
 * `issued_at` is an ISO-8601 string (so the UI can compute a "-6h"-style
 * relative label), and `cone` is the GeoJSON feature in the same shape as
 * the top-level `cone` field.
 */
export interface PriorCone {
  advisory_number: number;
  issued_at: string;
  cone: unknown;
}

export interface FetchNhcConeResult {
  cone: unknown;
  advisory_number: string;
  peak_wind: number;
  /**
   * Peak wind (mph) reported on the immediately-preceding advisory. The
   * ThreatBanner (Task 5) uses this to compute the delta-since-prior chip
   * surfaced in Task 23. Null when no prior advisory is available (first
   * advisory, archive miss, or the live path is unable to resolve it).
   */
  prior_peak_wind: number | null;
  /**
   * Up to the last 4 prior advisories' cones, most recent first. Empty when
   * unavailable (first advisory, archive miss, or every per-prior fetch
   * failed). Task P2.22 — the EventConsole renders these as a faint
   * outline ribbon under the current cone.
   */
  prior_cones: PriorCone[];
  source: 'live' | 'mock';
}

/**
 * Build a deterministic mock prior cone shifted east by `offsetDeg` from the
 * canonical mock polygon. Each prior also widens slightly (the historical
 * cone grew over the run-up) so the ribbon reads visually as a fanning
 * uncertainty envelope rather than parallel translation.
 */
function mockPriorCone(
  storm_id: string,
  advisory_number: number,
  issued_at: string,
  offsetDeg: number,
  widening: number,
): PriorCone {
  // Base polygon mirrors mockResponse's cone but shifted east + slightly
  // bigger so the ribbon is visible without overpowering the current cone.
  const cone = {
    type: 'Feature' as const,
    properties: {
      storm_id,
      basin: 'AL',
      stormType: 'HU',
      ADVISNUM: String(advisory_number),
      historical: true,
    },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-85.0 + offsetDeg - widening, 24.0 - widening],
          [-83.5 + offsetDeg, 25.5],
          [-82.0 + offsetDeg, 27.0],
          [-81.0 + offsetDeg, 28.5],
          [-80.5 + offsetDeg + widening, 30.0 + widening],
          [-82.0 + offsetDeg, 29.5],
          [-83.5 + offsetDeg, 28.0],
          [-85.0 + offsetDeg - widening, 26.5],
          [-86.5 + offsetDeg - widening, 25.0],
          [-85.0 + offsetDeg - widening, 24.0 - widening],
        ],
      ],
    },
  };
  return { advisory_number, issued_at, cone };
}

function mockResponse(storm_id: string): FetchNhcConeResult {
  // A plausible Florida-gulf cone polygon (a fat ellipse-ish ring).
  const cone = {
    type: 'Feature',
    properties: { storm_id, basin: 'AL', stormType: 'HU' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-85.0, 24.0],
          [-83.5, 25.5],
          [-82.0, 27.0],
          [-81.0, 28.5],
          [-80.5, 30.0],
          [-82.0, 29.5],
          [-83.5, 28.0],
          [-85.0, 26.5],
          [-86.5, 25.0],
          [-85.0, 24.0],
        ],
      ],
    },
  };
  // Task P2.22 — three prior advisories at roughly -6h / -12h / -18h relative
  // to the current. The deterministic 0.2°-east shift per step yields a
  // visible ribbon in the dev / offline experience and is also the cheapest
  // proxy for "forecast track has drifted east" — the most operationally
  // relevant motion. Advisory numbers (13, 12, 11) decrement from the
  // current "14A" so the ribbon labels stay consistent with the headline.
  const prior_cones: PriorCone[] = [
    mockPriorCone(storm_id, 13, '2026-05-16T18:00:00Z', 0.2, 0.0),
    mockPriorCone(storm_id, 12, '2026-05-16T12:00:00Z', 0.4, 0.15),
    mockPriorCone(storm_id, 11, '2026-05-16T06:00:00Z', 0.6, 0.3),
  ];
  // Task 23: prior advisory's peak wind seeds the delta chip. The demo's
  // current peak_wind of 142 (set when the cone refreshes against a fresh
  // advisory) renders a +7 mph swing against this 135 mph baseline.
  return {
    cone,
    advisory_number: '14A',
    peak_wind: 142,
    prior_peak_wind: 135,
    prior_cones,
    source: 'mock',
  };
}

interface RawConeFeature {
  properties?: { ADVISNUM?: string; MAXWIND?: number; ADVDATE?: string };
  geometry?: unknown;
}

interface RawConeResponse {
  features?: RawConeFeature[];
}

/**
 * Fetch a single CONE_<n>.json from the NHC archive for the given storm
 * and advisory number, returning a PriorCone shaped record. Returns null
 * on any failure (404, parse error, missing feature) — callers skip nulls
 * so a single missing advisory never blocks the rest of the response.
 *
 * NHC's archive layout for "advisory N of storm S" is not a uniform path
 * across years/basins, so this URL is best-effort: it mirrors the same
 * CONE_latest convention with a numeric suffix. When NHC serves it, great;
 * when it 404s, we skip. The defensive shape is deliberate per the
 * P2.22 spec — "if it 404s, skip that one and move on. Don't block the
 * response if priors fail."
 */
async function tryLivePrior(
  storm_id: string,
  advisory_number: number,
): Promise<PriorCone | null> {
  const url = `https://www.nhc.noaa.gov/storm_graphics/api/${encodeURIComponent(
    storm_id,
  )}_CONE_${advisory_number}.json`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = (await r.json()) as RawConeResponse;
    const feat = data.features?.[0];
    if (!feat) return null;
    // Parse the upstream advisory number when available; otherwise fall
    // back to the request-side number so callers can still sort.
    const rawAdvis = feat.properties?.ADVISNUM;
    const numeric = rawAdvis != null ? Number(String(rawAdvis).replace(/[^0-9]/g, '')) : NaN;
    return {
      advisory_number: Number.isFinite(numeric) && numeric > 0 ? numeric : advisory_number,
      issued_at: feat.properties?.ADVDATE ?? '',
      cone: feat,
    };
  } catch {
    return null;
  }
}

async function tryLive(storm_id: string): Promise<FetchNhcConeResult | null> {
  const url = `https://www.nhc.noaa.gov/storm_graphics/api/${encodeURIComponent(
    storm_id,
  )}_CONE_latest.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = (await r.json()) as RawConeResponse;
  const feat = data.features?.[0];
  if (!feat) return null;
  // Task P2.22 — derive the current advisory number numerically so we can
  // step back to fetch up to 4 prior advisories. ADVISNUM strings can have
  // trailing letters (e.g. "14A" for an intermediate advisory); stripping
  // non-digits collapses those to the underlying integer.
  const rawAdvis = String(feat.properties?.ADVISNUM ?? '');
  const currentNumeric = Number(rawAdvis.replace(/[^0-9]/g, ''));
  const prior_cones: PriorCone[] = [];
  if (Number.isFinite(currentNumeric) && currentNumeric > 1) {
    // Fetch priors sequentially so the request volume stays bounded; the 4
    // attempts are cheap on a fast network and tolerable on a slow one. A
    // 404 on any single prior just drops it from the ribbon.
    for (let step = 1; step <= 4 && currentNumeric - step >= 1; step++) {
      const prior = await tryLivePrior(storm_id, currentNumeric - step);
      if (prior) prior_cones.push(prior);
    }
  }
  // Most recent first — desc by advisory_number.
  prior_cones.sort((a, b) => b.advisory_number - a.advisory_number);
  // Task 23: the NHC archive layout for a prior advisory varies by storm and
  // does not expose a stable, side-effect-free "latest minus one" endpoint
  // from this CONE_latest.json payload alone. Defer the live-path lookup —
  // the mock fallback covers the demo and the banner copes with `null` by
  // suppressing the delta chip.
  return {
    cone: feat,
    advisory_number: String(feat.properties?.ADVISNUM ?? ''),
    peak_wind: Number(feat.properties?.MAXWIND ?? 0),
    prior_peak_wind: null,
    prior_cones,
    source: 'live',
  };
}

export const fetchNhcCone = {
  name: 'fetch_nhc_cone',
  description:
    'Fetch the latest National Hurricane Center forecast cone polygon (GeoJSON) plus advisory number and peak sustained wind (kt) for a given storm id (e.g., AL092024). Also returns up to 4 prior advisories as a `prior_cones` ribbon (most recent first) for trend visualisation.',
  parameters: {
    type: 'object' as const,
    properties: {
      storm_id: {
        type: 'string',
        description:
          'NHC storm identifier in the form BASIN+NUMBER+YEAR (e.g., AL092024 for Atlantic, storm #9, 2024)',
      },
    },
    required: ['storm_id'],
  },
  handler: async (args: FetchNhcConeArgs): Promise<FetchNhcConeResult> => {
    if (!args?.storm_id) {
      throw new Error('storm_id required');
    }
    if (process.env.FORGE_TOOLS_MODE === 'mock') {
      return mockResponse(args.storm_id);
    }
    try {
      const live = await tryLive(args.storm_id);
      if (live) return live;
      return mockResponse(args.storm_id);
    } catch {
      return mockResponse(args.storm_id);
    }
  },
};
