/**
 * Task P2.36 — Content-addressed chat audit log.
 *
 * Every chat turn is logged to ``chat_audit`` so an auditor can later answer:
 * "did this prompt, dispatched through this exact tool-call sequence,
 * produce that final assistant message?" The row's primary key is a SHA-256
 * hash of the inputs — same inputs → same id → idempotent UPSERT.
 *
 * What we store (per row):
 *   * ``id``           — SHA-256 of ``prompt_hash + tool_calls_json + final_hash``
 *   * ``ts``           — ISO-8601 of when the row was logged (server time)
 *   * ``user_id``      — caller identity (``'demo_user'`` until Phase 3 auth)
 *   * ``prompt_hash``  — SHA-256 of the user prompt text
 *   * ``tool_calls_json`` — canonical JSON of the tool-call sequence (name + args)
 *   * ``final_hash``   — SHA-256 of the final assistant message text
 *
 * What we do NOT store:
 *   * Tool RESULTS. They can be large (cohort dumps, scenario tables) and may
 *     contain sensitive content (claim PII once Phase 3 lands). Content-
 *     addressing inputs + final output is enough to verify a turn.
 *   * Real user identity. ``user_id = 'demo_user'`` is a placeholder; Phase 3
 *     auth (P3.5) replaces it.
 *
 * Canonicalization rule:
 *   ``tool_calls_json`` is serialized with ``canonicalJson()`` — keys sorted
 *   recursively, no whitespace. Two payloads that differ only in key order
 *   therefore hash to the same id (the test ``tool_calls_json is canonical``
 *   pins this).
 *
 * Out of scope (Phase 3): WORM enforcement (P3.7), ``/audit`` UI (P3.8),
 * retention/cleanup, real auth.
 */
import { createHash } from 'node:crypto';
import { db } from '@/lib/db/client';

export interface AuditRow {
  id: string;
  ts: string;
  user_id: string;
  prompt_hash: string;
  tool_calls_json: string;
  final_hash: string;
}

export interface AuditInput {
  user_id: string;
  prompt: string;
  tool_calls: Array<{ name: string; args: unknown }>;
  final: string;
}

interface AuditListFilter {
  user_id?: string;
  limit?: number;
}

/**
 * Canonical JSON: keys sorted recursively, no whitespace. Two structurally
 * equivalent objects produce identical strings — required for content-
 * addressing to be insensitive to LLM key-ordering quirks.
 */
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
 * Hash an audit row's content-addressed id.
 *
 * id = SHA-256(prompt_hash + tool_calls_json + final_hash)
 *
 * Note: the user_id and ts are deliberately NOT in the hash — the same
 * conversational turn replayed by a different user, or on a different day,
 * still represents the same logical input → output mapping.
 */
export function hashAuditId(input: AuditInput): string {
  const prompt_hash = sha256(input.prompt);
  const tool_calls_json = canonicalJson(input.tool_calls);
  const final_hash = sha256(input.final);
  return sha256(prompt_hash + tool_calls_json + final_hash);
}

function rowToAudit(row: Record<string, unknown>): AuditRow {
  return {
    id: String(row.id),
    ts: String(row.ts),
    user_id: String(row.user_id),
    prompt_hash: String(row.prompt_hash),
    tool_calls_json: String(row.tool_calls_json),
    final_hash: String(row.final_hash),
  };
}

/**
 * Append an audit row. Idempotent on (prompt, tool_calls, final): the
 * content-addressed primary key + ``INSERT ... ON CONFLICT DO NOTHING``
 * makes duplicate calls a no-op rather than an error.
 *
 * Returns the row that NOW exists in the table — either the freshly inserted
 * one, or the previously stored row if this was a duplicate. Either way the
 * returned id is correct for downstream linking.
 */
export async function appendAuditRow(input: AuditInput): Promise<AuditRow> {
  const id = hashAuditId(input);
  const prompt_hash = sha256(input.prompt);
  const tool_calls_json = canonicalJson(input.tool_calls);
  const final_hash = sha256(input.final);
  const ts = new Date().toISOString();

  await db.execute({
    sql:
      'INSERT INTO chat_audit (id, ts, user_id, prompt_hash, tool_calls_json, final_hash) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO NOTHING',
    args: [id, ts, input.user_id, prompt_hash, tool_calls_json, final_hash],
  });

  // Re-read so the returned row reflects the persisted ts (idempotent path
  // keeps the original ts rather than overwriting it with the retry's clock).
  const stored = await getAuditRow(id);
  if (stored) return stored;
  return { id, ts, user_id: input.user_id, prompt_hash, tool_calls_json, final_hash };
}

export async function listAuditRows(filter: AuditListFilter = {}): Promise<AuditRow[]> {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.user_id !== undefined) {
    where.push('user_id = ?');
    args.push(filter.user_id);
  }
  let sql =
    'SELECT id, ts, user_id, prompt_hash, tool_calls_json, final_hash FROM chat_audit';
  if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY ts DESC';
  if (filter.limit !== undefined && filter.limit > 0) {
    sql += ' LIMIT ?';
    args.push(filter.limit);
  }

  const r = await db.execute({ sql, args });
  return r.rows.map((row) => rowToAudit(row as unknown as Record<string, unknown>));
}

export async function getAuditRow(id: string): Promise<AuditRow | null> {
  const r = await db.execute({
    sql: 'SELECT id, ts, user_id, prompt_hash, tool_calls_json, final_hash FROM chat_audit WHERE id = ? LIMIT 1',
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return rowToAudit(r.rows[0] as unknown as Record<string, unknown>);
}
