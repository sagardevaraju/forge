/**
 * Task P2.33 — Operator pin mechanism.
 *
 * A human operator can override the Portfolio MIP's recommended action for a
 * specific policy. The pin says "for policy X, the action MUST be Y, regardless
 * of what the optimizer recommends." Pins are stored in the libSQL ``pins``
 * table and honored by the Decision Reconciler
 * (``lib/reconciler/index.ts``); the reconciler emits a ``PinStamp`` so the
 * UI / agent channel can trace overridden cohorts.
 *
 * Schema (``lib/db/schema.sql``):
 *   pins(policy_id PK, action, operator, ts ISO-8601, rationale)
 *
 * Lifecycle:
 *   * One pin per policy (PRIMARY KEY on policy_id).
 *   * To "unpin", DELETE the row.
 *   * Pins persist across solves until removed — they live independently of
 *     the artifact cache.
 *
 * Validation:
 *   * ``action`` must be one of the six MIP actions. The reconciler-side
 *     labels (``non_renew_next_renewal`` / ``non_renew_capped``) are NOT
 *     pinnable; operators pin MIP actions and the reconciler downstream may
 *     still downgrade them via the P2.31 / P2.32 filters.
 *   * Auth is intentionally absent: the ``operator`` field accepts any
 *     non-empty string for the demo. Real auth lands in Phase 3 (P3.5
 *     two-person rule).
 */
import { db } from './client';
import type { ActionName } from '@/lib/portfolio-actions';

const ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>([
  'retain',
  'reprice_up',
  'reprice_down',
  'non_renew',
  'cede_qs',
  'cede_xs',
]);

export interface Pin {
  policy_id: number;
  action: ActionName;
  operator: string;
  /** ISO-8601 — assigned server-side by ``setPin``. */
  ts: string;
  rationale: string;
}

/**
 * Row → Pin coercion. libSQL returns ``Value`` (string | number | bigint |
 * Uint8Array | null); we narrow each field defensively.
 */
function rowToPin(row: Record<string, unknown>): Pin {
  return {
    policy_id: Number(row.policy_id),
    action: String(row.action) as ActionName,
    operator: String(row.operator),
    ts: String(row.ts),
    rationale: String(row.rationale),
  };
}

export async function listPins(): Promise<Pin[]> {
  const r = await db.execute(
    'SELECT policy_id, action, operator, ts, rationale FROM pins ORDER BY ts DESC',
  );
  return r.rows.map((row) => rowToPin(row as unknown as Record<string, unknown>));
}

export async function getPin(policyId: number): Promise<Pin | null> {
  const r = await db.execute({
    sql: 'SELECT policy_id, action, operator, ts, rationale FROM pins WHERE policy_id = ? LIMIT 1',
    args: [policyId],
  });
  if (r.rows.length === 0) return null;
  return rowToPin(r.rows[0] as unknown as Record<string, unknown>);
}

/**
 * Upsert a pin. ``ts`` is assigned server-side (ISO-8601, UTC) and is NOT
 * accepted from callers — pin freshness is a server-controlled field.
 *
 * @throws Error if ``action`` is not one of the six MIP actions.
 * @throws Error if ``operator`` is empty.
 * @throws Error if ``rationale`` is shorter than 10 characters.
 */
export async function setPin(pin: Omit<Pin, 'ts'>): Promise<Pin> {
  if (!ACTIONS.has(pin.action)) {
    throw new Error(
      `invalid action "${pin.action}" — must be one of ${Array.from(ACTIONS).join(', ')}`,
    );
  }
  if (!pin.operator || pin.operator.trim().length === 0) {
    throw new Error('operator must be a non-empty string');
  }
  if (!pin.rationale || pin.rationale.trim().length < 10) {
    throw new Error('rationale must be at least 10 characters');
  }

  const ts = new Date().toISOString();
  // libSQL supports the SQLite UPSERT clause; the PRIMARY KEY on policy_id
  // makes ``ON CONFLICT`` deterministic. Using a single statement (vs.
  // DELETE + INSERT) keeps the operation atomic on remote Turso.
  await db.execute({
    sql:
      'INSERT INTO pins (policy_id, action, operator, ts, rationale) ' +
      'VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(policy_id) DO UPDATE SET ' +
      'action = excluded.action, operator = excluded.operator, ' +
      'ts = excluded.ts, rationale = excluded.rationale',
    args: [pin.policy_id, pin.action, pin.operator, ts, pin.rationale],
  });
  return { ...pin, ts };
}

export async function deletePin(policyId: number): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM pins WHERE policy_id = ?',
    args: [policyId],
  });
}
