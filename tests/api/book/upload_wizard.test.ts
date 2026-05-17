// @vitest-environment node
/**
 * Task P2.39 — /api/book/upload-wizard route.
 *
 * Pins the lineage/row alignment contract: when validatePolicies drops some
 * rows, every surviving policy must be inserted with the lineage record
 * that came from its ORIGINAL pre-validation row, not the post-validation
 * index. A bug here silently misattributes the audit trail — the whole
 * point of the wizard.
 *
 * The DB layer is mocked; we capture every INSERT and assert the lineage
 * arguments. The MIP precompute child-process is skipped by stubbing
 * `node:child_process` so the test doesn't fork Python.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

interface CapturedStmt {
  sql: string;
  args: unknown[];
}

const captured: CapturedStmt[] = [];

vi.mock('@/lib/db/client', () => ({
  db: {
    execute: vi.fn(async () => ({ rows: [] })),
    batch: vi.fn(async (stmts: CapturedStmt[]) => {
      captured.push(...stmts);
      return [];
    }),
  },
}));

vi.mock('node:child_process', () => ({
  // Resolve immediately as a no-op success — the route awaits the close
  // event so we synthesize one.
  spawn: vi.fn(() => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const emitter = {
      on(evt: string, cb: (...args: unknown[]) => void) {
        (handlers[evt] ||= []).push(cb);
        return emitter;
      },
      stderr: {
        on(_evt: string, _cb: (...args: unknown[]) => void) {
          return undefined;
        },
      },
    };
    queueMicrotask(() => {
      for (const cb of handlers.close ?? []) cb(0);
    });
    return emitter;
  }),
}));

import { POST } from '@/app/api/book/upload-wizard/route';

function mappedRow(forge: Record<string, string>, lineageObj: object) {
  return { forgeRow: forge, lineage: JSON.stringify(lineageObj) };
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/book/upload-wizard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  captured.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/book/upload-wizard — lineage/row alignment', () => {
  test('survivors carry the lineage of their original input row, not the post-validation index', async () => {
    // Row 2 (the middle one) is intentionally invalid (bad state code).
    // Without preserving original indices, parsed[1] would pull rows[1]
    // (the rejected row's lineage) and parsed[2]'s slot would shift.
    const rows = [
      mappedRow(
        {
          policy_id: '1',
          state: 'FL',
          zip3: '331',
          lat: '25.7',
          lon: '-80.2',
          tiv: '100000',
          build_type: 'wood_frame',
          flood_zone: 'X',
        },
        { src_file: 'book.csv', src_row: 2, refused_columns: [] },
      ),
      mappedRow(
        {
          policy_id: '2',
          state: 'F1', // invalid — non-letter, will be dropped
          zip3: '999',
          lat: '0',
          lon: '0',
          tiv: '50000',
          build_type: 'wood_frame',
          flood_zone: 'X',
        },
        { src_file: 'book.csv', src_row: 3, refused_columns: ['ssn'] },
      ),
      mappedRow(
        {
          policy_id: '3',
          state: 'TX',
          zip3: '770',
          lat: '29.7',
          lon: '-95.3',
          tiv: '180000',
          build_type: 'masonry',
          flood_zone: 'X',
        },
        { src_file: 'book.csv', src_row: 4, refused_columns: [] },
      ),
    ];

    const r = await POST(req({ srcFile: 'book.csv', rows, refusedColumns: [] }));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.accepted).toBe(2);
    expect(json.rejected).toBe(1);

    // Two INSERTs should have run, in survivor order (policy_id 1 then 3).
    const inserts = captured.filter((s) => /INSERT INTO policies/.test(s.sql));
    expect(inserts).toHaveLength(2);

    // Args order: id, state, zip3, county, lat, lon, tiv, build_year,
    // build_type, flood_zone, elevation_m, premium_annual, cv_features,
    // synthetic, lineage.
    const lineage0 = JSON.parse(inserts[0].args[14] as string);
    const lineage1 = JSON.parse(inserts[1].args[14] as string);

    // policy_id 1 came from rows[0] → src_row 2.
    expect(inserts[0].args[0]).toBe(1);
    expect(lineage0.src_row).toBe(2);

    // policy_id 3 came from rows[2] → src_row 4. The bug was that the
    // route would have written rows[1].lineage here (src_row 3 with the
    // ssn refused column), misattributing the source row.
    expect(inserts[1].args[0]).toBe(3);
    expect(lineage1.src_row).toBe(4);
    expect(lineage1.refused_columns).toEqual([]);
  });

  test('rejects non-string lineage values and writes null instead', async () => {
    const rows = [
      // Garbage non-string lineage (hand-crafted POST). Route should
      // refuse to persist it but still accept the policy itself.
      {
        forgeRow: {
          policy_id: '1',
          state: 'FL',
          zip3: '331',
          lat: '25.7',
          lon: '-80.2',
          tiv: '100000',
          build_type: 'wood_frame',
          flood_zone: 'X',
        },
        lineage: { not: 'a string' } as unknown as string,
      },
    ];
    const r = await POST(req({ srcFile: 'book.csv', rows, refusedColumns: [] }));
    expect(r.status).toBe(200);
    const inserts = captured.filter((s) => /INSERT INTO policies/.test(s.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[14]).toBeNull();
  });

  test('rejects oversize lineage strings (>= 8192 chars)', async () => {
    const huge = 'x'.repeat(9000);
    const rows = [
      {
        forgeRow: {
          policy_id: '1',
          state: 'FL',
          zip3: '331',
          lat: '25.7',
          lon: '-80.2',
          tiv: '100000',
          build_type: 'wood_frame',
          flood_zone: 'X',
        },
        lineage: huge,
      },
    ];
    const r = await POST(req({ srcFile: 'book.csv', rows, refusedColumns: [] }));
    expect(r.status).toBe(200);
    const inserts = captured.filter((s) => /INSERT INTO policies/.test(s.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[14]).toBeNull();
  });

  test('413 when content-length exceeds MAX_BYTES', async () => {
    // Forge a Request with a content-length header well past the cap.
    const big = (25 * 1024 * 1024 + 1).toString();
    const r = await POST(
      new Request('http://localhost/api/book/upload-wizard', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': big,
        },
        body: JSON.stringify({ srcFile: 'book.csv', rows: [], refusedColumns: [] }),
      }),
    );
    expect(r.status).toBe(413);
  });
});
