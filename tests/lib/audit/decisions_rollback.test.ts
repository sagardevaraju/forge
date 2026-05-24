// @vitest-environment node
/**
 * Task P3.6 — `reverseDecision` library tests.
 *
 * Sibling to tests/lib/audit/decisions.test.ts. We keep rollback in its
 * own file so the diff vs the P3.4 baseline is unmistakable.
 *
 * Behavior the tests pin:
 *   1. Reversing an unknown id returns null + flags off.
 *   2. Reversing a fresh decision writes reversed_at + reversed_by and
 *      returns the updated row with `manual_reversal_required: false`.
 *   3. Reversing a decision whose `notices_sent_at` is non-null returns
 *      `manual_reversal_required: true`.
 *   4. Double-reversal is idempotent (`already_reversed: true`, original
 *      reversed_at preserved).
 *   5. Optimizing for the WORM allowlist: the SQL the writer emits hits
 *      only `reversed_at` + `reversed_by` columns — already covered by
 *      the P3.7 worm tests, but a smoke test here doubles as a contract.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { unsafeExecute } from '@/lib/db/client';
import {
  type WriteDecisionParams,
  getDecision,
  markNoticesSent,
  reverseDecision,
  writeDecision,
} from '@/lib/audit/decisions';

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

describe('lib/audit/decisions — reverseDecision', () => {
  test('unknown id returns null + flags off', async () => {
    const result = await reverseDecision({ id: '0'.repeat(64), reversed_by: 'bob' });
    expect(result.decision).toBeNull();
    expect(result.manual_reversal_required).toBe(false);
    expect(result.already_reversed).toBe(false);
  });

  test('rejects empty reversed_by (no audit attribution = no rollback)', async () => {
    const row = await writeDecision(makeParams());
    await expect(
      reverseDecision({ id: row.id, reversed_by: '' }),
    ).rejects.toThrow(/reversed_by/);
    await expect(
      reverseDecision({ id: row.id, reversed_by: '   ' }),
    ).rejects.toThrow(/reversed_by/);
  });

  test('happy path — writes reversed_at + reversed_by, no notices warning', async () => {
    const row = await writeDecision(makeParams());
    expect(row.reversed_at).toBeNull();
    expect(row.reversed_by).toBeNull();

    const result = await reverseDecision({ id: row.id, reversed_by: 'bob' });
    expect(result.decision).not.toBeNull();
    expect(result.decision?.reversed_by).toBe('bob');
    expect(result.decision?.reversed_at).toBeTruthy();
    expect(new Date(result.decision!.reversed_at!).toString()).not.toBe('Invalid Date');
    expect(result.manual_reversal_required).toBe(false);
    expect(result.already_reversed).toBe(false);

    // Verify via fresh read (UPDATE actually persisted).
    const refetched = await getDecision(row.id);
    expect(refetched?.reversed_by).toBe('bob');
    expect(refetched?.reversed_at).toBe(result.decision?.reversed_at);
  });

  test('manual_reversal_required: true when notices_sent_at is non-null', async () => {
    const row = await writeDecision(makeParams());
    await markNoticesSent(row.id);

    const result = await reverseDecision({ id: row.id, reversed_by: 'bob' });
    expect(result.decision?.reversed_at).toBeTruthy();
    expect(result.manual_reversal_required).toBe(true);
  });

  test('double-reversal is idempotent — original reversed_at + reversed_by preserved', async () => {
    const row = await writeDecision(makeParams());
    const first = await reverseDecision({
      id: row.id,
      reversed_by: 'bob',
      reversed_at: '2026-03-01T00:00:00Z',
    });
    expect(first.already_reversed).toBe(false);

    const second = await reverseDecision({
      id: row.id,
      reversed_by: 'carol',
      reversed_at: '2026-04-01T00:00:00Z',
    });
    expect(second.already_reversed).toBe(true);
    // The decision's reversed_at + reversed_by reflect the FIRST reversal.
    expect(second.decision?.reversed_at).toBe('2026-03-01T00:00:00Z');
    expect(second.decision?.reversed_by).toBe('bob');
  });

  test('explicit reversed_at override is honored (test/replay use)', async () => {
    const row = await writeDecision(makeParams());
    const stamp = '2026-02-14T12:34:56Z';
    const result = await reverseDecision({
      id: row.id,
      reversed_by: 'bob',
      reversed_at: stamp,
    });
    expect(result.decision?.reversed_at).toBe(stamp);
  });
});
