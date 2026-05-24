// @vitest-environment node
/**
 * Task P3.7 — App-layer WORM (write-once, read-many) on audit tables.
 *
 * The audit ledger (`decisions`, P3.4) and the chat audit log (`chat_audit`,
 * P2.36) must be immutable in the regulator-visible sense. SQLite/libSQL
 * doesn't ship row-level WORM, so this is **defense in depth** at the
 * application layer: every `db.execute` / `db.batch` call goes through a
 * SQL prefix check that throws `WormViolationError` on a forbidden
 * mutation.
 *
 * Column-level WORM (not blanket "deny UPDATE"):
 *   The lifecycle columns on `decisions` — `notices_sent_at`, `executed_at`,
 *   `reversed_at`, `reversed_by` — are meant to mutate (notice-sending
 *   pipeline writes notices_sent_at; rollback writes reversed_*). A blanket
 *   "deny UPDATE on decisions" rule would break P3.4's `markNoticesSent`
 *   and P3.6's rollback. So WORM here is column-scoped: lifecycle columns
 *   are mutable, everything else (id, solve_ts, operator, inputs_*,
 *   outputs_*) is not.
 *
 * `chat_audit` has no lifecycle — all columns are immutable; UPDATE is
 * denied outright.
 *
 * DELETE on either table is always blocked.
 *
 * Out-of-WORM tables (policies, simulations, pins, etc.) pass through
 * unmodified — WORM scope is intentionally narrow.
 *
 * `unsafeExecute` is the documented bypass for migration scripts and test
 * teardown. The intent is loud at the call site: only privileged code
 * paths call it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  WormViolationError,
  assertWormSafe,
  db,
  unsafeExecute,
} from '@/lib/db/client';

beforeAll(async () => {
  // The WORM guard needs to inspect SQL but doesn't depend on table
  // existence to throw; we only need the tables to verify pass-through
  // INSERT/SELECT/lifecycle-UPDATE paths actually persist.
  await unsafeExecute(
    'CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, solve_ts TEXT NOT NULL, operator TEXT NOT NULL, inputs_hash TEXT NOT NULL, inputs_json TEXT NOT NULL, outputs_hash TEXT NOT NULL, outputs_json TEXT NOT NULL, executed_at TEXT, reversed_at TEXT, reversed_by TEXT, notices_sent_at TEXT)',
  );
  await unsafeExecute(
    'CREATE TABLE IF NOT EXISTS chat_audit (id TEXT PRIMARY KEY, ts TEXT NOT NULL, user_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, tool_calls_json TEXT NOT NULL, final_hash TEXT NOT NULL)',
  );
  // Out-of-WORM table — proves the guard is scoped to audit tables only.
  await unsafeExecute(
    'CREATE TABLE IF NOT EXISTS worm_test_other (id TEXT PRIMARY KEY, val TEXT)',
  );
});

beforeEach(async () => {
  // Cleanup uses unsafeExecute because the regular `db.execute('DELETE …')`
  // is exactly what WORM blocks. That's the whole point.
  await unsafeExecute('DELETE FROM decisions');
  await unsafeExecute('DELETE FROM chat_audit');
  await unsafeExecute('DELETE FROM worm_test_other');
});

afterEach(async () => {
  await unsafeExecute('DELETE FROM decisions');
  await unsafeExecute('DELETE FROM chat_audit');
  await unsafeExecute('DELETE FROM worm_test_other');
});

// ────────────────────────────────────────────────────────────────────────
// Pure-function tests — assertWormSafe should be inspectable without DB.
// ────────────────────────────────────────────────────────────────────────

describe('assertWormSafe — SELECT and INSERT are always allowed', () => {
  test('SELECT on decisions passes', () => {
    expect(() => assertWormSafe('SELECT * FROM decisions')).not.toThrow();
    expect(() => assertWormSafe('SELECT id, solve_ts FROM decisions WHERE operator = ?')).not.toThrow();
  });

  test('SELECT on chat_audit passes', () => {
    expect(() => assertWormSafe('SELECT * FROM chat_audit ORDER BY ts DESC LIMIT 50')).not.toThrow();
  });

  test('INSERT on decisions passes', () => {
    expect(() =>
      assertWormSafe(
        'INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
    ).not.toThrow();
  });

  test('INSERT ... ON CONFLICT DO NOTHING is allowed (idempotent ledger insert)', () => {
    expect(() =>
      assertWormSafe(
        'INSERT INTO decisions (id) VALUES (?) ON CONFLICT(id) DO NOTHING',
      ),
    ).not.toThrow();
  });
});

describe('assertWormSafe — UPDATE on decisions is column-scoped', () => {
  test('UPDATE setting notices_sent_at is allowed', () => {
    expect(() =>
      assertWormSafe('UPDATE decisions SET notices_sent_at = ? WHERE id = ?'),
    ).not.toThrow();
  });

  test('UPDATE setting executed_at is allowed', () => {
    expect(() =>
      assertWormSafe('UPDATE decisions SET executed_at = ? WHERE id = ?'),
    ).not.toThrow();
  });

  test('UPDATE setting reversed_at + reversed_by together is allowed', () => {
    expect(() =>
      assertWormSafe(
        'UPDATE decisions SET reversed_at = ?, reversed_by = ? WHERE id = ?',
      ),
    ).not.toThrow();
  });

  test('UPDATE setting inputs_hash is BLOCKED', () => {
    expect(() =>
      assertWormSafe('UPDATE decisions SET inputs_hash = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
  });

  test('UPDATE setting outputs_json is BLOCKED', () => {
    expect(() =>
      assertWormSafe('UPDATE decisions SET outputs_json = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
  });

  test('UPDATE setting operator is BLOCKED', () => {
    expect(() =>
      assertWormSafe('UPDATE decisions SET operator = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
  });

  test('UPDATE setting id is BLOCKED', () => {
    expect(() =>
      assertWormSafe('UPDATE decisions SET id = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
  });

  test('mixed lifecycle + content columns is BLOCKED (any disallowed col in SET clause)', () => {
    expect(() =>
      assertWormSafe(
        'UPDATE decisions SET notices_sent_at = ?, inputs_hash = ? WHERE id = ?',
      ),
    ).toThrow(WormViolationError);
  });

  test('case-insensitive — UPPER-CASE UPDATE is blocked on content cols', () => {
    expect(() =>
      assertWormSafe('UPDATE DECISIONS SET INPUTS_HASH = ? WHERE ID = ?'),
    ).toThrow(WormViolationError);
  });

  test('handles expression RHS with commas (COALESCE) on lifecycle col', () => {
    // SET notices_sent_at = COALESCE(?, notices_sent_at) — the COALESCE
    // argument list contains a comma which a naive split-on-comma would
    // misparse as two assignments. The parser must respect parens.
    expect(() =>
      assertWormSafe(
        'UPDATE decisions SET notices_sent_at = COALESCE(?, notices_sent_at) WHERE id = ?',
      ),
    ).not.toThrow();
  });
});

describe('assertWormSafe — chat_audit is strictly append-only', () => {
  test('any UPDATE on chat_audit is BLOCKED, even on ts', () => {
    expect(() =>
      assertWormSafe('UPDATE chat_audit SET ts = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
    expect(() =>
      assertWormSafe('UPDATE chat_audit SET final_hash = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
  });
});

describe('assertWormSafe — DELETE on audit tables is always blocked', () => {
  test('DELETE FROM decisions is BLOCKED', () => {
    expect(() => assertWormSafe('DELETE FROM decisions')).toThrow(WormViolationError);
    expect(() => assertWormSafe('DELETE FROM decisions WHERE id = ?')).toThrow(WormViolationError);
  });

  test('DELETE FROM chat_audit is BLOCKED', () => {
    expect(() => assertWormSafe('DELETE FROM chat_audit')).toThrow(WormViolationError);
    expect(() => assertWormSafe('DELETE FROM chat_audit WHERE ts < ?')).toThrow(WormViolationError);
  });
});

describe('assertWormSafe — out-of-WORM tables pass through', () => {
  test('UPDATE on policies allowed', () => {
    expect(() =>
      assertWormSafe('UPDATE policies SET cv_features = ? WHERE id = ?'),
    ).not.toThrow();
  });

  test('UPDATE on simulations allowed', () => {
    expect(() =>
      assertWormSafe('UPDATE simulations SET retired = 1, retired_at = ? WHERE id = ?'),
    ).not.toThrow();
  });

  test('DELETE on pins allowed', () => {
    expect(() =>
      assertWormSafe('DELETE FROM pins WHERE id = ?'),
    ).not.toThrow();
  });

  test('UPDATE on a worm_test_other table allowed', () => {
    expect(() =>
      assertWormSafe('UPDATE worm_test_other SET val = ?'),
    ).not.toThrow();
  });
});

describe('assertWormSafe — quoted identifiers and leading whitespace', () => {
  test('leading whitespace + newlines tolerated', () => {
    expect(() =>
      assertWormSafe('\n   UPDATE decisions SET notices_sent_at = ? WHERE id = ?\n'),
    ).not.toThrow();
  });

  test('backtick-quoted table name on decisions still parsed', () => {
    expect(() =>
      assertWormSafe('UPDATE `decisions` SET inputs_hash = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
  });

  test('backtick-quoted column name on a content col still blocked', () => {
    expect(() =>
      assertWormSafe('UPDATE decisions SET `inputs_hash` = ? WHERE id = ?'),
    ).toThrow(WormViolationError);
  });
});

// ────────────────────────────────────────────────────────────────────────
// db.execute / db.batch live-DB tests.
// ────────────────────────────────────────────────────────────────────────

describe('db.execute — WORM guard on the wrapper', () => {
  test('INSERT into decisions via db.execute persists a row', async () => {
    await db.execute({
      sql:
        'INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: ['0'.repeat(64), '2026-01-01T00:00:00Z', 'alice', 'a', '{}', 'b', '{}'],
    });
    const r = await db.execute('SELECT COUNT(*) as n FROM decisions');
    expect(Number(r.rows[0].n)).toBe(1);
  });

  test('UPDATE lifecycle column via db.execute persists', async () => {
    await db.execute({
      sql:
        'INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: ['1'.repeat(64), '2026-01-01T00:00:00Z', 'alice', 'a', '{}', 'b', '{}'],
    });
    await db.execute({
      sql: 'UPDATE decisions SET notices_sent_at = ? WHERE id = ?',
      args: ['2026-01-02T00:00:00Z', '1'.repeat(64)],
    });
    const r = await db.execute({
      sql: 'SELECT notices_sent_at FROM decisions WHERE id = ?',
      args: ['1'.repeat(64)],
    });
    expect(r.rows[0].notices_sent_at).toBe('2026-01-02T00:00:00Z');
  });

  test('UPDATE content column via db.execute throws WormViolationError', async () => {
    await expect(
      db.execute({
        sql: 'UPDATE decisions SET inputs_hash = ? WHERE id = ?',
        args: ['malicious', '1'.repeat(64)],
      }),
    ).rejects.toThrow(WormViolationError);
  });

  test('DELETE FROM decisions via db.execute throws WormViolationError', async () => {
    await expect(db.execute('DELETE FROM decisions')).rejects.toThrow(
      WormViolationError,
    );
  });

  test('UPDATE on chat_audit via db.execute throws WormViolationError', async () => {
    await expect(
      db.execute('UPDATE chat_audit SET final_hash = ? WHERE id = ?'),
    ).rejects.toThrow(WormViolationError);
  });
});

describe('db.batch — WORM guard on every statement in the batch', () => {
  test('batch with one forbidden mutation throws before any statement runs', async () => {
    await expect(
      db.batch([
        {
          sql:
            'INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: ['2'.repeat(64), '2026-01-01T00:00:00Z', 'alice', 'a', '{}', 'b', '{}'],
        },
        { sql: 'DELETE FROM decisions WHERE id = ?', args: ['2'.repeat(64)] },
      ]),
    ).rejects.toThrow(WormViolationError);
    // The pre-flight check should bail before the INSERT lands.
    const r = await db.execute('SELECT COUNT(*) as n FROM decisions');
    expect(Number(r.rows[0].n)).toBe(0);
  });

  test('batch of allowed statements (INSERT + lifecycle UPDATE) succeeds', async () => {
    await db.batch([
      {
        sql:
          'INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: ['3'.repeat(64), '2026-01-01T00:00:00Z', 'alice', 'a', '{}', 'b', '{}'],
      },
      {
        sql: 'UPDATE decisions SET notices_sent_at = ? WHERE id = ?',
        args: ['2026-01-02T00:00:00Z', '3'.repeat(64)],
      },
    ]);
    const r = await db.execute({
      sql: 'SELECT notices_sent_at FROM decisions WHERE id = ?',
      args: ['3'.repeat(64)],
    });
    expect(r.rows[0].notices_sent_at).toBe('2026-01-02T00:00:00Z');
  });
});

describe('unsafeExecute — bypass for migrations + test teardown', () => {
  test('unsafeExecute can DELETE from decisions (this is what teardown uses)', async () => {
    await db.execute({
      sql:
        'INSERT INTO decisions (id, solve_ts, operator, inputs_hash, inputs_json, outputs_hash, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: ['4'.repeat(64), '2026-01-01T00:00:00Z', 'alice', 'a', '{}', 'b', '{}'],
    });
    // The legitimate teardown path.
    await unsafeExecute('DELETE FROM decisions');
    const r = await db.execute('SELECT COUNT(*) as n FROM decisions');
    expect(Number(r.rows[0].n)).toBe(0);
  });
});
