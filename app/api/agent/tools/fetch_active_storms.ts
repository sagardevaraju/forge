/**
 * fetch_active_storms — Auto-discover currently-active NHC storms.
 *
 * NHC publishes the live active-storm index at:
 *   https://www.nhc.noaa.gov/CurrentStorms.json
 *
 * Shape (abridged) — top level is `{ activeStorms: [...] }`. Each entry
 * carries `id`, `name`, `binNumber`, `classification`, `intensity` (kt),
 * `pressure`, `latitude` / `latitudeNumeric`, `longitude` /
 * `longitudeNumeric`, `movementDir`, `movementSpeed`, `lastUpdate`, plus a
 * `forecastTrack` block we don't unwrap here (the cone tool already handles
 * that per storm).
 *
 * This tool is the *first* call in any live-event flow: the caller pulls
 * the list, picks one (typically via `pickRelevantStorm` below), and then
 * passes that `id` to `fetch_nhc_cone` / `generate_scenarios` / etc. We
 * deliberately do NOT fall back to a demo storm inside this tool — the
 * caller (page or agent) decides whether "no active storms" means "render
 * the calm state" or "show the historical demo for this surface." That
 * separation keeps the tool truthful: a `live` source with zero storms is
 * legitimate, not a degenerate case the tool needs to paper over.
 *
 * Mock fallback (returned when `FORGE_TOOLS_MODE=mock` or the live fetch
 * fails) seeds the demo storm `AL092024` (Hurricane Helene) so a fresh
 * clone with no network still renders the demo end-to-end.
 */

export interface FetchActiveStormsArgs {
  /**
   * Restrict the result to a single NHC basin (case-insensitive, two
   * letters: `AL` Atlantic, `EP` East Pacific, `CP` Central Pacific). When
   * omitted, every active storm across every basin is returned.
   */
  basin?: string;
}

export interface ActiveStorm {
  /** NHC storm id, e.g. "AL092024". Pass directly to `fetch_nhc_cone`. */
  id: string;
  /** Two-letter basin extracted from the id. */
  basin: string;
  /** Storm name (e.g. "HELENE") or null when the feed omits it. */
  name: string | null;
  /**
   * NHC classification code: `TD` tropical depression, `TS` tropical
   * storm, `HU` hurricane, `MH` major hurricane (cat-3+), `STD`/`STS`
   * subtropical, `PT` post-tropical, `LO` remnant low. Null when the
   * upstream payload doesn't carry one.
   */
  classification: string | null;
  /** Maximum sustained wind (kt) — null when not reported. */
  intensity_kt: number | null;
  /** Minimum sea-level pressure (mb) — null when not reported. */
  pressure_mb: number | null;
  /** Current centre latitude (deg). Null when not reported. */
  latitude: number | null;
  /** Current centre longitude (deg, negative for western hemisphere). */
  longitude: number | null;
  /** ISO-8601 timestamp of NHC's most recent update for this storm. */
  last_update: string | null;
}

export interface FetchActiveStormsResult {
  /** Active storms returned by NHC, filtered to `basin` when supplied. */
  storms: ActiveStorm[];
  /** `live` when the feed responded ok, otherwise `mock`. */
  source: 'live' | 'mock';
  /** ISO-8601 timestamp of when this fetch ran. */
  fetched_at: string;
}

function mockResponse(basin?: string): FetchActiveStormsResult {
  // The demo storm — Hurricane Helene, late-Sep 2024 Florida-gulf landfall.
  // Seeded with a plausible mid-storm centre near the Gulf eye position so
  // the offline UX matches what the cone tool's mock returns.
  const all: ActiveStorm[] = [
    {
      id: 'AL092024',
      basin: 'AL',
      name: 'HELENE',
      classification: 'HU',
      intensity_kt: 110,
      pressure_mb: 952,
      latitude: 28.5,
      longitude: -84.5,
      last_update: '2026-05-16T18:00:00Z',
    },
  ];
  const storms = basin
    ? all.filter((s) => s.basin.toLowerCase() === basin.toLowerCase())
    : all;
  return { storms, source: 'mock', fetched_at: new Date().toISOString() };
}

interface RawActiveStorm {
  id?: unknown;
  name?: unknown;
  classification?: unknown;
  intensity?: unknown; // string or number (kt)
  pressure?: unknown; // string or number (mb)
  latitudeNumeric?: unknown;
  longitudeNumeric?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  lastUpdate?: unknown;
}

interface RawCurrentStormsResponse {
  activeStorms?: RawActiveStorm[];
}

/**
 * Coerce a NHC numeric field to `number | null`. The feed sometimes ships
 * values as strings ("110") and sometimes as numbers — be defensive on
 * both.
 */
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `latitudeNumeric` is the preferred decimal field. When absent we parse
 * the human string ("28.5N") for backwards compatibility.
 */
function parseLatLon(numeric: unknown, str: unknown, axis: 'lat' | 'lon'): number | null {
  const n = toNumOrNull(numeric);
  if (n !== null) return n;
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])$/i);
  if (!m) {
    const fallback = Number(str);
    return Number.isFinite(fallback) ? fallback : null;
  }
  const mag = Number(m[1]);
  if (!Number.isFinite(mag)) return null;
  const hemi = m[2].toUpperCase();
  const sign = axis === 'lat'
    ? hemi === 'S' ? -1 : 1
    : hemi === 'W' ? -1 : 1;
  return sign * mag;
}

function basinFromId(id: string): string {
  return id.slice(0, 2).toUpperCase();
}

function parseActiveStorm(raw: RawActiveStorm): ActiveStorm | null {
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null;
  const id = raw.id.trim().toUpperCase();
  return {
    id,
    basin: basinFromId(id),
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null,
    classification:
      typeof raw.classification === 'string' && raw.classification.trim() !== ''
        ? raw.classification.trim().toUpperCase()
        : null,
    intensity_kt: toNumOrNull(raw.intensity),
    pressure_mb: toNumOrNull(raw.pressure),
    latitude: parseLatLon(raw.latitudeNumeric, raw.latitude, 'lat'),
    longitude: parseLatLon(raw.longitudeNumeric, raw.longitude, 'lon'),
    last_update:
      typeof raw.lastUpdate === 'string' && raw.lastUpdate.trim() !== '' ? raw.lastUpdate : null,
  };
}

async function tryLive(basin?: string): Promise<FetchActiveStormsResult | null> {
  const url = 'https://www.nhc.noaa.gov/CurrentStorms.json';
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = (await r.json()) as RawCurrentStormsResponse;
  const raw = Array.isArray(data.activeStorms) ? data.activeStorms : [];
  const parsed = raw
    .map(parseActiveStorm)
    .filter((s): s is ActiveStorm => s !== null);
  const storms = basin
    ? parsed.filter((s) => s.basin.toLowerCase() === basin.toLowerCase())
    : parsed;
  return { storms, source: 'live', fetched_at: new Date().toISOString() };
}

/**
 * Priority order for `classification` — higher index = more relevant.
 * Used by `pickRelevantStorm` to break ties when multiple storms are
 * active across the same basin.
 */
const CLASSIFICATION_RANK: Record<string, number> = {
  LO: 0,
  PT: 1,
  DB: 1,
  STD: 2,
  TD: 2,
  STS: 3,
  TS: 3,
  HU: 4,
  MH: 5,
};

/**
 * Pick the storm most relevant to a Florida cat-ops console. Order:
 *   1. Highest classification rank (MH > HU > TS > TD > everything else).
 *   2. Highest intensity (kt) on ties.
 *   3. Closest to a Florida-centred reference point on further ties.
 *
 * Returns null when the input list is empty; callers fall back to their
 * own demo / "calm state" rendering. The reference point defaults to
 * (28°N, -82°W), roughly central FL — override for other regions.
 */
export function pickRelevantStorm(
  storms: ActiveStorm[],
  ref: { lat: number; lng: number } = { lat: 28, lng: -82 },
): ActiveStorm | null {
  if (storms.length === 0) return null;
  const scored = storms.map((s) => {
    const rank = s.classification ? CLASSIFICATION_RANK[s.classification] ?? -1 : -1;
    const intensity = s.intensity_kt ?? 0;
    const dist =
      s.latitude != null && s.longitude != null
        ? Math.hypot(s.latitude - ref.lat, s.longitude - ref.lng)
        : Number.POSITIVE_INFINITY;
    return { storm: s, rank, intensity, dist };
  });
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    if (a.intensity !== b.intensity) return b.intensity - a.intensity;
    return a.dist - b.dist;
  });
  return scored[0].storm;
}

export const fetchActiveStorms = {
  name: 'fetch_active_storms',
  description:
    'List every currently-active named storm tracked by the National Hurricane Center (Atlantic, East Pacific, and Central Pacific basins). Each entry includes the NHC storm id (which can be passed directly to fetch_nhc_cone), classification (TD/TS/HU/MH/…), intensity (kt), pressure (mb), and current centre lat/lng. Empty `storms` array is a legitimate "no active storms" response, not an error.',
  parameters: {
    type: 'object' as const,
    properties: {
      basin: {
        type: 'string',
        description:
          'Optional two-letter NHC basin filter (AL Atlantic, EP East Pacific, CP Central Pacific). Case-insensitive. Omit for every basin.',
      },
    },
    required: [],
  },
  handler: async (args: FetchActiveStormsArgs = {}): Promise<FetchActiveStormsResult> => {
    if (process.env.FORGE_TOOLS_MODE === 'mock') {
      return mockResponse(args.basin);
    }
    try {
      const live = await tryLive(args.basin);
      if (live) return live;
      return mockResponse(args.basin);
    } catch {
      return mockResponse(args.basin);
    }
  },
};
