/**
 * Task P3.12 — Concurrent decision queue + locking.
 *
 * The audit ledger (`decisions`) is WORM-immutable per P3.7. To
 * support multi-operator concurrent workflows we add a separate
 * `decisions_queue` table that carries a freely-mutable lifecycle
 * state on top of each decision. Only one queue row exists per
 * decision (UNIQUE on `decision_id`).
 *
 * State machine:
 *
 *     pending ──┬─→ in_progress ──┬─→ completed
 *               │                  └─→ failed
 *               └─→ cancelled
 *
 * Locking model — row-level atomic UPDATE:
 *   The `claimNext(operator)` call uses a single atomic UPDATE-RETURNING
 *   that targets the oldest pending row by id, transitioning it to
 *   `in_progress` in the same statement. SQLite / libSQL serialises
 *   writes per transaction so two concurrent claimers cannot both pick
 *   the same row — the second one's UPDATE matches zero rows and the
 *   helper returns null.
 *
 * Operator identity:
 *   `claimed_by` is whatever `operatorFromHeaders(req.headers)` returns
 *   (`X-Forge-Operator` header, default `'demo_operator'`). Drop-in
 *   replaceable with a Clerk session id when P3.1 unparks.
 *
 * WORM compatibility:
 *   This module exclusively touches `decisions_queue`, which is NOT
 *   policed by the P3.7 column-level WORM guard. The `decisions` table
 *   itself is unchanged.
 */
import { db } from '@/lib/db/client';

export type QueueState =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface QueueRow {
  id: number;
  decision_id: string;
  state: QueueState;
  enqueued_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  failed_reason: string | null;
}

const ALLOWED_STATES: ReadonlySet<QueueState> = new Set([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Enqueue a decision for processing. Returns the new queue row.
 *
 * Throws if the decision_id is already enqueued — the UNIQUE
 * constraint on `decision_id` prevents the same decision being queued
 * twice (use `cancel()` + `enqueue()` to re-queue a cancelled
 * decision).
 */
export async function enqueue(decisionId: string): Promise<QueueRow> {
  const enqueued_at = nowIso();
  const res = await db.execute({
    sql: `INSERT INTO decisions_queue (decision_id, state, enqueued_at)
          VALUES (?, 'pending', ?)
          RETURNING id, decision_id, state, enqueued_at,
                    claimed_by, claimed_at, completed_at, failed_reason`,
    args: [decisionId, enqueued_at],
  });
  return rowToQueue(res.rows[0]);
}

/**
 * Atomically claim the oldest pending row and transition it to
 * `in_progress`. Returns the claimed row, or null if no pending rows
 * are available.
 *
 * The whole pick-and-update happens in a single SQL statement so two
 * concurrent claimers cannot both grab the same row. The second
 * claimer's UPDATE matches zero rows (because the row's state already
 * moved to `in_progress`) and gets null back.
 */
export async function claimNext(operator: string): Promise<QueueRow | null> {
  const claimed_at = nowIso();
  // Single statement: SELECT the oldest pending id, then UPDATE only if
  // it's still pending (concurrent-safe via libSQL's per-connection
  // serialisation). Falls back to returning empty rows if no candidate.
  const res = await db.execute({
    sql: `UPDATE decisions_queue
            SET state = 'in_progress',
                claimed_by = ?,
                claimed_at = ?
          WHERE id = (
            SELECT id FROM decisions_queue
            WHERE state = 'pending'
            ORDER BY enqueued_at ASC, id ASC
            LIMIT 1
          )
          AND state = 'pending'
          RETURNING id, decision_id, state, enqueued_at,
                    claimed_by, claimed_at, completed_at, failed_reason`,
    args: [operator, claimed_at],
  });
  if (res.rows.length === 0) return null;
  return rowToQueue(res.rows[0]);
}

/**
 * Mark an in-progress row as completed. Returns the updated row, or
 * null if the row isn't in the expected state (the claimer is expected
 * to handle the null by surfacing a stale-claim warning to the
 * operator).
 */
export async function markCompleted(decisionId: string): Promise<QueueRow | null> {
  const completed_at = nowIso();
  const res = await db.execute({
    sql: `UPDATE decisions_queue
            SET state = 'completed',
                completed_at = ?
          WHERE decision_id = ?
          AND state = 'in_progress'
          RETURNING id, decision_id, state, enqueued_at,
                    claimed_by, claimed_at, completed_at, failed_reason`,
    args: [completed_at, decisionId],
  });
  if (res.rows.length === 0) return null;
  return rowToQueue(res.rows[0]);
}

/**
 * Mark an in-progress row as failed, recording the reason. Same
 * stale-claim handling as `markCompleted`.
 */
export async function markFailed(
  decisionId: string,
  reason: string,
): Promise<QueueRow | null> {
  const completed_at = nowIso();
  const res = await db.execute({
    sql: `UPDATE decisions_queue
            SET state = 'failed',
                completed_at = ?,
                failed_reason = ?
          WHERE decision_id = ?
          AND state = 'in_progress'
          RETURNING id, decision_id, state, enqueued_at,
                    claimed_by, claimed_at, completed_at, failed_reason`,
    args: [completed_at, reason, decisionId],
  });
  if (res.rows.length === 0) return null;
  return rowToQueue(res.rows[0]);
}

/**
 * Cancel a pending or in-progress row. Operator may want to re-queue
 * the decision via `enqueue()` after; the cancel does not delete the
 * row (kept for audit) — caller deletes-then-enqueues if a re-queue
 * is needed (the UNIQUE constraint requires the cancelled row to be
 * removed first).
 */
export async function cancel(decisionId: string): Promise<QueueRow | null> {
  const completed_at = nowIso();
  const res = await db.execute({
    sql: `UPDATE decisions_queue
            SET state = 'cancelled',
                completed_at = ?
          WHERE decision_id = ?
          AND state IN ('pending', 'in_progress')
          RETURNING id, decision_id, state, enqueued_at,
                    claimed_by, claimed_at, completed_at, failed_reason`,
    args: [completed_at, decisionId],
  });
  if (res.rows.length === 0) return null;
  return rowToQueue(res.rows[0]);
}

/**
 * Read the current queue row for a decision (returns null if not in
 * the queue).
 */
export async function getQueueRow(decisionId: string): Promise<QueueRow | null> {
  const res = await db.execute({
    sql: `SELECT id, decision_id, state, enqueued_at,
                 claimed_by, claimed_at, completed_at, failed_reason
            FROM decisions_queue
           WHERE decision_id = ?`,
    args: [decisionId],
  });
  if (res.rows.length === 0) return null;
  return rowToQueue(res.rows[0]);
}

/**
 * List queue rows by state. `state` can be a single state or an array.
 * Useful for the queue dashboard / operator view.
 */
export async function listQueue(state?: QueueState | QueueState[]): Promise<QueueRow[]> {
  if (state === undefined) {
    const res = await db.execute(
      `SELECT id, decision_id, state, enqueued_at,
              claimed_by, claimed_at, completed_at, failed_reason
         FROM decisions_queue
        ORDER BY enqueued_at ASC, id ASC`,
    );
    return res.rows.map(rowToQueue);
  }
  const states = Array.isArray(state) ? state : [state];
  for (const s of states) {
    if (!ALLOWED_STATES.has(s)) {
      throw new Error(`listQueue: unknown state '${s}'`);
    }
  }
  const placeholders = states.map(() => '?').join(',');
  const res = await db.execute({
    sql: `SELECT id, decision_id, state, enqueued_at,
                 claimed_by, claimed_at, completed_at, failed_reason
            FROM decisions_queue
           WHERE state IN (${placeholders})
        ORDER BY enqueued_at ASC, id ASC`,
    args: states,
  });
  return res.rows.map(rowToQueue);
}

function rowToQueue(row: Record<string, unknown>): QueueRow {
  return {
    id: Number(row.id),
    decision_id: String(row.decision_id),
    state: String(row.state) as QueueState,
    enqueued_at: String(row.enqueued_at),
    claimed_by: row.claimed_by == null ? null : String(row.claimed_by),
    claimed_at: row.claimed_at == null ? null : String(row.claimed_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    failed_reason: row.failed_reason == null ? null : String(row.failed_reason),
  };
}
