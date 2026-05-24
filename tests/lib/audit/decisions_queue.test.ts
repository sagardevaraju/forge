// @vitest-environment node
/**
 * Task P3.12 — Concurrent decision queue + locking tests.
 *
 * Pins the queue state machine (pending → in_progress → completed /
 * failed / cancelled) and the row-level locking guarantee: two
 * concurrent claimNext() calls cannot both grab the same row.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { unsafeExecute } from '@/lib/db/client';
import {
  cancel,
  claimNext,
  enqueue,
  getQueueRow,
  listQueue,
  markCompleted,
  markFailed,
} from '@/lib/audit/decisions_queue';

beforeAll(async () => {
  // Mirror the schema.sql migration so the test runs without
  // `npm run migrate`.
  await unsafeExecute(
    `CREATE TABLE IF NOT EXISTS decisions (
       id TEXT PRIMARY KEY, solve_ts TEXT NOT NULL, operator TEXT NOT NULL,
       inputs_hash TEXT NOT NULL, inputs_json TEXT NOT NULL,
       outputs_hash TEXT NOT NULL, outputs_json TEXT NOT NULL,
       executed_at TEXT, reversed_at TEXT, reversed_by TEXT, notices_sent_at TEXT
     )`,
  );
  await unsafeExecute(
    `CREATE TABLE IF NOT EXISTS decisions_queue (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       decision_id TEXT NOT NULL UNIQUE,
       state TEXT NOT NULL CHECK(state IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
       enqueued_at TEXT NOT NULL,
       claimed_by TEXT,
       claimed_at TEXT,
       completed_at TEXT,
       failed_reason TEXT,
       FOREIGN KEY (decision_id) REFERENCES decisions(id)
     )`,
  );
});

beforeEach(async () => {
  await unsafeExecute('DELETE FROM decisions_queue');
  await unsafeExecute('DELETE FROM decisions');
});

afterEach(async () => {
  await unsafeExecute('DELETE FROM decisions_queue');
  await unsafeExecute('DELETE FROM decisions');
});

async function insertFakeDecision(id: string): Promise<void> {
  await unsafeExecute({
    sql: `INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json,
                                  outputs_hash, outputs_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, new Date().toISOString(), 'demo_operator',
           'a'.repeat(64), '{}', 'b'.repeat(64), '{}'],
  });
}

describe('decisions_queue — state machine', () => {
  test('enqueue creates a pending row', async () => {
    await insertFakeDecision('d-1');
    const row = await enqueue('d-1');
    expect(row.decision_id).toBe('d-1');
    expect(row.state).toBe('pending');
    expect(row.claimed_by).toBeNull();
    expect(row.completed_at).toBeNull();
  });

  test('enqueueing the same decision twice violates UNIQUE', async () => {
    await insertFakeDecision('d-2');
    await enqueue('d-2');
    await expect(enqueue('d-2')).rejects.toThrow();
  });

  test('claimNext picks the oldest pending row and transitions to in_progress', async () => {
    await insertFakeDecision('d-1');
    await insertFakeDecision('d-2');
    await insertFakeDecision('d-3');
    await enqueue('d-1');
    await new Promise((r) => setTimeout(r, 5));
    await enqueue('d-2');
    await new Promise((r) => setTimeout(r, 5));
    await enqueue('d-3');

    const claimed = await claimNext('alice');
    expect(claimed).not.toBeNull();
    expect(claimed!.decision_id).toBe('d-1');
    expect(claimed!.state).toBe('in_progress');
    expect(claimed!.claimed_by).toBe('alice');
    expect(claimed!.claimed_at).not.toBeNull();
  });

  test('claimNext returns null when no pending rows exist', async () => {
    expect(await claimNext('alice')).toBeNull();
  });

  test('markCompleted transitions in_progress → completed', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');
    await claimNext('alice');
    const completed = await markCompleted('d-1');
    expect(completed!.state).toBe('completed');
    expect(completed!.completed_at).not.toBeNull();
  });

  test('markCompleted on a non-in-progress row returns null (stale-claim safety)', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');
    // Skip claimNext — try to complete a pending row.
    expect(await markCompleted('d-1')).toBeNull();
  });

  test('markFailed records the reason', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');
    await claimNext('alice');
    const failed = await markFailed('d-1', 'CBC solver timeout');
    expect(failed!.state).toBe('failed');
    expect(failed!.failed_reason).toBe('CBC solver timeout');
  });

  test('cancel transitions pending → cancelled', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');
    const cancelled = await cancel('d-1');
    expect(cancelled!.state).toBe('cancelled');
  });

  test('cancel transitions in_progress → cancelled', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');
    await claimNext('alice');
    const cancelled = await cancel('d-1');
    expect(cancelled!.state).toBe('cancelled');
  });

  test('cancel on completed row returns null', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');
    await claimNext('alice');
    await markCompleted('d-1');
    expect(await cancel('d-1')).toBeNull();
  });
});

describe('decisions_queue — concurrent locking', () => {
  test('two concurrent claimNext calls do not double-claim the same row', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');

    // Fire two claims in parallel — only one should get a row, the
    // other should get null. The atomic UPDATE-RETURNING ensures
    // libSQL serialises both inside its per-connection write lock.
    const [a, b] = await Promise.all([
      claimNext('alice'),
      claimNext('bob'),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    expect(winners[0]!.decision_id).toBe('d-1');
  });

  test('many concurrent claims distribute rows without double-claim', async () => {
    // 10 rows, 10 concurrent claimers — every row must be claimed
    // exactly once.
    const N = 10;
    for (let i = 0; i < N; i++) {
      await insertFakeDecision(`d-${i}`);
      await enqueue(`d-${i}`);
    }

    const claims = await Promise.all(
      Array.from({ length: N + 5 }, (_, i) => claimNext(`claimer-${i}`)),
    );
    const claimedIds = claims
      .filter((c) => c !== null)
      .map((c) => c!.decision_id)
      .sort();
    expect(claimedIds).toEqual(
      Array.from({ length: N }, (_, i) => `d-${i}`).sort(),
    );
    // No duplicates.
    expect(new Set(claimedIds).size).toBe(N);
  });
});

describe('decisions_queue — read helpers', () => {
  test('getQueueRow returns the current row', async () => {
    await insertFakeDecision('d-1');
    await enqueue('d-1');
    const row = await getQueueRow('d-1');
    expect(row).not.toBeNull();
    expect(row!.state).toBe('pending');
  });

  test('getQueueRow returns null for unknown decision', async () => {
    expect(await getQueueRow('nonexistent')).toBeNull();
  });

  test('listQueue without filter returns all rows in enqueue order', async () => {
    await insertFakeDecision('d-1');
    await insertFakeDecision('d-2');
    await enqueue('d-1');
    await new Promise((r) => setTimeout(r, 5));
    await enqueue('d-2');
    const rows = await listQueue();
    expect(rows.map((r) => r.decision_id)).toEqual(['d-1', 'd-2']);
  });

  test('listQueue filters by single state', async () => {
    await insertFakeDecision('d-1');
    await insertFakeDecision('d-2');
    await enqueue('d-1');
    await enqueue('d-2');
    await claimNext('alice');
    const pending = await listQueue('pending');
    const inProgress = await listQueue('in_progress');
    expect(pending).toHaveLength(1);
    expect(inProgress).toHaveLength(1);
  });

  test('listQueue filters by multiple states', async () => {
    await insertFakeDecision('d-1');
    await insertFakeDecision('d-2');
    await insertFakeDecision('d-3');
    await enqueue('d-1');
    await enqueue('d-2');
    await enqueue('d-3');
    await claimNext('alice');
    await claimNext('bob');
    await markCompleted('d-1');
    const open = await listQueue(['pending', 'in_progress']);
    expect(open.map((r) => r.decision_id).sort()).toEqual(['d-2', 'd-3']);
  });

  test('listQueue rejects unknown state', async () => {
    await expect(
      listQueue('not-a-state' as unknown as 'pending'),
    ).rejects.toThrow(/unknown state/);
  });
});
