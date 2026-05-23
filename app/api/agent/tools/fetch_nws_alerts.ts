/**
 * fetch_nws_alerts — Live NWS active-alert lookup (tornado, flood, severe
 * thunderstorm, hurricane, tropical-storm, and storm-surge warnings).
 *
 * NWS publishes every active alert across every product type at:
 *   https://api.weather.gov/alerts/active
 * The endpoint is a stock GeoJSON FeatureCollection — one feature per
 * alert with the polygon under `geometry` (sometimes null when the alert
 * is county-coded rather than polygon-coded) and metadata under
 * `properties` (`event`, `severity`, `urgency`, `certainty`, `expires`,
 * `headline`, `areaDesc`, etc.).
 *
 * This tool exists because `/events` was hurricane-only — the NHC tools
 * cover tropical cyclones but say nothing about live tornado or flash
 * flood warnings happening on the same map. One pull from this endpoint
 * fills the entire non-hurricane peril picture in a single request.
 *
 * Defaults are tuned for a Florida-focused insurance cat-ops console:
 *   - `state` defaults to FL — narrows the response to a relevant slice
 *     (the unfiltered feed can carry several hundred active alerts CONUS-
 *     wide; we never need all of them at the same time).
 *   - `events` defaults to the high-acuity peril list (tornado / flood /
 *     severe thunderstorm / hurricane / tropical / storm surge). The
 *     long tail (Frost Advisory, Marine Weather Statement, etc.) is
 *     legitimately noise for property-cat exposure.
 *
 * NWS asks API consumers to identify themselves via a User-Agent header.
 * We send a generic FORGE one with an env override (`NWS_USER_AGENT`)
 * so a production deployment can supply real contact info without a
 * code change.
 */

export interface FetchNwsAlertsArgs {
  /**
   * NWS event-type filter. The values must match NWS's spelling exactly
   * (e.g. "Tornado Warning", "Flash Flood Warning"). When omitted we use
   * `DEFAULT_ACUTE_EVENTS` — the high-acuity peril list relevant to a
   * property-cat desk. Pass `[]` to disable filtering.
   */
  events?: string[];
  /**
   * Two-letter state code, an array of codes, or null. NWS's `area=`
   * param accepts comma-separated state codes, so passing
   * `['FL','GA','TX']` scopes the lookup to wherever the insurance book
   * actually has exposure rather than hardcoding a single state. The
   * default (`undefined` → `'FL'`) is preserved for backwards-compat
   * with callers that haven't been updated to pass the book's state set.
   * Pass `null` or `[]` to fetch CONUS-wide.
   */
  state?: string | string[] | null;
  /**
   * NWS status filter — defaults to `actual` so test / exercise alerts
   * never leak onto the operations map.
   */
  status?: 'actual' | 'exercise' | 'system' | 'test' | 'draft';
}

/** Normalised category buckets for downstream UI styling + counting. */
export type NwsAlertCategory =
  | 'tornado'
  | 'flood'
  | 'severe_thunderstorm'
  | 'hurricane'
  | 'tropical'
  | 'storm_surge'
  | 'other';

export interface NwsAlert {
  /** Stable NWS alert id (also embedded in the alert URL). */
  id: string;
  /** NWS event name verbatim, e.g. "Tornado Warning". */
  event: string;
  /** Coarse category used for map colour + banner counting. */
  category: NwsAlertCategory;
  /** Normalised severity. NWS's enum: Extreme | Severe | Moderate | Minor | Unknown. */
  severity: 'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown';
  /** Normalised urgency. */
  urgency: 'immediate' | 'expected' | 'future' | 'past' | 'unknown';
  /** Normalised certainty. */
  certainty: 'observed' | 'likely' | 'possible' | 'unlikely' | 'unknown';
  /** Human-readable headline (e.g. "Tornado Warning issued for ..."). */
  headline: string | null;
  /** Plain-language area description (county / zone list). */
  area_desc: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  sender: string | null;
  /**
   * Alert polygon. NWS returns `null` for county-coded alerts (no native
   * polygon); the caller must handle either case. We deliberately don't
   * synthesise a county polygon here — the tool stays a thin adapter.
   */
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
}

export interface NwsAlertCounts {
  tornado: number;
  flood: number;
  severe_thunderstorm: number;
  hurricane: number;
  tropical: number;
  storm_surge: number;
  other: number;
  total: number;
}

export interface FetchNwsAlertsResult {
  alerts: NwsAlert[];
  counts: NwsAlertCounts;
  source: 'live' | 'mock';
  fetched_at: string;
}

/**
 * High-acuity peril list. These are the events a property-cat desk cares
 * about in the moment — long-fuse advisories (Frost, Air Quality, Coastal
 * Flood Statement, etc.) are excluded.
 */
export const DEFAULT_ACUTE_EVENTS: string[] = [
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Flash Flood Warning',
  'Flood Warning',
  'Hurricane Warning',
  'Hurricane Watch',
  'Tropical Storm Warning',
  'Tropical Storm Watch',
  'Storm Surge Warning',
  'Storm Surge Watch',
];

/**
 * Map an NWS event string to a coarse category. Falls back to `other`
 * when the event doesn't match a known prefix — the map layer styles
 * `other` neutrally so unrecognised events still render.
 */
export function categorizeAlertEvent(event: string): NwsAlertCategory {
  const e = event.toLowerCase();
  if (e.includes('tornado')) return 'tornado';
  if (e.includes('storm surge')) return 'storm_surge';
  // Order matters: "Severe Thunderstorm" must match before generic "storm".
  if (e.includes('severe thunderstorm')) return 'severe_thunderstorm';
  if (e.includes('hurricane')) return 'hurricane';
  if (e.includes('tropical storm') || e.includes('tropical depression')) return 'tropical';
  if (e.includes('flood')) return 'flood';
  return 'other';
}

function emptyCounts(): NwsAlertCounts {
  return {
    tornado: 0,
    flood: 0,
    severe_thunderstorm: 0,
    hurricane: 0,
    tropical: 0,
    storm_surge: 0,
    other: 0,
    total: 0,
  };
}

/** Count alerts by category — used by the threat banner and tests. */
export function countAlerts(alerts: NwsAlert[]): NwsAlertCounts {
  const out = emptyCounts();
  for (const a of alerts) {
    out[a.category] += 1;
    out.total += 1;
  }
  return out;
}

function normSeverity(v: unknown): NwsAlert['severity'] {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'extreme' || s === 'severe' || s === 'moderate' || s === 'minor') return s;
  return 'unknown';
}
function normUrgency(v: unknown): NwsAlert['urgency'] {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'immediate' || s === 'expected' || s === 'future' || s === 'past') return s;
  return 'unknown';
}
function normCertainty(v: unknown): NwsAlert['certainty'] {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'observed' || s === 'likely' || s === 'possible' || s === 'unlikely') return s;
  return 'unknown';
}

/**
 * Resolve the `state` arg to a normalised string array. `undefined`
 * defaults to `['FL']` (backwards compat with the original signature);
 * `null` and `[]` both mean "no area filter".
 */
function resolveStates(state: FetchNwsAlertsArgs['state']): string[] {
  if (state === undefined) return ['FL'];
  if (state === null) return [];
  const arr = Array.isArray(state) ? state : [state];
  return arr
    .map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : ''))
    .filter((s) => s.length > 0);
}

function mockResponse(state: FetchNwsAlertsArgs['state']): FetchNwsAlertsResult {
  const states = resolveStates(state);
  const stateUp = states[0] ?? 'FL';
  // Three deterministic FL-area alerts so the offline / no-network path
  // exercises every layer (tornado, flood, severe thunderstorm). Polygons
  // are intentionally compact so they read on the map without overlapping
  // the demo hurricane cone.
  const alerts: NwsAlert[] = [
    {
      id: 'mock-tornado-1',
      event: 'Tornado Warning',
      category: 'tornado',
      severity: 'extreme',
      urgency: 'immediate',
      certainty: 'observed',
      headline: 'Tornado Warning for Marion County, FL',
      area_desc: `Marion, ${stateUp}`,
      effective: '2026-05-18T13:00:00Z',
      onset: '2026-05-18T13:00:00Z',
      expires: '2026-05-18T14:00:00Z',
      sender: 'NWS Jacksonville FL',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-82.3, 29.0],
            [-82.0, 29.0],
            [-82.0, 29.3],
            [-82.3, 29.3],
            [-82.3, 29.0],
          ],
        ],
      },
    },
    {
      id: 'mock-flood-1',
      event: 'Flash Flood Warning',
      category: 'flood',
      severity: 'severe',
      urgency: 'immediate',
      certainty: 'likely',
      headline: 'Flash Flood Warning for portions of Hillsborough County',
      area_desc: `Hillsborough, ${stateUp}`,
      effective: '2026-05-18T12:30:00Z',
      onset: '2026-05-18T12:30:00Z',
      expires: '2026-05-18T16:30:00Z',
      sender: 'NWS Tampa Bay FL',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-82.6, 27.8],
            [-82.2, 27.8],
            [-82.2, 28.1],
            [-82.6, 28.1],
            [-82.6, 27.8],
          ],
        ],
      },
    },
    {
      id: 'mock-svr-1',
      event: 'Severe Thunderstorm Warning',
      category: 'severe_thunderstorm',
      severity: 'severe',
      urgency: 'immediate',
      certainty: 'observed',
      headline: 'Severe Thunderstorm Warning for portions of Orange County',
      area_desc: `Orange, ${stateUp}`,
      effective: '2026-05-18T12:45:00Z',
      onset: '2026-05-18T12:45:00Z',
      expires: '2026-05-18T13:45:00Z',
      sender: 'NWS Melbourne FL',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-81.6, 28.4],
            [-81.2, 28.4],
            [-81.2, 28.7],
            [-81.6, 28.7],
            [-81.6, 28.4],
          ],
        ],
      },
    },
  ];
  return {
    alerts,
    counts: countAlerts(alerts),
    source: 'mock',
    fetched_at: new Date().toISOString(),
  };
}

interface RawAlertFeature {
  id?: unknown;
  geometry?: unknown;
  properties?: {
    id?: unknown;
    event?: unknown;
    severity?: unknown;
    urgency?: unknown;
    certainty?: unknown;
    headline?: unknown;
    areaDesc?: unknown;
    effective?: unknown;
    onset?: unknown;
    expires?: unknown;
    senderName?: unknown;
  };
}

interface RawAlertResponse {
  features?: RawAlertFeature[];
}

function parseAlertFeature(raw: RawAlertFeature): NwsAlert | null {
  const props = raw.properties ?? {};
  const event = typeof props.event === 'string' && props.event.trim() !== ''
    ? props.event.trim()
    : null;
  if (!event) return null;
  const id =
    (typeof props.id === 'string' && props.id) ||
    (typeof raw.id === 'string' && raw.id) ||
    `${event}-${Math.random().toString(36).slice(2, 10)}`;
  // Accept Polygon and MultiPolygon; null is legitimate for county-coded
  // alerts and is preserved (the caller / map layer skips features
  // without geometry).
  let geometry: NwsAlert['geometry'] = null;
  if (raw.geometry && typeof raw.geometry === 'object' && 'type' in raw.geometry) {
    const g = raw.geometry as { type: string };
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      geometry = raw.geometry as NwsAlert['geometry'];
    }
  }
  return {
    id,
    event,
    category: categorizeAlertEvent(event),
    severity: normSeverity(props.severity),
    urgency: normUrgency(props.urgency),
    certainty: normCertainty(props.certainty),
    headline: typeof props.headline === 'string' && props.headline.trim() !== ''
      ? props.headline
      : null,
    area_desc: typeof props.areaDesc === 'string' && props.areaDesc.trim() !== ''
      ? props.areaDesc
      : null,
    effective: typeof props.effective === 'string' ? props.effective : null,
    onset: typeof props.onset === 'string' ? props.onset : null,
    expires: typeof props.expires === 'string' ? props.expires : null,
    sender: typeof props.senderName === 'string' ? props.senderName : null,
    geometry,
  };
}

function buildUrl(args: FetchNwsAlertsArgs): string {
  const params = new URLSearchParams();
  params.set('status', args.status ?? 'actual');
  // NWS's `area=` accepts a comma-separated state-code list; we join the
  // resolved set so a multi-state book scopes the lookup correctly.
  const states = resolveStates(args.state);
  if (states.length > 0) params.set('area', states.join(','));
  // NB: we deliberately do NOT add `event=` filters here. NWS's
  // `/alerts/active` treats `event` as a single-valued field — when multiple
  // `event=` params are appended, the server honours only the last value
  // (verified empirically 2026-05-23: a 12-event chain returned 0 features
  // even on a day with 21 active alerts in FL/TX/LA/NC). Apply the
  // `DEFAULT_ACUTE_EVENTS` whitelist client-side in `tryLive()` instead.
  return `https://api.weather.gov/alerts/active?${params.toString()}`;
}

async function tryLive(args: FetchNwsAlertsArgs): Promise<FetchNwsAlertsResult | null> {
  const url = buildUrl(args);
  const ua = process.env.NWS_USER_AGENT || 'FORGE/1.0 (cat-ops console)';
  const r = await fetch(url, {
    headers: {
      'User-Agent': ua,
      Accept: 'application/geo+json',
    },
  });
  if (!r.ok) return null;
  const data = (await r.json()) as RawAlertResponse;
  const raw = Array.isArray(data.features) ? data.features : [];
  // NWS's server-side `event=` filter is broken for multi-value OR (see
  // buildUrl comment) — so we fetch the un-filtered active-alert feed for
  // the requested area and apply the event whitelist here. `events: []`
  // (passed explicitly) disables the filter entirely; omitted falls back to
  // `DEFAULT_ACUTE_EVENTS`.
  const wantedEvents = args.events ?? DEFAULT_ACUTE_EVENTS;
  const wantedSet = new Set(wantedEvents);
  const alerts = raw
    .map(parseAlertFeature)
    .filter((a): a is NwsAlert =>
      a !== null && (wantedSet.size === 0 || wantedSet.has(a.event)),
    );
  return {
    alerts,
    counts: countAlerts(alerts),
    source: 'live',
    fetched_at: new Date().toISOString(),
  };
}

export const fetchNwsAlerts = {
  name: 'fetch_nws_alerts',
  description:
    'List currently-active National Weather Service alerts (tornado warnings, flash flood warnings, severe thunderstorm warnings, hurricane warnings, etc.) for a US state. Each alert carries event type, severity, urgency, certainty, expiration time, and (when available) a polygon geometry. Defaults to high-acuity perils in Florida. Empty list is a legitimate "no active alerts" response, not an error.',
  parameters: {
    type: 'object' as const,
    properties: {
      events: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of NWS event names to filter by (exact match, e.g. "Tornado Warning"). Defaults to the high-acuity property-cat peril list. Pass [] to disable filtering.',
      },
      state: {
        // JSON schema doesn't have a clean "string OR array of strings" type
        // outside of `oneOf`; we keep this loose so the LLM can pass either
        // a single code or an array. The handler normalises both.
        type: ['string', 'array', 'null'],
        items: { type: 'string' },
        description:
          'Two-letter US state code, an array of codes (e.g. ["FL","GA","TX"]), or null. Defaults to FL when omitted. Pass null or [] to fetch CONUS-wide.',
      },
      status: {
        type: 'string',
        enum: ['actual', 'exercise', 'system', 'test', 'draft'],
        description: 'NWS status filter. Defaults to "actual" so drills do not leak into the map.',
      },
    },
    required: [],
  },
  handler: async (args: FetchNwsAlertsArgs = {}): Promise<FetchNwsAlertsResult> => {
    if (process.env.FORGE_TOOLS_MODE === 'mock') {
      return mockResponse(args.state);
    }
    try {
      const live = await tryLive(args);
      if (live) return live;
      return mockResponse(args.state);
    } catch {
      return mockResponse(args.state);
    }
  },
};
