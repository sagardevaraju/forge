/**
 * Task P3.4 — Versioned decision ledger.
 *
 * Every call to `/api/optimize/portfolio` writes one row to `decisions`. The
 * row's primary key is a SHA-256 hash of (inputs_hash + outputs_hash) so a
 * replay of the exact same solve is idempotent: same inputs + same outputs
 * → same id → no duplicate rows.
 *
 * What we store (per row):
 *   * ``id``               — SHA-256 of ``inputs_hash + outputs_hash``
 *   * ``solve_ts``         — ISO-8601 of when the solve completed
 *   * ``operator``         — `X-Forge-Operator` header value, or
 *                            ``'demo_operator'`` until P3.1 auth lands
 *   * ``inputs_hash``      — SHA-256 of canonical-JSON of DecisionInput
 *   * ``inputs_json``      — canonical-JSON of DecisionInput (≈300 bytes:
 *                            budgets + horizon + cohorts_hash, NOT the
 *                            full cohort list — that lives in the artifact
 *                            and is fingerprinted by `cohorts_hash`)
 *   * ``outputs_hash``     — SHA-256 of canonical-JSON of DecisionOutput
 *   * ``outputs_json``     — canonical-JSON of the PortfolioOptimization
 *                            response minus `loss_scenarios` (≈30-50 KB).
 *                            Self-contained for the /audit diff view.
 *   * ``executed_at``      — set when the operator commits the solve.
 *                            NULL on a `propose`-only write.
 *   * ``reversed_at``      — set by P3.6 rollback.
 *   * ``reversed_by``      — operator who issued the rollback.
 *   * ``notices_sent_at``  — set by the (future) notice-sending pipeline;
 *                            read by P3.6 to flag manual-reversal-required.
 *
 * Operator identity (Phase 3′ — auth deferred):
 *   The route reads `X-Forge-Operator` from incoming headers via
 *   `operatorFromHeaders`; missing/blank headers fall back to
 *   `'demo_operator'`. When P3.1 auth lands, the same call site swaps
 *   `operatorFromHeaders(req.headers)` for `session.user.id`. No schema
 *   migration needed.
 *
 * Canonicalization rule:
 *   ``inputs_json`` and ``outputs_json`` are serialized with
 *   `canonicalJson()` — keys sorted recursively, no whitespace. Two payloads
 *   that differ only in key order therefore hash to the same id.
 *
 * Out of scope for this task:
 *   - WORM enforcement (P3.7)
 *   - `/audit` UI rendering (P3.8)
 *   - Rollback flow (P3.6) — `markNoticesSent` + the lifecycle columns
 *     are pre-wired so P3.6 lands without a migration
 *
 * P3.7 design tension to resolve later:
 *   Lifecycle setters (`markNoticesSent` here; `markReversed` in P3.6;
 *   `markExecuted` likely too) use UPDATE on `decisions`. A blanket
 *   `deny UPDATE on decisions` WORM rule would break them. P3.7 needs to
 *   either (a) allow updates to the lifecycle columns specifically
 *   (`notices_sent_at`, `executed_at`, `reversed_at`, `reversed_by`) while
 *   denying writes to the immutable content columns (`inputs_*`,
 *   `outputs_*`, `operator`, `solve_ts`), or (b) move lifecycle state to a
 *   separate `decision_lifecycle_events` append-only table. Option (b) is
 *   cleaner WORM but adds a join to every /audit query; option (a) keeps
 *   the schema simple. Decision deferred to P3.7's design pass.
 */
import { createHash } from 'node:crypto';
import { db } from '@/lib/db/client';

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

export interface DecisionBudgets {
  capital_budget: number;
  max_nonrenew_pct: number;
  cession_budget: number;
}

export interface DecisionInput {
  budgets: DecisionBudgets;
  /** SHA-256 fingerprint of the artifact's cohort list. */
  cohorts_hash: string;
  horizon_start?: string | null;
  horizon_end?: string | null;
}

/**
 * The solver output shape. We don't strongly type it here — the route
 * passes a PortfolioOptimization stripped of `loss_scenarios`, and the
 * shape may evolve. The ledger only needs the canonical-JSON serialization
 * to be deterministic, which `canonicalJson` guarantees regardless of the
 * underlying object shape.
 */
export type DecisionOutput = Record<string, unknown>;

export interface DecisionRow {
  id: string;
  solve_ts: string;
  operator: string;
  inputs_hash: string;
  inputs_json: string;
  outputs_hash: string;
  outputs_json: string;
  executed_at: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  notices_sent_at: string | null;
}

export interface WriteDecisionParams {
  operator: string;
  inputs: DecisionInput;
  outputs: DecisionOutput;
  /** Override `new Date().toISOString()` — test/replay only. */
  solve_ts?: string;
}

export interface ListDecisionsFilter {
  operator?: string;
  limit?: number;
}

export interface ReverseDecisionParams {
  id: string;
  reversed_by: string;
  /** Test/replay override for `new Date().toISOString()`. */
  reversed_at?: string;
}

export interface ReverseDecisionResult {
  /**
   * The post-reversal row, or `null` if no row with the given id exists.
   * On `already_reversed: true`, this is the originally-reversed row — we
   * do NOT overwrite the first reversal's attribution.
   */
  decision: DecisionRow | null;
  /**
   * `true` when the decision's `notices_sent_at` is non-null — the rollback
   * is recorded in the ledger but the operator must also issue manual
   * rescissions to the customers who already received notices. P3.6 flag.
   */
  manual_reversal_required: boolean;
  /**
   * `true` when the decision was already reversed before this call. The
   * write is a no-op in that case; the original reversed_at + reversed_by
   * stay put.
   */
  already_reversed: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Canonical JSON + hashing — mirrors lib/audit/log.ts (P2.36).
// ────────────────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Hash a decision row's content-addressed id.
 *
 * id = SHA-256(SHA-256(canonical(inputs)) + SHA-256(canonical(outputs)))
 *
 * The solve_ts and operator are deliberately NOT in the hash — the same
 * logical solve replayed by a different operator, or on a different day,
 * still represents the same input → output mapping.
 */
export function hashDecisionId(inputs: DecisionInput, outputs: DecisionOutput): string {
  const inputs_hash = sha256(canonicalJson(inputs));
  const outputs_hash = sha256(canonicalJson(outputs));
  return sha256(inputs_hash + outputs_hash);
}

// ────────────────────────────────────────────────────────────────────────
// Operator-from-headers (Phase 3′ — auth deferred).
// ────────────────────────────────────────────────────────────────────────

/**
 * Read the operator identity from request headers.
 *
 * Phase 3′: pulls `X-Forge-Operator`; blank or missing → `'demo_operator'`.
 * The header lookup is case-insensitive (matches Node's `Headers` behavior
 * for plain-object inputs too).
 *
 * P3.1 (auth) swap: replace the call site with `session.user.id`. The
 * `decisions.operator` column accepts both values without migration.
 */
export function operatorFromHeaders(
  headers: Headers | Record<string, string | undefined>,
): string {
  let raw: string | undefined | null;
  if (headers instanceof Headers) {
    raw = headers.get('x-forge-operator');
  } else {
    // Case-insensitive lookup against a plain object.
    raw = headers['x-forge-operator'];
    if (raw === undefined) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'x-forge-operator') {
          raw = headers[k];
          break;
        }
      }
    }
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return 'demo_operator';
}

// ────────────────────────────────────────────────────────────────────────
// DB I/O.
// ────────────────────────────────────────────────────────────────────────

function rowToDecision(row: Record<string, unknown>): DecisionRow {
  const orNull = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);
  return {
    id: String(row.id),
    solve_ts: String(row.solve_ts),
    operator: String(row.operator),
    inputs_hash: String(row.inputs_hash),
    inputs_json: String(row.inputs_json),
    outputs_hash: String(row.outputs_hash),
    outputs_json: String(row.outputs_json),
    executed_at: orNull(row.executed_at),
    reversed_at: orNull(row.reversed_at),
    reversed_by: orNull(row.reversed_by),
    notices_sent_at: orNull(row.notices_sent_at),
  };
}

const SELECT_COLS =
  'id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json, executed_at, reversed_at, reversed_by, notices_sent_at';

/**
 * Append a decision row. Idempotent on (inputs, outputs): the
 * content-addressed primary key + ``INSERT ... ON CONFLICT DO NOTHING``
 * makes duplicate writes a no-op rather than an error.
 *
 * Returns the row that now exists — either the freshly inserted one or the
 * previously-stored row if this was a duplicate. The returned `solve_ts`
 * is whichever one persisted, not the retry's clock.
 */
export async function writeDecision(params: WriteDecisionParams): Promise<DecisionRow> {
  const operator = params.operator?.trim() ?? '';
  if (operator.length === 0) {
    throw new Error('writeDecision: operator must be a non-empty string');
  }

  const inputs_json = canonicalJson(params.inputs);
  const outputs_json = canonicalJson(params.outputs);
  const inputs_hash = sha256(inputs_json);
  const outputs_hash = sha256(outputs_json);
  const id = sha256(inputs_hash + outputs_hash);
  const solve_ts = params.solve_ts ?? new Date().toISOString();

  await db.execute({
    sql:
      'INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO NOTHING',
    args: [id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json],
  });

  // Re-read so the returned row reflects the persisted solve_ts (idempotent
  // path keeps the original ts rather than overwriting it with the retry's
  // clock).
  const stored = await getDecision(id);
  if (stored) return stored;

  // Defensive — getDecision returning null after a successful insert would
  // mean the table was wiped between INSERT and SELECT. Surface that rather
  // than synthesizing a phantom row.
  throw new Error(`writeDecision: row ${id} disappeared after insert`);
}

export async function getDecision(id: string): Promise<DecisionRow | null> {
  const r = await db.execute({
    sql: `SELECT ${SELECT_COLS} FROM decisions WHERE id = ? LIMIT 1`,
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return rowToDecision(r.rows[0] as unknown as Record<string, unknown>);
}

export async function listDecisions(
  filter: ListDecisionsFilter = {},
): Promise<DecisionRow[]> {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.operator !== undefined) {
    where.push('operator = ?');
    args.push(filter.operator);
  }
  let sql = `SELECT ${SELECT_COLS} FROM decisions`;
  if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
  // Tie-breaker on id keeps ordering deterministic when two rows land in
  // the same millisecond (tests sometimes do — the inserts are async but
  // can race the clock granularity on libSQL).
  sql += ' ORDER BY solve_ts DESC, id DESC';
  if (filter.limit !== undefined && filter.limit > 0) {
    sql += ' LIMIT ?';
    args.push(filter.limit);
  }

  const r = await db.execute({ sql, args });
  return r.rows.map((row) => rowToDecision(row as unknown as Record<string, unknown>));
}

/**
 * Mark a decision as having had its non-renew / reprice notices delivered.
 *
 * P3.6 reads this column to decide whether a rollback also needs a manual
 * rescission flow (notices already in the mail can't be silently undone).
 * The notice-sending pipeline itself is a future task — this writer is the
 * interface that pipeline will call.
 */
export async function markNoticesSent(
  id: string,
  ts?: string,
): Promise<DecisionRow | null> {
  const sentAt = ts ?? new Date().toISOString();
  const existing = await getDecision(id);
  if (!existing) return null;
  await db.execute({
    sql: 'UPDATE decisions SET notices_sent_at = ? WHERE id = ?',
    args: [sentAt, id],
  });
  return getDecision(id);
}

/**
 * Task P3.6 — Roll back a decision by stamping `reversed_at` + `reversed_by`.
 *
 * Idempotent: a repeat call on an already-reversed decision is a no-op;
 * the original reversal attribution is preserved (we don't overwrite who
 * pulled the lever first).
 *
 * If the decision's `notices_sent_at` is non-null, the result carries
 * `manual_reversal_required: true` — the rollback row is written, but the
 * caller (route, UI) must also surface the customer-list payload so the
 * operator can issue rescissions for the notices already in flight.
 *
 * WORM compatibility: the UPDATE here touches only `reversed_at` +
 * `reversed_by`, both on the lifecycle-column allowlist in
 * `lib/db/client.ts` (P3.7). A WORM violation here would mean the
 * allowlist drifted.
 */
export async function reverseDecision(
  params: ReverseDecisionParams,
): Promise<ReverseDecisionResult> {
  const reversedBy = params.reversed_by?.trim() ?? '';
  if (reversedBy.length === 0) {
    throw new Error('reverseDecision: reversed_by must be a non-empty string');
  }

  const existing = await getDecision(params.id);
  if (!existing) {
    return { decision: null, manual_reversal_required: false, already_reversed: false };
  }

  if (existing.reversed_at !== null) {
    return {
      decision: existing,
      manual_reversal_required: existing.notices_sent_at !== null,
      already_reversed: true,
    };
  }

  const reversedAt = params.reversed_at ?? new Date().toISOString();
  await db.execute({
    sql: 'UPDATE decisions SET reversed_at = ?, reversed_by = ? WHERE id = ?',
    args: [reversedAt, reversedBy, params.id],
  });

  const updated = await getDecision(params.id);
  return {
    decision: updated,
    manual_reversal_required: updated?.notices_sent_at !== null,
    already_reversed: false,
  };
}
