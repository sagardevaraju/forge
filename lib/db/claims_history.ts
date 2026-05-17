/**
 * Task P2.29 — Severity diff vs last refresh.
 *
 * The ``/claims`` page persists each render's severity snapshot to the
 * ``claims_history`` table (one row per ``policy_id``, last-write-wins).
 * The next render loads the prior snapshot and computes a ↑/↓/= per row in
 * the Δ column of ``components/ClaimsTable.tsx``.
 *
 * Schema (``lib/db/schema.sql``):
 *   claims_history(policy_id PK, severity REAL, snapshot_ts TEXT)
 *
 * Lifecycle:
 *   * One row per policy_id (PRIMARY KEY on ``policy_id``).
 *   * Each render upserts the visible policies' current severities. A policy
 *     that drops out of the pre-flag set keeps its last row (no GC) — the
 *     row only matters when the policy is flagged again.
 *   * "Severity" here means the policy's *expected-loss number* (the value
 *     surfaced in the table's loss column), not the categorical severity
 *     bucket. That's what the operator perceives flickering on the table.
 *
 * Phase-2 deliverable is the diff against the most recent snapshot only.
 * A full audit trail (every snapshot, query history) is a Phase-3 extension.
 */
import { db } from './client';

/** A single (policy_id, severity) pair to persist. */
export interface SnapshotRow {
  policy_id: number;
  severity: number;
}

/**
 * Bulk upsert the current snapshot. Empty input is a no-op (no SQL issued)
 * so the page can call this unconditionally without a guard. ``snapshot_ts``
 * is assigned server-side (ISO-8601, UTC) — callers don't supply it.
 */
export async function upsertSnapshot(rows: SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  const ts = new Date().toISOString();
  // libSQL supports SQLite UPSERT; the PRIMARY KEY on ``policy_id`` makes
  // ``ON CONFLICT`` deterministic. We issue one statement per row to keep
  // arg-binding simple — the pre-flag set is bounded to ≤ 200 (see
  // ``app/claims/page.tsx``), so this is well below libSQL's per-request
  // budget. Migrate to a single multi-row VALUES (...) construct if the cap
  // ever grows.
  for (const row of rows) {
    await db.execute({
      sql:
        'INSERT INTO claims_history (policy_id, severity, snapshot_ts) ' +
        'VALUES (?, ?, ?) ' +
        'ON CONFLICT(policy_id) DO UPDATE SET ' +
        'severity = excluded.severity, snapshot_ts = excluded.snapshot_ts',
      args: [row.policy_id, row.severity, ts],
    });
  }
}

/**
 * Load the prior snapshot as a ``Map<policy_id, severity>``. Returns an
 * empty map when the table is empty (first-ever render). Never throws on
 * an empty result.
 */
export async function loadPrevSeverities(): Promise<Map<number, number>> {
  const r = await db.execute('SELECT policy_id, severity FROM claims_history');
  const out = new Map<number, number>();
  for (const row of r.rows) {
    const rec = row as unknown as Record<string, unknown>;
    out.set(Number(rec.policy_id), Number(rec.severity));
  }
  return out;
}
