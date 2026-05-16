/**
 * Minimal RFC-4180-ish CSV parser. Used by the book-upload route to ingest
 * policy CSVs without pulling a parser dep into the route bundle.
 *
 * Supports:
 *   - quoted fields containing commas, newlines, doubled-quote escapes
 *   - unquoted fields
 *   - CRLF or LF line endings
 *
 * Does NOT support:
 *   - delimiters other than comma
 *   - embedded BOMs (strip on the caller side if needed)
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      // CRLF skip
      if (c === '\r' && i + 1 < n && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Last field / row (no trailing newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ParsedPolicy {
  id: number;
  state: string;
  zip3: string;
  county: string | null;
  lat: number;
  lon: number;
  tiv: number;
  build_year: number | null;
  build_type: string;
  flood_zone: string;
  elevation_m: number | null;
  premium_annual: number | null;
  cv_features: string | null;
}

export interface ParseResult {
  rows: ParsedPolicy[];
  errors: { row: number; message: string }[];
}

const REQUIRED_COLS = [
  'policy_id',
  'state',
  'zip3',
  'lat',
  'lon',
  'tiv',
  'build_type',
  'flood_zone',
];

const ALLOWED_BUILD_TYPES = new Set(['wood_frame', 'masonry', 'manufactured']);
const ALLOWED_FLOOD_ZONES = new Set(['X', 'A', 'AE', 'VE']);

/**
 * Validate + coerce parsed CSV rows into typed policies. Returns both the
 * passing rows and any per-row errors so the UI can show what was rejected.
 *
 * The first non-empty row is treated as a header. Column order may vary;
 * we look up columns by name. Missing required columns abort with a single
 * "row 0" error so the user can see what's missing.
 */
export function validatePolicies(rawRows: string[][]): ParseResult {
  const errors: { row: number; message: string }[] = [];
  if (rawRows.length === 0) {
    return { rows: [], errors: [{ row: 0, message: 'empty CSV' }] };
  }
  const header = rawRows[0].map((c) => c.trim());
  const colIdx: Record<string, number> = {};
  header.forEach((c, i) => {
    colIdx[c] = i;
  });
  const missing = REQUIRED_COLS.filter((c) => !(c in colIdx));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `missing required column(s): ${missing.join(', ')}`,
        },
      ],
    };
  }

  const get = (cells: string[], col: string): string => {
    const i = colIdx[col];
    return i !== undefined ? (cells[i] ?? '').trim() : '';
  };
  const getNum = (cells: string[], col: string): number | null => {
    const v = get(cells, col);
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const out: ParsedPolicy[] = [];
  for (let i = 1; i < rawRows.length; i++) {
    const cells = rawRows[i];
    if (cells.length === 0 || (cells.length === 1 && cells[0] === '')) continue;
    const rowNo = i + 1;

    const id = getNum(cells, 'policy_id');
    if (id == null) {
      errors.push({ row: rowNo, message: 'policy_id missing or non-numeric' });
      continue;
    }
    const lat = getNum(cells, 'lat');
    const lon = getNum(cells, 'lon');
    if (lat == null || lon == null) {
      errors.push({ row: rowNo, message: 'lat/lon missing or non-numeric' });
      continue;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push({ row: rowNo, message: `lat/lon out of range (${lat}, ${lon})` });
      continue;
    }
    const tiv = getNum(cells, 'tiv');
    if (tiv == null || tiv <= 0) {
      errors.push({ row: rowNo, message: 'tiv missing or non-positive' });
      continue;
    }
    const state = get(cells, 'state').toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) {
      errors.push({ row: rowNo, message: `state "${state}" must be 2-letter code` });
      continue;
    }
    const zip3 = get(cells, 'zip3').padStart(3, '0').slice(0, 3);
    if (!/^\d{3}$/.test(zip3)) {
      errors.push({ row: rowNo, message: `zip3 "${zip3}" must be 3 digits` });
      continue;
    }
    const build_type = get(cells, 'build_type').toLowerCase();
    if (!ALLOWED_BUILD_TYPES.has(build_type)) {
      errors.push({
        row: rowNo,
        message: `build_type "${build_type}" not in ${[...ALLOWED_BUILD_TYPES].join('|')}`,
      });
      continue;
    }
    const flood_zone = get(cells, 'flood_zone').toUpperCase();
    if (!ALLOWED_FLOOD_ZONES.has(flood_zone)) {
      errors.push({
        row: rowNo,
        message: `flood_zone "${flood_zone}" not in ${[...ALLOWED_FLOOD_ZONES].join('|')}`,
      });
      continue;
    }
    const build_year = getNum(cells, 'build_year');
    const elevation_m = getNum(cells, 'elevation_m');
    const premium_annual = getNum(cells, 'premium_annual');
    const county = get(cells, 'county') || null;
    const cv_features = get(cells, 'cv_features') || null;

    out.push({
      id,
      state,
      zip3,
      county,
      lat,
      lon,
      tiv,
      build_year: build_year != null ? Math.round(build_year) : null,
      build_type,
      flood_zone,
      elevation_m,
      premium_annual,
      cv_features,
    });
  }
  return { rows: out, errors };
}

/**
 * Deterministic placeholder CV feature vector when the upload doesn't carry
 * one. Mirrors the band-math feature extractor's behavior: ~0.5-centered
 * with mild local variation by lat/lon so cohorts aren't all identical.
 */
export function mockCvFeatures(lat: number, lon: number): number[] {
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  return [
    0.45 + 0.1 * h(lat, lon),
    0.50 + 0.1 * h(lat + 1, lon + 1),
    0.60 + 0.1 * h(lat + 2, lon + 2),
    0.40 + 0.1 * h(lat + 3, lon + 3),
    0.30 + 0.2 * h(lat + 4, lon + 4),
    0.50 + 0.1 * h(lat + 5, lon + 5),
    0.50 + 0.05 * h(lat + 6, lon + 6),
    0.55 + 0.05 * h(lat + 7, lon + 7),
  ].map((x) => Math.max(0, Math.min(1, x)));
}
