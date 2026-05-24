// @vitest-environment node
/**
 * Task P3.4 — Versioned decision ledger.
 *
 * Every call to `/api/optimize/portfolio` writes one row to `decisions`. The
 * row's primary key is a SHA-256 hash of (inputs_hash + outputs_hash) so
 * replaying the exact same solve is idempotent: same inputs + same outputs
 * → same id → no duplicate rows.
 *
 * Inputs that go into the hash:
 *   - budgets (capital_budget, max_nonrenew_pct, cession_budget)
 *   - horizon_start / horizon_end
 *   - cohorts_hash — a fingerprint of the artifact's cohort list (the actual
 *     cohort blob is ~50KB × every solve; we hash the fingerprint and look
 *     up the full cohorts in the live artifact on demand)
 *
 * What we DO store inline:
 *   - `inputs_json` — canonical-JSON of the DecisionInput (≈300 bytes)
 *   - `outputs_json` — canonical-JSON of the PortfolioOptimization minus
 *     `loss_scenarios` (already-stripped by the route; ≈30-50 KB)
 * This makes the /audit diff view self-contained: it can show "budget moved
 * from $X to $Y; action mix moved from {…} to {…}" without joining a
 * regenerated artifact whose other side has changed.
 *
 * What we do NOT store:
 *   - The full cohort list. The artifact carries it; `cohorts_hash` detects
 *     book drift between two consecutive solves.
 *
 * Operator identity:
 *   - `operatorFromHeaders` reads `X-Forge-Operator` and falls back to
 *     `'demo_operator'`. Drop-in replaceable with the Clerk session id when
 *     P3.1 unparks; until then, this is the demo identity scheme.
 *
 * Lifecycle columns (wired now, used later):
 *   - `executed_at` — set when the operator commits the solve to the book.
 *   - `notices_sent_at` — set by the (future) notice-sending pipeline.
 *     P3.6 reads it; here we only verify the column exists + writes default
 *     to NULL.
 *   - `reversed_at` + `reversed_by` — set by P3.6 rollback.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { unsafeExecute } from '@/lib/db/client';
import {
  type DecisionInput,
  type DecisionOutput,
  type WriteDecisionParams,
  getDecision,
  hashDecisionId,
  listDecisions,
  markNoticesSent,
  operatorFromHeaders,
  writeDecision,
} from '@/lib/audit/decisions';

beforeAll(async () => {
  // Mirror the schema.sql migration so the test runs without `npm run migrate`.
  await unsafeExecute(
    'CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, solve_ts TEXT NOT NULL, operator TEXT NOT NULL, inputs_hash TEXT NOT NULL, inputs_json TEXT NOT NULL, outputs_hash TEXT NOT NULL, outputs_json TEXT NOT NULL, executed_at TEXT, reversed_at TEXT, reversed_by TEXT, notices_sent_at TEXT)',
  );
});

beforeEach(async () => {
  // P3.7 WORM blocks DELETE on decisions via the wrapped `db.execute`.
  // Test teardown is the privileged escape hatch.
  await unsafeExecute('DELETE FROM decisions');
});

afterEach(async () => {
  await unsafeExecute('DELETE FROM decisions');
});

function inputs(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    budgets: {
      capital_budget: 200_000_000,
      max_nonrenew_pct: 0.1,
      cession_budget: 50_000_000,
    },
    cohorts_hash:
      'a'.repeat(64), // fake but realistic-shape SHA-256
    horizon_start: '2026-01-01',
    horizon_end: '2026-12-31',
    ...over,
  };
}

function outputs(over: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    status: 'Optimal',
    objective: 12_345_678.9,
    retained_tvar_99: 87_654_321.0,
    action_summary: {
      retain: { count: 100, tiv: 1_000_000_000 },
      non_renew: { count: 5, tiv: 50_000_000 },
    },
    ...over,
  };
}

function params(over: Partial<WriteDecisionParams> = {}): WriteDecisionParams {
  return {
    operator: 'demo_operator',
    inputs: inputs(),
    outputs: outputs(),
    ...over,
  };
}

describe('lib/audit/decisions — operatorFromHeaders', () => {
  test('reads X-Forge-Operator from a Headers instance', () => {
    const h = new Headers({ 'X-Forge-Operator': 'alice' });
    expect(operatorFromHeaders(h)).toBe('alice');
  });

  test('reads X-Forge-Operator from a plain object (case-insensitive lookup)', () => {
    expect(operatorFromHeaders({ 'x-forge-operator': 'bob' })).toBe('bob');
    expect(operatorFromHeaders({ 'X-Forge-Operator': 'carol' })).toBe('carol');
  });

  test('falls back to demo_operator when header missing', () => {
    expect(operatorFromHeaders({})).toBe('demo_operator');
    expect(operatorFromHeaders(new Headers())).toBe('demo_operator');
  });

  test('trims whitespace and rejects empty header values', () => {
    expect(operatorFromHeaders({ 'x-forge-operator': '  ' })).toBe('demo_operator');
    expect(operatorFromHeaders({ 'x-forge-operator': '  dave  ' })).toBe('dave');
  });
});

describe('lib/audit/decisions — hashDecisionId', () => {
  test('is deterministic across identical (inputs, outputs)', () => {
    const a = hashDecisionId(inputs(), outputs());
    const b = hashDecisionId(inputs(), outputs());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes when any budget changes', () => {
    const a = hashDecisionId(inputs(), outputs());
    const b = hashDecisionId(
      inputs({
        budgets: { capital_budget: 999, max_nonrenew_pct: 0.1, cession_budget: 50_000_000 },
      }),
      outputs(),
    );
    expect(a).not.toBe(b);
  });

  test('changes when outputs change', () => {
    const a = hashDecisionId(inputs(), outputs());
    const b = hashDecisionId(inputs(), outputs({ objective: 999 }));
    expect(a).not.toBe(b);
  });

  test('insensitive to JSON key ordering (canonical serialization)', () => {
    const reordered: DecisionInput = {
      // Same logical content as inputs(), keys constructed in different order.
      horizon_end: '2026-12-31',
      horizon_start: '2026-01-01',
      cohorts_hash: 'a'.repeat(64),
      budgets: {
        cession_budget: 50_000_000,
        capital_budget: 200_000_000,
        max_nonrenew_pct: 0.1,
      },
    };
    expect(hashDecisionId(inputs(), outputs())).toBe(
      hashDecisionId(reordered, outputs()),
    );
  });
});

describe('lib/audit/decisions — writeDecision', () => {
  test('writes a row that round-trips through getDecision', async () => {
    const row = await writeDecision(params());
    expect(row.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row.operator).toBe('demo_operator');
    expect(typeof row.solve_ts).toBe('string');
    expect(new Date(row.solve_ts).toString()).not.toBe('Invalid Date');
    expect(row.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.outputs_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.inputs_json).toContain('capital_budget');
    expect(row.outputs_json).toContain('Optimal');
    // Lifecycle columns default to NULL on insert.
    expect(row.executed_at).toBeNull();
    expect(row.reversed_at).toBeNull();
    expect(row.reversed_by).toBeNull();
    expect(row.notices_sent_at).toBeNull();

    const fetched = await getDecision(row.id);
    expect(fetched).toEqual(row);

    const missing = await getDecision('0'.repeat(64));
    expect(missing).toBeNull();
  });

  test('is idempotent — same (inputs, outputs) collapse into one row', async () => {
    const a = await writeDecision(params());
    const b = await writeDecision(params());
    expect(a.id).toBe(b.id);
    expect(a.solve_ts).toBe(b.solve_ts);

    const rows = await listDecisions();
    expect(rows.length).toBe(1);
  });

  test('inputs_hash collisions UNION rather than overwrite', async () => {
    // Two writes with the same inputs but different outputs → two rows
    // (the id factors in outputs, so collision-on-inputs is allowed but
    // distinct outputs → distinct rows, never silently overwriting).
    const first = await writeDecision(
      params({ outputs: outputs({ objective: 1_000_000 }) }),
    );
    const second = await writeDecision(
      params({ outputs: outputs({ objective: 2_000_000 }) }),
    );
    expect(first.id).not.toBe(second.id);
    expect(first.inputs_hash).toBe(second.inputs_hash);
    expect(first.outputs_hash).not.toBe(second.outputs_hash);

    const rows = await listDecisions();
    expect(rows.length).toBe(2);
  });

  test('rejects an empty operator string (demo_operator is opt-in via the helper)', async () => {
    await expect(writeDecision(params({ operator: '' }))).rejects.toThrow(/operator/);
    await expect(writeDecision(params({ operator: '   ' }))).rejects.toThrow(/operator/);
  });
});

describe('lib/audit/decisions — listDecisions', () => {
  test('orders by solve_ts DESC (newest first)', async () => {
    const a = await writeDecision(
      params({ inputs: inputs({ horizon_start: '2026-01-01' }) }),
    );
    // Force a deterministic ordering window — the second insert is later.
    await new Promise((r) => setTimeout(r, 5));
    const b = await writeDecision(
      params({ inputs: inputs({ horizon_start: '2026-02-01' }) }),
    );

    const rows = await listDecisions();
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe(b.id);
    expect(rows[1].id).toBe(a.id);
  });

  test('filters by operator', async () => {
    await writeDecision(
      params({
        operator: 'alice',
        inputs: inputs({ horizon_start: '2026-01-01' }),
      }),
    );
    await writeDecision(
      params({
        operator: 'alice',
        inputs: inputs({ horizon_start: '2026-02-01' }),
      }),
    );
    await writeDecision(
      params({
        operator: 'bob',
        inputs: inputs({ horizon_start: '2026-03-01' }),
      }),
    );

    const aliceRows = await listDecisions({ operator: 'alice' });
    expect(aliceRows.length).toBe(2);
    expect(aliceRows.every((r) => r.operator === 'alice')).toBe(true);

    const bobRows = await listDecisions({ operator: 'bob' });
    expect(bobRows.length).toBe(1);
    expect(bobRows[0].operator).toBe('bob');
  });

  test('applies the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await writeDecision(
        params({ inputs: inputs({ horizon_start: `2026-0${i + 1}-01` }) }),
      );
    }
    const capped = await listDecisions({ limit: 2 });
    expect(capped.length).toBe(2);
  });
});

describe('lib/audit/decisions — markNoticesSent', () => {
  test('sets notices_sent_at on an existing row', async () => {
    const row = await writeDecision(params());
    expect(row.notices_sent_at).toBeNull();

    const updated = await markNoticesSent(row.id);
    expect(updated).not.toBeNull();
    expect(updated?.notices_sent_at).toBeTruthy();
    expect(new Date(updated!.notices_sent_at!).toString()).not.toBe('Invalid Date');

    // Re-fetch confirms persistence.
    const refetched = await getDecision(row.id);
    expect(refetched?.notices_sent_at).toBe(updated?.notices_sent_at);
  });

  test('returns null when the decision id is unknown', async () => {
    const result = await markNoticesSent('0'.repeat(64));
    expect(result).toBeNull();
  });
});
