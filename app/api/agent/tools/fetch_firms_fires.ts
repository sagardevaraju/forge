/**
 * fetch_firms_fires — NASA FIRMS active fire detections within a bbox.
 *
 * FIRMS returns CSV by default. We use the area/csv endpoint:
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/<KEY>/VIIRS_SNPP_NRT/<W,S,E,N>/<days>
 * Falls back to mocks when NASA_FIRMS_KEY is missing, FORGE_TOOLS_MODE=mock,
 * or the call throws.
 */

export interface FetchFirmsFiresArgs {
  bbox: [number, number, number, number]; // [west, south, east, north]
  hours?: number;
}

export interface FireDetection {
  lat: number;
  lon: number;
  brightness: number;
  confidence: string;
  acq_time: string;
}

function mockResponse(bbox: [number, number, number, number]): FireDetection[] {
  // Plausible California fire detections, clamped into the requested bbox so
  // the LLM gets something sensible regardless of the area searched.
  const [w, s, e, n] = bbox;
  const candidates: FireDetection[] = [
    { lat: 38.55, lon: -121.45, brightness: 332.1, confidence: 'high', acq_time: '2026-05-15T18:23:00Z' },
    { lat: 37.41, lon: -121.92, brightness: 305.6, confidence: 'nominal', acq_time: '2026-05-15T17:45:00Z' },
    { lat: 36.78, lon: -119.42, brightness: 341.0, confidence: 'high', acq_time: '2026-05-15T18:10:00Z' },
    { lat: 35.34, lon: -118.85, brightness: 318.2, confidence: 'nominal', acq_time: '2026-05-15T16:55:00Z' },
  ];
  return candidates.filter((c) => c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n);
}

function parseCsv(csv: string): FireDetection[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const latI = header.indexOf('latitude');
  const lonI = header.indexOf('longitude');
  const brI = header.indexOf('bright_ti4') >= 0 ? header.indexOf('bright_ti4') : header.indexOf('brightness');
  const confI = header.indexOf('confidence');
  const dateI = header.indexOf('acq_date');
  const timeI = header.indexOf('acq_time');
  const out: FireDetection[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 4) continue;
    out.push({
      lat: Number(cols[latI]),
      lon: Number(cols[lonI]),
      brightness: Number(cols[brI]),
      confidence: String(cols[confI] ?? ''),
      acq_time: `${cols[dateI] ?? ''}T${cols[timeI] ?? ''}Z`,
    });
  }
  return out;
}

async function tryLive(
  apiKey: string,
  bbox: [number, number, number, number],
  hours: number,
): Promise<FireDetection[] | null> {
  const days = Math.max(1, Math.ceil(hours / 24));
  const [w, s, e, n] = bbox;
  const url =
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(apiKey)}/VIIRS_SNPP_NRT/` +
    `${w},${s},${e},${n}/${days}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return parseCsv(await r.text());
}

export const fetchFirmsFires = {
  name: 'fetch_firms_fires',
  description:
    'Return NASA FIRMS active-fire detections in a [west,south,east,north] bbox over the last N hours. Brightness is in Kelvin.',
  parameters: {
    type: 'object' as const,
    properties: {
      bbox: {
        type: 'array',
        items: { type: 'number' },
        minItems: 4,
        maxItems: 4,
        description: 'Bounding box [west, south, east, north]',
      },
      hours: {
        type: 'number',
        description: 'Look-back window in hours (default 24)',
      },
    },
    required: ['bbox'],
  },
  handler: async (args: FetchFirmsFiresArgs): Promise<FireDetection[]> => {
    if (!args?.bbox || args.bbox.length !== 4) {
      throw new Error('bbox of length 4 required');
    }
    const hours = args.hours ?? 24;
    const key = process.env.NASA_FIRMS_KEY;
    if (process.env.FORGE_TOOLS_MODE === 'mock' || !key) {
      return mockResponse(args.bbox);
    }
    try {
      const live = await tryLive(key, args.bbox, hours);
      if (live) return live;
      return mockResponse(args.bbox);
    } catch {
      return mockResponse(args.bbox);
    }
  },
};
