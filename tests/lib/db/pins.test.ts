// @vitest-environment node
/**
 * Task P2.33 — Operator pin DB layer.
 *
 * Pins are stored in the local libSQL file (or remote Turso) keyed on
 * ``policy_id``. The table is created/cleared by the test setup so each case
 * starts from a known baseline — this matches the cohort-test pattern of
 * exercising the real client rather than mocking it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { db } from '@/lib/db/client';
import {
  type Pin,
  deletePin,
  getPin,
  listPins,
  setPin,
} from '@/lib/db/pins';

beforeAll(async () => {
  // Ensure the pins table exists. Mirrors the migration in lib/db/schema.sql.
  await db.execute(
    'CREATE TABLE IF NOT EXISTS pins (policy_id INTEGER NOT NULL, action TEXT NOT NULL, operator TEXT NOT NULL, ts TEXT NOT NULL, rationale TEXT NOT NULL, PRIMARY KEY (policy_id))',
  );
});

beforeEach(async () => {
  await db.execute('DELETE FROM pins');
});

afterEach(async () => {
  await db.execute('DELETE FROM pins');
});

describe('pins DB layer', () => {
  test('setPin then getPin returns the round-tripped pin', async () => {
    const created = await setPin({
      policy_id: 1001,
      action: 'reprice_p10',
      operator: 'demo_operator',
      rationale: 'manual override — exposure too high in 330',
    });
    expect(created.policy_id).toBe(1001);
    expect(created.action).toBe('reprice_p10');
    expect(created.operator).toBe('demo_operator');
    expect(created.rationale).toMatch(/exposure too high/);
    // ts is server-assigned and is a non-empty ISO-8601 string.
    expect(typeof created.ts).toBe('string');
    expect(created.ts.length).toBeGreaterThan(0);
    expect(new Date(created.ts).toString()).not.toBe('Invalid Date');

    const fetched = await getPin(1001);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(created);

    const missing = await getPin(9999);
    expect(missing).toBeNull();
  });

  test('listPins returns every row', async () => {
    await setPin({
      policy_id: 1,
      action: 'retain',
      operator: 'a',
      rationale: 'keep this policy on the book',
    });
    await setPin({
      policy_id: 2,
      action: 'non_renew',
      operator: 'b',
      rationale: 'cohort exit confirmed by underwriting',
    });

    const all = await listPins();
    const ids = all.map((p: Pin) => p.policy_id).sort((x, y) => x - y);
    expect(ids).toEqual([1, 2]);
  });

  test('setPin twice on the same policy_id upserts (no duplicates)', async () => {
    await setPin({
      policy_id: 42,
      action: 'retain',
      operator: 'alice',
      rationale: 'initial decision — keep',
    });
    const updated = await setPin({
      policy_id: 42,
      action: 'reprice_p15',
      operator: 'bob',
      rationale: 'updated — bump price 15%',
    });

    const all = await listPins();
    expect(all).toHaveLength(1);
    expect(updated.action).toBe('reprice_p15');
    expect(updated.operator).toBe('bob');
    expect(updated.rationale).toMatch(/bump price 15%/);
  });

  test('deletePin removes the row', async () => {
    await setPin({
      policy_id: 7,
      action: 'cede_qs',
      operator: 'op',
      rationale: 'quota share cession for hurricane exposure',
    });
    expect(await getPin(7)).not.toBeNull();

    await deletePin(7);
    expect(await getPin(7)).toBeNull();
    expect(await listPins()).toHaveLength(0);
  });

  test('setPin rejects an action that is not in ACTIONS', async () => {
    await expect(
      setPin({
        policy_id: 1,
        // @ts-expect-error — intentionally invalid action
        action: 'not_a_real_action',
        operator: 'demo_operator',
        rationale: 'this should never persist anywhere',
      }),
    ).rejects.toThrow(/action/i);
    expect(await listPins()).toHaveLength(0);
  });
});
