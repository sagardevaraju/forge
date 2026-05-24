// @vitest-environment node
/**
 * Task P3.6 — POST /api/decisions/rollback route.
 *
 * Surface contract:
 *   - Body: {id: string} (the 64-char hex content-addressed decision id)
 *   - Reads `X-Forge-Operator` header → falls back to 'demo_operator'
 *   - 200 with {rolled_back: true, decision, manual_reversal_required,
 *     already_reversed} when the id exists
 *   - 404 when the id doesn't match any row
 *   - 400 on malformed body or non-hex id
 *
 * Wired exactly the way P3.4's ledger writer is — header-based operator
 * identity, drop-in replaceable when P3.1 auth lands.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { unsafeExecute } from '@/lib/db/client';
import {
  type WriteDecisionParams,
  markNoticesSent,
  writeDecision,
} from '@/lib/audit/decisions';
import { POST } from '@/app/api/decisions/rollback/route';

beforeAll(async () => {
  await unsafeExecute(
    'CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, solve_ts TEXT NOT NULL, operator TEXT NOT NULL, inputs_hash TEXT NOT NULL, inputs_json TEXT NOT NULL, outputs_hash TEXT NOT NULL, outputs_json TEXT NOT NULL, executed_at TEXT, reversed_at TEXT, reversed_by TEXT, notices_sent_at TEXT)',
  );
});

beforeEach(async () => {
  await unsafeExecute('DELETE FROM decisions');
});

afterEach(async () => {
  await unsafeExecute('DELETE FROM decisions');
});

function makeParams(over: Partial<WriteDecisionParams> = {}): WriteDecisionParams {
  return {
    operator: 'alice',
    inputs: {
      budgets: { capital_budget: 1e7, max_nonrenew_pct: 0.1, cession_budget: 5e6 },
      cohorts_hash: 'a'.repeat(64),
      horizon_start: '2026-01-01',
      horizon_end: '2026-12-31',
    },
    outputs: { status: 'Optimal', objective: 12345 },
    ...over,
  };
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/decisions/rollback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/decisions/rollback', () => {
  test('happy path — returns rolled_back: true and persists reversed_*', async () => {
    const row = await writeDecision(makeParams());
    const r = await POST(req({ id: row.id }, { 'x-forge-operator': 'bob' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rolled_back).toBe(true);
    expect(body.manual_reversal_required).toBe(false);
    expect(body.already_reversed).toBe(false);
    expect(body.decision.id).toBe(row.id);
    expect(body.decision.reversed_by).toBe('bob');
    expect(body.decision.reversed_at).toBeTruthy();
  });

  test('missing X-Forge-Operator → reversed_by = demo_operator', async () => {
    const row = await writeDecision(makeParams());
    const r = await POST(req({ id: row.id }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.decision.reversed_by).toBe('demo_operator');
  });

  test('manual_reversal_required: true when notices have been sent', async () => {
    const row = await writeDecision(makeParams());
    await markNoticesSent(row.id);
    const r = await POST(req({ id: row.id }, { 'x-forge-operator': 'bob' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rolled_back).toBe(true);
    expect(body.manual_reversal_required).toBe(true);
    expect(body.decision.reversed_by).toBe('bob');
  });

  test('unknown id → 404', async () => {
    const r = await POST(req({ id: '0'.repeat(64) }, { 'x-forge-operator': 'bob' }));
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toMatch(/not found/i);
  });

  test('malformed body — missing id → 400', async () => {
    const r = await POST(req({}, { 'x-forge-operator': 'bob' }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBeTruthy();
  });

  test('non-hex id → 400 (id must be 64-char hex per ledger schema)', async () => {
    const r = await POST(
      req({ id: 'not-a-real-id' }, { 'x-forge-operator': 'bob' }),
    );
    expect(r.status).toBe(400);
  });

  test('repeat rollback on same id surfaces already_reversed: true', async () => {
    const row = await writeDecision(makeParams());
    await POST(req({ id: row.id }, { 'x-forge-operator': 'bob' }));
    const r = await POST(req({ id: row.id }, { 'x-forge-operator': 'carol' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rolled_back).toBe(true);
    expect(body.already_reversed).toBe(true);
    // First-reversal attribution preserved — second call is a no-op.
    expect(body.decision.reversed_by).toBe('bob');
  });

  test('non-JSON body → 400', async () => {
    const r = await POST(
      new Request('http://localhost/api/decisions/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(r.status).toBe(400);
  });
});
