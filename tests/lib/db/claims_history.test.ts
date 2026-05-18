// @vitest-environment node
/**
 * Task P2.29 — Claims history DB layer.
 *
 * The /claims page persists each render's severity snapshot to a single-row-
 * per-policy table (last write wins). The next render compares the current
 * snapshot to the prior one to surface ↑/↓/= on the table. This suite covers
 * the DB helpers — the diff math lives in the component test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { db } from '@/lib/db/client';
import {
  loadPrevSeverities,
  upsertSnapshot,
} from '@/lib/db/claims_history';

beforeAll(async () => {
  // Ensure the table exists. Mirrors the migration in lib/db/schema.sql.
  await db.execute(
    'CREATE TABLE IF NOT EXISTS claims_history (policy_id INTEGER PRIMARY KEY, severity REAL NOT NULL, snapshot_ts TEXT NOT NULL)',
  );
});

beforeEach(async () => {
  await db.execute('DELETE FROM claims_history');
});

afterEach(async () => {
  await db.execute('DELETE FROM claims_history');
});

describe('claims_history DB layer', () => {
  test('loadPrevSeverities returns empty map for fresh DB', async () => {
    const prev = await loadPrevSeverities();
    expect(prev).toBeInstanceOf(Map);
    expect(prev.size).toBe(0);
  });

  test('upsertSnapshot inserts on first call, updates on second', async () => {
    await upsertSnapshot([
      { policy_id: 1, severity: 100_000 },
      { policy_id: 2, severity: 250_000 },
    ]);

    const first = await loadPrevSeverities();
    expect(first.size).toBe(2);
    expect(first.get(1)).toBe(100_000);
    expect(first.get(2)).toBe(250_000);

    // Second call updates policy 1 and adds policy 3.
    await upsertSnapshot([
      { policy_id: 1, severity: 175_000 },
      { policy_id: 3, severity: 90_000 },
    ]);

    const second = await loadPrevSeverities();
    // policy 1 updated; policy 2 from the first call still present (last write
    // wins is per-policy, not per-batch — that's the documented semantic).
    expect(second.size).toBe(3);
    expect(second.get(1)).toBe(175_000);
    expect(second.get(2)).toBe(250_000);
    expect(second.get(3)).toBe(90_000);
  });

  test('loadPrevSeverities returns the upserted values', async () => {
    await upsertSnapshot([
      { policy_id: 10, severity: 12_345 },
      { policy_id: 11, severity: 0 },
    ]);
    const prev = await loadPrevSeverities();
    expect(prev.get(10)).toBe(12_345);
    // Zero is a valid stored severity (cohort missing → table renders "—",
    // but the prior could legitimately be 0). Don't coerce away.
    expect(prev.get(11)).toBe(0);
  });

  test('upsertSnapshot with empty array is a no-op', async () => {
    await upsertSnapshot([]);
    const prev = await loadPrevSeverities();
    expect(prev.size).toBe(0);
  });
});
