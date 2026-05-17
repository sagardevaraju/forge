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
  /**
   * 0-based index into the *data* portion of the input table (i.e. excluding
   * the header row). Preserved through validation so callers that drop
   * invalid rows can still trace each survivor back to its source row —
   * critical for the wizard's lineage tagging.
   */
  srcDataIndex: number;
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
      // i is the index into rawRows (header=0, data=1..N). The data-portion
      // index is therefore i-1; callers join this back to their original
      // pre-validation row array.
      srcDataIndex: i - 1,
    });
  }
  return { rows: out, errors };
}

// ---------------------------------------------------------------------------
// Task P2.39 — column-mapping wizard helpers + PII deny-list.
//
// The /load wizard imports these to suggest carrier-column → FORGE-field
// mappings and to tag every imported row with a lineage record. The
// deny-list is a column-NAME filter (not value-level); Phase 3 (Task P3.28)
// swaps the regex for a real PII classifier (Presidio or equivalent) and
// adds SOC 2 audit trail. See docs/superpowers/plans/2026-05-15-forge.md.
// ---------------------------------------------------------------------------

export interface ForgeField {
  id: string;
  label: string;
  required: boolean;
  /** Hints used by suggestMapping for fuzzy substring match. */
  aliases: string[];
}

/**
 * The set of FORGE policy columns the wizard knows how to populate. The
 * `required` flag mirrors REQUIRED_COLS above so the two stay in lockstep
 * — a wizard that ships without a required field would fail validation.
 */
export const FORGE_FIELDS: ForgeField[] = [
  { id: 'policy_id', label: 'Policy ID', required: true,
    aliases: ['policy_id', 'policyid', 'policy', 'id', 'pol_id'] },
  { id: 'state', label: 'State', required: true,
    aliases: ['state', 'st', 'province'] },
  { id: 'zip3', label: 'Zip3', required: true,
    aliases: ['zip3', 'zip_3', 'zip', 'postal'] },
  { id: 'lat', label: 'Latitude', required: true,
    aliases: ['lat', 'latitude'] },
  { id: 'lon', label: 'Longitude', required: true,
    aliases: ['lon', 'lng', 'long', 'longitude'] },
  { id: 'tiv', label: 'TIV', required: true,
    aliases: ['tiv', 'total_insured_value', 'insured_value', 'value'] },
  { id: 'build_type', label: 'Build type', required: true,
    aliases: ['build_type', 'buildtype', 'construction', 'build'] },
  { id: 'flood_zone', label: 'Flood zone', required: true,
    aliases: ['flood_zone', 'floodzone', 'flood', 'fema_zone', 'zone'] },
  { id: 'county', label: 'County', required: false,
    aliases: ['county'] },
  { id: 'build_year', label: 'Build year', required: false,
    aliases: ['build_year', 'buildyear', 'year_built', 'yob'] },
  { id: 'elevation_m', label: 'Elevation (m)', required: false,
    aliases: ['elevation_m', 'elevation', 'elev'] },
  { id: 'premium_annual', label: 'Annual premium', required: false,
    aliases: ['premium_annual', 'premium', 'annual_premium'] },
];

/**
 * Column-name deny-list. Matches sensitive carrier columns the wizard must
 * refuse — names containing ssn, dob, phone, email, name, or address.
 *
 * KNOWN LIMITATION (per spec): this is a regex, not a classifier. It will
 * false-positive on benign names like `business_name` and false-negative on
 * cryptic ones like `cust_ssn_hash`. Phase 3 (Task P3.28) swaps in Presidio
 * or equivalent. The trade-off is logged in the lineage record so an
 * auditor can trace what was rejected and when.
 */
export const PII_DENY_REGEX = /(ssn|dob|phone|email|name|address)/i;

export function isPII(columnName: string): boolean {
  return PII_DENY_REGEX.test(columnName);
}

export interface MappingSuggestion {
  forgeField: string;
  /** Best-guess CSV column, or null if nothing resembles it. */
  csvColumn: string | null;
}

/**
 * Suggest a mapping from CSV columns to FORGE fields by lower-cased,
 * delimiter-stripped match against each field's aliases.
 *
 * Scoring (higher = better):
 *   100  exact match (lc === la)
 *    80  alias is a full word inside the CSV column (e.g. 'tiv' inside
 *        'total_tiv_usd') — uses \b boundaries on the original (pre-strip)
 *        column name where possible
 *    60  CSV column is a full word inside an alias
 *    20  one is a substring of the other (raw includes check) — generic
 *        substring fallback, weakest signal
 *
 * After scoring every (csvColumn, forgeField) pair, we de-duplicate: each
 * CSV column maps to **at most one** FORGE field — the field with the
 * highest score for that column (ties broken by FORGE_FIELDS order). This
 * prevents a short CSV column like 'st' from auto-suggesting to state,
 * zip3 (via 'postal'), and build_type (via 'construction') simultaneously.
 *
 * PII-named CSV columns are skipped — the wizard never auto-routes a
 * deny-listed column to anything.
 */
export function suggestMapping(
  csvColumns: string[],
  fields: ForgeField[] = FORGE_FIELDS,
): MappingSuggestion[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');
  // Build candidate (csvColumn, forgeField, score) triples.
  type Cand = { col: string; field: string; score: number; order: number };
  const cands: Cand[] = [];
  const fieldOrder = new Map(fields.map((f, idx) => [f.id, idx]));

  for (const c of csvColumns) {
    if (isPII(c)) continue;
    const lc = norm(c);
    if (lc === '') continue;
    for (const f of fields) {
      let best = 0;
      for (const a of f.aliases) {
        const la = norm(a);
        if (la === '') continue;
        let score = 0;
        if (lc === la) {
          score = 100;
        } else {
          // Full-word match against the alias inside the CSV column name.
          // We test against both the stripped and the original-with-_- form.
          const wordRe = new RegExp(
            `(?:^|[\\s_\\-])${escapeRegex(la)}(?:$|[\\s_\\-])`,
            'i',
          );
          if (wordRe.test(c)) {
            score = 80;
          } else {
            const wordReRev = new RegExp(
              `(?:^|[\\s_\\-])${escapeRegex(c)}(?:$|[\\s_\\-])`,
              'i',
            );
            if (wordReRev.test(a)) {
              score = 60;
            } else if (lc.includes(la) || la.includes(lc)) {
              // Weak substring fallback — only credited when the shorter
              // string is at least 3 chars, to keep noise like 'st' inside
              // 'postal' / 'construction' from polluting suggestions.
              const shorter = lc.length < la.length ? lc : la;
              if (shorter.length >= 3) score = 20;
            }
          }
        }
        if (score > best) best = score;
      }
      if (best > 0) {
        cands.push({
          col: c,
          field: f.id,
          score: best,
          order: fieldOrder.get(f.id) ?? 0,
        });
      }
    }
  }

  // For each CSV column, keep only its highest-scoring field assignment.
  const colBest = new Map<string, Cand>();
  for (const cand of cands) {
    const prev = colBest.get(cand.col);
    if (
      !prev ||
      cand.score > prev.score ||
      (cand.score === prev.score && cand.order < prev.order)
    ) {
      colBest.set(cand.col, cand);
    }
  }

  // Invert: field → best CSV column (highest score; ties broken by
  // CSV header order via csvColumns iteration).
  const fieldPick = new Map<string, { col: string; score: number }>();
  for (const c of csvColumns) {
    const cand = colBest.get(c);
    if (!cand) continue;
    const prev = fieldPick.get(cand.field);
    if (!prev || cand.score > prev.score) {
      fieldPick.set(cand.field, { col: c, score: cand.score });
    }
  }

  return fields.map((f) => ({
    forgeField: f.id,
    csvColumn: fieldPick.get(f.id)?.col ?? null,
  }));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type Mapping = Record<string, string | null>;

export interface MappedRow {
  /** Raw string values keyed by FORGE field id. validatePolicies still runs. */
  forgeRow: Record<string, string>;
  /** JSON-encoded lineage record (matches `policies.lineage` column shape). */
  lineage: string;
}

/**
 * Apply a user-confirmed mapping to parsed CSV rows. Each output row carries
 * a lineage JSON string with src_file, src_row (1-indexed from the CSV
 * header — first data row is 2), mapped_at (ISO timestamp), and
 * refused_columns (every PII column the row carried, regardless of whether
 * the user tried to map it). PII-mapped fields are dropped from forgeRow
 * — the column NAME is the filter, so the value never reaches the DB.
 *
 * `srcRowNumbers` is an optional parallel array of 1-indexed CSV line
 * numbers for each input row. Callers that filter blank lines client-side
 * MUST supply this so the lineage points to the actual file line, not the
 * post-filter index. When omitted, src_row defaults to `i + 2` (header
 * counted as row 1) — preserves the simple zero-config behavior used by
 * tests and small inputs.
 */
export function applyMapping(
  rows: Record<string, string>[],
  mapping: Mapping,
  srcFile: string,
  now: () => string = () => new Date().toISOString(),
  srcRowNumbers?: number[],
): MappedRow[] {
  const ts = now();
  const out: MappedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const refused = new Set<string>();
    // 1. Collect every PII column present in the input row.
    for (const k of Object.keys(row)) {
      if (isPII(k)) refused.add(k);
    }
    // 2. Apply the user mapping, but drop any source column that's PII.
    const forgeRow: Record<string, string> = {};
    for (const [forgeField, csvCol] of Object.entries(mapping)) {
      if (!csvCol) continue;
      if (isPII(csvCol)) {
        refused.add(csvCol);
        continue;
      }
      if (csvCol in row) {
        forgeRow[forgeField] = row[csvCol];
      }
    }
    const srcRow = srcRowNumbers?.[i] ?? i + 2; // header is row 1
    out.push({
      forgeRow,
      lineage: JSON.stringify({
        src_file: srcFile,
        src_row: srcRow,
        mapped_at: ts,
        refused_columns: [...refused].sort(),
      }),
    });
  }
  return out;
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
