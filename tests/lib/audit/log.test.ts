// @vitest-environment node
/**
 * Task P2.36 — Content-addressed chat audit log.
 *
 * Each row's primary key is a SHA-256 hash of (prompt_hash + tool_calls_json +
 * final_hash), so inserting the same conversational turn twice is idempotent
 * (UPSERT). The audit captures the SHAPE of a turn — user prompt, sequence of
 * tool calls (name + args, NOT results), and the final assistant message — so
 * a future reviewer can verify "did this turn produce that output?" without
 * the table itself growing with sensitive tool RESULT content.
 *
 * These tests exercise the real libSQL client (matching the pattern in
 * ``tests/lib/db/pins.test.ts``). The ``chat_audit`` table is created in
 * ``beforeAll`` and DELETE'd between cases.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { db } from '@/lib/db/client';
import {
  type AuditInput,
  appendAuditRow,
  getAuditRow,
  hashAuditId,
  listAuditRows,
} from '@/lib/audit/log';

beforeAll(async () => {
  // Mirror the migration in ``lib/db/schema.sql`` so the test runs without a
  // separate ``npm run migrate``.
  await db.execute(
    'CREATE TABLE IF NOT EXISTS chat_audit (id TEXT PRIMARY KEY, ts TEXT NOT NULL, user_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, tool_calls_json TEXT NOT NULL, final_hash TEXT NOT NULL)',
  );
});

beforeEach(async () => {
  await db.execute('DELETE FROM chat_audit');
});

afterEach(async () => {
  await db.execute('DELETE FROM chat_audit');
});

function input(over: Partial<AuditInput> = {}): AuditInput {
  return {
    user_id: 'demo_user',
    prompt: 'TIV in 330?',
    tool_calls: [
      { name: 'query_book_exposure', args: { zip3_list: ['330'] } },
    ],
    final: 'FL ZIP3 330 has $109M TIV across 342 policies.',
    ...over,
  };
}

describe('lib/audit/log — content-addressed chat audit', () => {
  test('hashAuditId is deterministic for identical input', () => {
    const a = hashAuditId(input());
    const b = hashAuditId(input());
    expect(a).toBe(b);
    // SHA-256 hex is 64 chars.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hashAuditId changes when prompt changes', () => {
    const a = hashAuditId(input({ prompt: 'first' }));
    const b = hashAuditId(input({ prompt: 'second' }));
    expect(a).not.toBe(b);
  });

  test('appendAuditRow round-trips through getAuditRow', async () => {
    const row = await appendAuditRow(input());
    expect(row.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row.user_id).toBe('demo_user');
    expect(typeof row.ts).toBe('string');
    expect(new Date(row.ts).toString()).not.toBe('Invalid Date');
    expect(row.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.final_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tool_calls_json).toContain('query_book_exposure');

    const fetched = await getAuditRow(row.id);
    expect(fetched).toEqual(row);

    const missing = await getAuditRow('0'.repeat(64));
    expect(missing).toBeNull();
  });

  test('appendAuditRow is idempotent (same inputs → same id, no duplicate rows)', async () => {
    const first = await appendAuditRow(input());
    const second = await appendAuditRow(input());
    expect(first.id).toBe(second.id);
    const rows = await listAuditRows();
    expect(rows.length).toBe(1);
  });

  test('listAuditRows filters by user_id', async () => {
    await appendAuditRow(input({ user_id: 'alice', prompt: 'a' }));
    await appendAuditRow(input({ user_id: 'alice', prompt: 'b' }));
    await appendAuditRow(input({ user_id: 'bob', prompt: 'c' }));

    const aliceRows = await listAuditRows({ user_id: 'alice' });
    expect(aliceRows.length).toBe(2);
    expect(aliceRows.every((r) => r.user_id === 'alice')).toBe(true);

    const bobRows = await listAuditRows({ user_id: 'bob' });
    expect(bobRows.length).toBe(1);
    expect(bobRows[0].user_id).toBe('bob');
  });

  test('listAuditRows applies the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditRow(input({ prompt: `prompt-${i}` }));
    }
    const capped = await listAuditRows({ limit: 2 });
    expect(capped.length).toBe(2);
  });

  test('tool_calls_json is canonical — different key order produces same id', () => {
    const a = hashAuditId({
      user_id: 'demo_user',
      prompt: 'p',
      tool_calls: [{ name: 'foo', args: { zip3_list: ['330'], state: 'FL' } }],
      final: 'f',
    });
    const b = hashAuditId({
      user_id: 'demo_user',
      prompt: 'p',
      tool_calls: [{ name: 'foo', args: { state: 'FL', zip3_list: ['330'] } }],
      final: 'f',
    });
    expect(a).toBe(b);
  });

  test('empty tool_calls array is valid and still inserts a row', async () => {
    const row = await appendAuditRow(
      input({ tool_calls: [], final: 'no tools used here.' }),
    );
    expect(row.tool_calls_json).toBe('[]');
    const fetched = await getAuditRow(row.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.tool_calls_json).toBe('[]');
  });
});
