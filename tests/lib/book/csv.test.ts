/**
 * Task P2.39 — column-mapping + PII deny-list helpers in lib/book/csv.ts.
 *
 * These tests pin down the wizard contract:
 *   1. `suggestMapping` picks the best CSV column for each FORGE field by
 *      lower-cased substring matching.
 *   2. `isPII` matches the deny-list regex /(ssn|dob|phone|email|name|address)/i
 *      and rejects sensible carrier column names while leaving FORGE fields
 *      like tiv/zip3/policy_id alone.
 *   3. `applyMapping` produces a per-row lineage payload that an auditor
 *      can read after-the-fact — src_file, src_row (1-indexed from the CSV),
 *      mapped_at (ISO timestamp), and refused_columns (PII names dropped).
 *   4. PII columns are rejected even if the user manually maps them to a
 *      FORGE field — the column NAME is the filter, not the mapping target.
 */
import { describe, test, expect } from 'vitest';
import {
  FORGE_FIELDS,
  PII_DENY_REGEX,
  isPII,
  suggestMapping,
  applyMapping,
  validatePolicies,
} from '@/lib/book/csv';

describe('PII deny-list', () => {
  test('regex matches the spec exactly', () => {
    expect(PII_DENY_REGEX.source).toBe('(ssn|dob|phone|email|name|address)');
    expect(PII_DENY_REGEX.flags).toContain('i');
  });

  test('isPII rejects sensitive column names', () => {
    expect(isPII('ssn')).toBe(true);
    expect(isPII('SSN')).toBe(true);
    expect(isPII('customer_name')).toBe(true);
    expect(isPII('dob_year')).toBe(true);
    expect(isPII('email_addr')).toBe(true);
    expect(isPII('phone_number')).toBe(true);
    expect(isPII('mailing_address')).toBe(true);
  });

  test('isPII accepts FORGE-shaped columns', () => {
    expect(isPII('policy_id')).toBe(false);
    expect(isPII('tiv')).toBe(false);
    expect(isPII('zip3')).toBe(false);
    expect(isPII('build_type')).toBe(false);
    expect(isPII('flood_zone')).toBe(false);
    expect(isPII('state')).toBe(false);
    expect(isPII('premium_annual')).toBe(false);
  });
});

describe('FORGE_FIELDS', () => {
  test('exposes every required policy column', () => {
    const required = FORGE_FIELDS.filter((f) => f.required).map((f) => f.id);
    expect(required).toEqual(
      expect.arrayContaining([
        'policy_id',
        'state',
        'zip3',
        'lat',
        'lon',
        'tiv',
        'build_type',
        'flood_zone',
      ]),
    );
  });
});

describe('suggestMapping', () => {
  test('picks the obvious CSV column for each FORGE field', () => {
    const cols = [
      'PolicyID',
      'State',
      'Zip3',
      'Latitude',
      'Longitude',
      'TIV',
      'BuildType',
      'FloodZone',
    ];
    const sug = suggestMapping(cols, FORGE_FIELDS);
    const byId = Object.fromEntries(sug.map((s) => [s.forgeField, s.csvColumn]));
    expect(byId.policy_id).toBe('PolicyID');
    expect(byId.state).toBe('State');
    expect(byId.zip3).toBe('Zip3');
    expect(byId.tiv).toBe('TIV');
    expect(byId.build_type).toBe('BuildType');
    expect(byId.flood_zone).toBe('FloodZone');
  });

  test('leaves unmapped FORGE fields as null when no CSV column resembles them', () => {
    const cols = ['some_random_column', 'another_one'];
    const sug = suggestMapping(cols, FORGE_FIELDS);
    for (const s of sug) {
      expect(s.csvColumn).toBeNull();
    }
  });

  test('does NOT suggest a PII column for any FORGE field', () => {
    // 'customer_name' superficially contains 'name' which matches no FORGE
    // field, but if a carrier ships e.g. 'state_name', the suggestion engine
    // must still refuse to route it because the column name is on the deny-list.
    const cols = ['policy_id', 'state_name', 'tiv'];
    const sug = suggestMapping(cols, FORGE_FIELDS);
    for (const s of sug) {
      if (s.csvColumn) {
        expect(isPII(s.csvColumn)).toBe(false);
      }
    }
  });

  test('short CSV column is not mapped to multiple FORGE fields', () => {
    // Regression: previously 'st' would substring-match into 'state', 'postal'
    // (zip3 alias), and 'construction' (build_type alias) — auto-routing the
    // same column to three different fields. With scored + de-duplicated
    // matching, 'st' should land on at most one field (or none — it's too
    // short to be a confident match).
    const sug = suggestMapping(['st', 'tiv'], FORGE_FIELDS);
    const picks = sug.filter((s) => s.csvColumn === 'st');
    expect(picks.length).toBeLessThanOrEqual(1);
    // 'tiv' must still map cleanly to the tiv FORGE field — the de-dup
    // mustn't strip valid high-score matches.
    const byId = Object.fromEntries(sug.map((s) => [s.forgeField, s.csvColumn]));
    expect(byId.tiv).toBe('tiv');
  });

  test('every CSV column is suggested to at most one FORGE field', () => {
    // De-duplication invariant: the same CSV column can never appear as the
    // suggested csvColumn for two different forgeFields. This is what makes
    // the wizard's auto-mapping reviewable instead of confusing.
    const cols = [
      'policy_id', 'state', 'zip3', 'lat', 'lon', 'tiv',
      'build_type', 'flood_zone', 'construction', 'postal',
    ];
    const sug = suggestMapping(cols, FORGE_FIELDS);
    const picked = sug.map((s) => s.csvColumn).filter((c): c is string => !!c);
    const dupes = picked.filter((c, i) => picked.indexOf(c) !== i);
    expect(dupes).toEqual([]);
  });
});

describe('applyMapping', () => {
  test('writes a lineage record for each row', () => {
    const rows = [
      { PolicyID: '1', State: 'FL', Zip3: '331', Latitude: '25.7', Longitude: '-80.2',
        TIV: '250000', BuildType: 'wood_frame', FloodZone: 'AE' },
      { PolicyID: '2', State: 'TX', Zip3: '770', Latitude: '29.7', Longitude: '-95.3',
        TIV: '180000', BuildType: 'masonry', FloodZone: 'X' },
    ];
    const mapping = {
      policy_id: 'PolicyID',
      state: 'State',
      zip3: 'Zip3',
      lat: 'Latitude',
      lon: 'Longitude',
      tiv: 'TIV',
      build_type: 'BuildType',
      flood_zone: 'FloodZone',
    };
    const mapped = applyMapping(rows, mapping, 'carrier_book_2026.csv');
    expect(mapped).toHaveLength(2);
    expect(mapped[0].forgeRow.policy_id).toBe('1');
    expect(mapped[0].forgeRow.tiv).toBe('250000');
    const lineage = JSON.parse(mapped[0].lineage);
    expect(lineage.src_file).toBe('carrier_book_2026.csv');
    expect(lineage.src_row).toBe(2); // header is row 1, first data row is row 2
    expect(lineage.mapped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(Array.isArray(lineage.refused_columns)).toBe(true);
    expect(lineage.refused_columns).toEqual([]);
    expect(JSON.parse(mapped[1].lineage).src_row).toBe(3);
  });

  test('records refused PII columns in lineage', () => {
    const rows = [
      { policy_id: '1', tiv: '100000', customer_name: 'A Smith',
        email: 'a@b.com', state: 'FL', zip3: '331', lat: '25.7',
        lon: '-80.2', build_type: 'wood_frame', flood_zone: 'X' },
    ];
    const mapping = {
      policy_id: 'policy_id', tiv: 'tiv', state: 'state', zip3: 'zip3',
      lat: 'lat', lon: 'lon', build_type: 'build_type', flood_zone: 'flood_zone',
    };
    const mapped = applyMapping(rows, mapping, 'book.csv');
    const lineage = JSON.parse(mapped[0].lineage);
    expect(lineage.refused_columns).toEqual(
      expect.arrayContaining(['customer_name', 'email']),
    );
  });

  test('refuses a PII mapping target even if the user picks it', () => {
    // User maps `state` (a FORGE field) to a CSV column called `customer_name`.
    // The mapping must be dropped — that column is on the deny-list.
    const rows = [
      { customer_name: 'Acme LLC', tiv: '100000', policy_id: '1',
        zip3: '331', lat: '25.7', lon: '-80.2', build_type: 'wood_frame',
        flood_zone: 'X' },
    ];
    const mapping = {
      policy_id: 'policy_id',
      state: 'customer_name', // PII column
      zip3: 'zip3',
      lat: 'lat',
      lon: 'lon',
      tiv: 'tiv',
      build_type: 'build_type',
      flood_zone: 'flood_zone',
    };
    const mapped = applyMapping(rows, mapping, 'book.csv');
    // state should be absent (no PII value snuck in) and lineage records it
    expect(mapped[0].forgeRow.state).toBeUndefined();
    const lineage = JSON.parse(mapped[0].lineage);
    expect(lineage.refused_columns).toContain('customer_name');
  });

  test('honors explicit srcRowNumbers (blank-line preserving CSV index)', () => {
    // Regression: callers that filter blank rows client-side MUST be able to
    // pass through the original CSV line indices so lineage src_row still
    // matches the actual file line, not the post-filter array index.
    const rows = [
      { policy_id: '1', state: 'FL', zip3: '331', lat: '25.7', lon: '-80.2',
        tiv: '100000', build_type: 'wood_frame', flood_zone: 'X' },
      { policy_id: '2', state: 'TX', zip3: '770', lat: '29.7', lon: '-95.3',
        tiv: '180000', build_type: 'masonry', flood_zone: 'X' },
    ];
    const mapping = {
      policy_id: 'policy_id', state: 'state', zip3: 'zip3', lat: 'lat',
      lon: 'lon', tiv: 'tiv', build_type: 'build_type', flood_zone: 'flood_zone',
    };
    // Simulate a CSV with: header (line 1), data (line 2), blank (line 3),
    // data (line 4). The wizard drops the blank but tracks the line indices.
    const mapped = applyMapping(rows, mapping, 'book.csv', undefined, [2, 4]);
    expect(JSON.parse(mapped[0].lineage).src_row).toBe(2);
    expect(JSON.parse(mapped[1].lineage).src_row).toBe(4);
  });
});

describe('validatePolicies — srcDataIndex preservation', () => {
  test('survivors carry the original pre-validation data-row index', () => {
    // Regression: when validatePolicies drops invalid rows, every survivor
    // must still expose the index of its source row in the input table so
    // the upload-wizard route can pull the matching lineage record. Without
    // this, lineage gets silently misattributed on every dropped row.
    const table: string[][] = [
      ['policy_id', 'state', 'zip3', 'lat', 'lon', 'tiv', 'build_type', 'flood_zone'],
      ['1', 'FL', '331', '25.7', '-80.2', '100000', 'wood_frame', 'X'], // valid → data idx 0
      ['2', 'F1', '331', '25.7', '-80.2', '100000', 'wood_frame', 'X'], // bad state (non-letter) → drop
      ['3', 'TX', '770', '29.7', '-95.3', '180000', 'masonry', 'X'],    // valid → data idx 2
      ['4', 'LA', '703', '30.1', '-91.0', '-1', 'wood_frame', 'X'],     // bad tiv → drop
      ['5', 'NC', '275', '35.7', '-78.6', '210000', 'wood_frame', 'A'], // valid → data idx 4
    ];
    const { rows, errors } = validatePolicies(table);
    expect(rows).toHaveLength(3);
    expect(errors).toHaveLength(2);
    expect(rows[0].id).toBe(1);
    expect(rows[0].srcDataIndex).toBe(0);
    expect(rows[1].id).toBe(3);
    expect(rows[1].srcDataIndex).toBe(2);
    expect(rows[2].id).toBe(5);
    expect(rows[2].srcDataIndex).toBe(4);
  });
});
