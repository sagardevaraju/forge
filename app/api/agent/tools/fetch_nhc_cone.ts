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
 *
 * Task P2.38 — the result also carries the GEFS ensemble forecast members
 * as `gefs_ensemble`. The live path scrapes the ATCF a-deck under
 *   https://ftp.nhc.noaa.gov/atcf/aid_public/a<basin><NN><YYYY>.dat
 * and filters to GEFS ensemble member tech codes (AC01..AC20, AP01..AP20).
 * Mock fallback returns 5 deterministic members (perturbed east/west of
 * the demo seed track) so the offline path still exercises the ensemble
 * code path through ml.scenarios.generate. The field is additive and
 * collapses to null when the upstream feed is empty or unreachable —
 * downstream code (the scenario generator) then falls back to the
 * parametric perturbation path.
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

/**
 * A single GEFS ensemble forecast track point. Distances are in degrees,
 * `t_hours` is hours from the advisory issue time, and `peak_wind` is in
 * knots (kt) per the ATCF a-deck convention. Task P2.38.
 */
export interface GefsEnsembleTrackPoint {
  lat: number;
  lng: number;
  t_hours: number;
  peak_wind: number;
}

/**
 * One member of the GEFS ensemble. `member_id` is the ATCF technique
 * code (e.g. "AC01"..."AC20" for the GEFS control/perturbation members,
 * "AP01"..."AP20" for the GEFS Parallel branch). Task P2.38.
 */
export interface GefsEnsembleMember {
  member_id: string;
  track: GefsEnsembleTrackPoint[];
}

/**
 * The full GEFS ensemble forecast for the current advisory. Null when
 * the upstream feed is empty or unreachable — downstream consumers
 * (notably the Python scenario generator) fall back to the parametric
 * perturbation path on null. Task P2.38.
 */
export interface GefsEnsemble {
  members: GefsEnsembleMember[];
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
  /**
   * GEFS ensemble forecast members for the current advisory. Null when
   * the upstream ATCF a-deck is empty or unreachable, in which case the
   * scenario generator falls back to its parametric path. Task P2.38.
   */
  gefs_ensemble: GefsEnsemble | null;
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

/**
 * Build a deterministic 5-member GEFS ensemble for the mock / offline
 * path. Each member is a 5-point track at 0/24/48/72/96h, shifted from
 * the canonical mock cone centerline by a fixed lat/lon offset and a
 * small per-member intensity jitter. This is the cheapest thing that
 * still exercises the Python ensemble code path in scenarios.generate.
 *
 * The shifts are deliberately deterministic (no RNG) so the test
 * fixtures stay byte-stable across runs.
 */
function mockGefsEnsemble(): GefsEnsemble {
  const baseLat = 24.0; // Cat-4 Gulf approach
  const baseLng = -83.0;
  // Each member: [memberId, lat offset (deg), lng offset (deg), wind jitter (kt)].
  // Offsets are unique per member so the resulting tracks are
  // distinguishable point-by-point (tests pin this).
  const memberSpecs: Array<[string, number, number, number]> = [
    ['AC01', 0.0, 0.2, 5], // east
    ['AC02', 0.0, -0.2, -5], // west
    ['AC03', 0.2, 0.05, 3], // NE-ish
    ['AC04', -0.2, -0.05, -3], // SW-ish
    ['AC05', 0.1, 0.1, 1], // NNE
  ];
  const members: GefsEnsembleMember[] = memberSpecs.map(
    ([member_id, latOff, lngOff, windOff]) => {
      // 5-point track at 0/24/48/72/96h tracking NNE toward FL.
      const track: GefsEnsembleTrackPoint[] = [0, 24, 48, 72, 96].map((t) => ({
        lat: Number((baseLat + latOff + (t / 96) * 5).toFixed(4)),
        lng: Number((baseLng + lngOff + (t / 96) * 2).toFixed(4)),
        t_hours: t,
        // 110 kt baseline, ramping to 130 kt at landfall, plus per-member jitter.
        peak_wind: 110 + Math.round((t / 96) * 20) + windOff,
      }));
      return { member_id, track };
    },
  );
  return { members };
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
    // Task P2.38 — 5-member deterministic GEFS ensemble. Offline / no-key
    // demos still exercise the ensemble path through ml.scenarios.generate.
    gefs_ensemble: mockGefsEnsemble(),
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

/**
 * Parse an ATCF-formatted lat token (e.g. "240N", "240S", "0N") to a
 * signed decimal degree. The third character is the hemisphere; the
 * leading digits are tenths of a degree.
 */
function parseAtcfLat(token: string): number | null {
  const m = token.trim().match(/^(-?\d+)([NS])$/i);
  if (!m) return null;
  const tenths = Number(m[1]);
  if (!Number.isFinite(tenths)) return null;
  const sign = m[2]!.toUpperCase() === 'S' ? -1 : 1;
  return (sign * tenths) / 10;
}

/**
 * Parse an ATCF-formatted lon token (e.g. "830W", "0E"). Western
 * longitudes are negative.
 */
function parseAtcfLon(token: string): number | null {
  const m = token.trim().match(/^(-?\d+)([EW])$/i);
  if (!m) return null;
  const tenths = Number(m[1]);
  if (!Number.isFinite(tenths)) return null;
  const sign = m[2]!.toUpperCase() === 'W' ? -1 : 1;
  return (sign * tenths) / 10;
}

/**
 * GEFS ensemble technique codes published by NHC under the a-deck. We
 * match both the perturbation branch (AC01..AC20) and the parallel
 * branch (AP01..AP20). The control members (AC00 / AP00) are also
 * included as legitimate ensemble seeds.
 */
function isGefsEnsembleTech(tech: string): boolean {
  const t = tech.trim().toUpperCase();
  return /^A[CP](?:0\d|1\d|20)$/.test(t);
}

/**
 * Parse the ATCF a-deck text body served by NHC's AIDS feed into a
 * GefsEnsemble. Each non-empty line is a comma-separated record; the
 * column order is fixed by the ATCF spec (BASIN, CY, YYYYMMDDHH,
 * TECHNUM, TECH, TAU, LatN, LonW, VMAX, MSLP, TY, …). We filter to
 * GEFS ensemble tech codes only and surface (lat, lng, t_hours,
 * peak_wind) per forecast row. Returns null when no GEFS rows are
 * present (caller collapses to null for the downstream consumer).
 */
function parseGefsAtcf(body: string): GefsEnsemble | null {
  const memberMap = new Map<string, GefsEnsembleTrackPoint[]>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 9) continue;
    const tech = cols[4] ?? '';
    if (!isGefsEnsembleTech(tech)) continue;
    const tau = Number(cols[5]);
    const lat = parseAtcfLat(cols[6] ?? '');
    const lng = parseAtcfLon(cols[7] ?? '');
    const vmax = Number(cols[8]);
    if (!Number.isFinite(tau) || lat === null || lng === null || !Number.isFinite(vmax)) {
      continue;
    }
    const memberId = tech.toUpperCase();
    const arr = memberMap.get(memberId) ?? [];
    arr.push({ lat, lng, t_hours: tau, peak_wind: vmax });
    memberMap.set(memberId, arr);
  }
  if (memberMap.size === 0) return null;
  const members: GefsEnsembleMember[] = Array.from(memberMap.entries())
    .map(([member_id, track]) => ({
      member_id,
      track: track.slice().sort((a, b) => a.t_hours - b.t_hours),
    }))
    .sort((a, b) => a.member_id.localeCompare(b.member_id));
  return { members };
}

/**
 * Build the NHC AIDS a-deck URL for the given storm id. ``AL092024`` →
 * ``https://ftp.nhc.noaa.gov/atcf/aid_public/aal092024.dat``. Returns
 * null when the storm_id does not match the BASIN+NN+YYYY shape.
 */
function atcfUrl(storm_id: string): string | null {
  const m = storm_id.trim().toUpperCase().match(/^([A-Z]{2})(\d{2})(\d{4})$/);
  if (!m) return null;
  const basin = m[1]!.toLowerCase();
  const num = m[2];
  const year = m[3];
  return `https://ftp.nhc.noaa.gov/atcf/aid_public/a${basin}${num}${year}.dat`;
}

/**
 * Fetch the GEFS ensemble for a storm from NHC's AIDS a-deck. Returns
 * null on any failure (404, parse error, no GEFS rows). Callers
 * propagate the null through the response so downstream code can fall
 * back to the parametric scenario generator. Task P2.38.
 */
async function tryLiveGefsEnsemble(storm_id: string): Promise<GefsEnsemble | null> {
  const url = atcfUrl(storm_id);
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const body = await r.text();
    return parseGefsAtcf(body);
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
  // Task P2.38 — pull the GEFS ensemble from NHC AIDS. Failures collapse
  // to null so the Python scenario generator falls back to parametric.
  const gefs_ensemble = await tryLiveGefsEnsemble(storm_id);
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
    gefs_ensemble,
    source: 'live',
  };
}

export const fetchNhcCone = {
  name: 'fetch_nhc_cone',
  description:
    'Fetch the latest National Hurricane Center forecast cone polygon (GeoJSON) plus advisory number and peak sustained wind (kt) for a given storm id (e.g., AL092024). Also returns up to 4 prior advisories as a `prior_cones` ribbon (most recent first) for trend visualisation, and (when available) the GEFS ensemble forecast members as `gefs_ensemble` for use as a scenario-generator input distribution.',
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
