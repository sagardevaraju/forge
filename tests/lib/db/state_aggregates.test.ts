// @vitest-environment node
/**
 * Task P3.23 — Per-state portfolio aggregates.
 *
 * Verifies state-level TIV / premium / count aggregation from the
 * policies table. Inserts a few rows, asserts the aggregation, then
 * cleans up via unsafeExecute.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { unsafeExecute } from '@/lib/db/client';
import { stateAggregates } from '@/lib/db/state_aggregates';

beforeAll(async () => {
  // Mirror the real schema (lib/db/schema.sql) so the test works
  // against an already-migrated dev DB without conflict.
  await unsafeExecute(`
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      zip3 TEXT NOT NULL,
      county TEXT,
      lat REAL, lon REAL,
      tiv REAL NOT NULL,
      build_year INTEGER,
      build_type TEXT,
      flood_zone TEXT,
      elevation_m REAL,
      premium_annual REAL,
      cv_features TEXT,
      synthetic INTEGER NOT NULL DEFAULT 1,
      lineage TEXT
    )
  `);
});

// Use very high IDs to avoid collision with seed data in the dev DB.
const TEST_ID_BASE = 9_900_000;

beforeEach(async () => {
  await unsafeExecute(
    `DELETE FROM policies WHERE id >= ${TEST_ID_BASE}`,
  );
});

afterEach(async () => {
  await unsafeExecute(
    `DELETE FROM policies WHERE id >= ${TEST_ID_BASE}`,
  );
});

async function insertPolicy(
  idOffset: number,
  state: string,
  tiv: number,
  premium: number,
): Promise<void> {
  await unsafeExecute({
    sql: `INSERT INTO policies (id, state, zip3, tiv, premium_annual)
          VALUES (?, ?, ?, ?, ?)`,
    args: [TEST_ID_BASE + idOffset, state, '999', tiv, premium],
  });
}

// Filter out seed data from assertions so the test passes whether or
// not the dev DB is seeded with the 10k-policy book.
const TEST_STATES = new Set(['XF', 'XT', 'XL']);  // fake codes nobody seeds

async function insertTestPolicy(
  idOffset: number,
  state: string,
  tiv: number,
  premium: number,
): Promise<void> {
  await insertPolicy(idOffset, state, tiv, premium);
}

function filterTest(rows: Array<{ iso_code: string }>): Array<{ iso_code: string }> {
  return rows.filter((r) => TEST_STATES.has(r.iso_code));
}

describe('stateAggregates', () => {
  test('aggregates TIV / premium / count by state', async () => {
    await insertTestPolicy(1, 'XF', 500_000, 5_000);
    await insertTestPolicy(2, 'XF', 300_000, 3_000);
    await insertTestPolicy(3, 'XT', 800_000, 7_500);
    const rows = await stateAggregates();
    const test = filterTest(rows);
    expect(test).toHaveLength(2);
    const fl = rows.find((r) => r.iso_code === 'XF')!;
    const tx = rows.find((r) => r.iso_code === 'XT')!;
    expect(fl.total_tiv).toBe(800_000);
    expect(fl.total_premium).toBe(8_000);
    expect(fl.policy_count).toBe(2);
    expect(tx.total_tiv).toBe(800_000);
    expect(tx.policy_count).toBe(1);
  });

  test('normalises iso_code to uppercase', async () => {
    await insertTestPolicy(1, 'xl', 1, 1);
    const rows = await stateAggregates();
    expect(rows.some((r) => r.iso_code === 'XL')).toBe(true);
  });

  test('drops rows with empty state', async () => {
    // SQLite NOT NULL rejects nulls but allows empty strings — the
    // aggregate query filters them explicitly.
    await unsafeExecute({
      sql: `INSERT INTO policies (id, state, zip3, tiv)
            VALUES (?, ?, ?, ?)`,
      args: [TEST_ID_BASE + 99, '', '999', 100],
    });
    const rows = await stateAggregates();
    expect(rows.some((r) => r.iso_code === '')).toBe(false);
  });
});
