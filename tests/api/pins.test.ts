// @vitest-environment node
/**
 * Task P2.33 — POST / GET / DELETE /api/pins.
 *
 * Mocks the DB-layer module so the route can be exercised without touching
 * libSQL. The mocks expose simple in-memory implementations of listPins,
 * getPin, setPin, deletePin; the route under test only depends on these.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const store = new Map<number, {
  policy_id: number;
  action: string;
  operator: string;
  ts: string;
  rationale: string;
}>();

vi.mock('@/lib/db/pins', () => ({
  listPins: vi.fn(async () => Array.from(store.values())),
  getPin: vi.fn(async (policyId: number) => store.get(policyId) ?? null),
  setPin: vi.fn(async (pin: {
    policy_id: number;
    action: string;
    operator: string;
    rationale: string;
  }) => {
    const ACTIONS = new Set([
      'retain',
      'reprice_n20',
      'reprice_n10',
      'reprice_0',
      'reprice_p5',
      'reprice_p10',
      'reprice_p15',
      'reprice_p20',
      'non_renew',
      'cede_qs',
      'cede_xs',
    ]);
    if (!ACTIONS.has(pin.action)) {
      throw new Error(`invalid action: ${pin.action}`);
    }
    const row = { ...pin, ts: new Date('2026-05-17T00:00:00Z').toISOString() };
    store.set(pin.policy_id, row);
    return row;
  }),
  deletePin: vi.fn(async (policyId: number) => {
    store.delete(policyId);
  }),
}));

// Mock the cohort-membership helper used by GET ?cohort_id=X. The route
// resolves a cohort_id to the set of policy IDs it contains via this helper
// (rather than hammering the DB inside the route).
vi.mock('@/lib/db/policy_cohort_map', () => ({
  loadPolicyToCohortMap: vi.fn(async () => ({
    1: '330_wood_frame_q3',
    2: '330_wood_frame_q3',
    3: '340_masonry_q1',
  })),
}));

import { DELETE, GET, POST } from '@/app/api/pins/route';

function req(method: string, body?: unknown, search = ''): Request {
  return new Request(`http://localhost/api/pins${search}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  store.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/pins', () => {
  test('creates a pin and echoes the persisted row', async () => {
    const r = await POST(
      req('POST', {
        policy_id: 100,
        action: 'reprice_p10',
        operator: 'demo_operator',
        rationale: 'manual override — exposure too high in 330',
      }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.policy_id).toBe(100);
    expect(body.action).toBe('reprice_p10');
    expect(body.operator).toBe('demo_operator');
    expect(typeof body.ts).toBe('string');
    expect(store.size).toBe(1);
  });

  test('rejects an invalid action with 400', async () => {
    const r = await POST(
      req('POST', {
        policy_id: 1,
        action: 'not_a_real_action',
        operator: 'demo_operator',
        rationale: 'attempting to write an invalid action',
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/action/i);
    expect(store.size).toBe(0);
  });

  test('rejects empty operator with 400', async () => {
    const r = await POST(
      req('POST', {
        policy_id: 1,
        action: 'retain',
        operator: '',
        rationale: 'some plausible rationale text',
      }),
    );
    expect(r.status).toBe(400);
  });

  test('rejects short rationale with 400', async () => {
    const r = await POST(
      req('POST', {
        policy_id: 1,
        action: 'retain',
        operator: 'demo_operator',
        rationale: 'too short',
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/rationale/i);
  });
});

describe('GET /api/pins', () => {
  test('returns every pin when no cohort_id filter is supplied', async () => {
    await POST(
      req('POST', {
        policy_id: 1,
        action: 'retain',
        operator: 'op',
        rationale: 'first pin for the suite',
      }),
    );
    await POST(
      req('POST', {
        policy_id: 3,
        action: 'reprice_p10',
        operator: 'op',
        rationale: 'second pin different cohort',
      }),
    );
    const r = await GET(req('GET'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.pins)).toBe(true);
    expect(body.pins.length).toBe(2);
  });

  test('filters by cohort_id when supplied', async () => {
    await POST(
      req('POST', {
        policy_id: 1,
        action: 'retain',
        operator: 'op',
        rationale: 'pin in 330 cohort first',
      }),
    );
    await POST(
      req('POST', {
        policy_id: 2,
        action: 'retain',
        operator: 'op',
        rationale: 'pin in 330 cohort second',
      }),
    );
    await POST(
      req('POST', {
        policy_id: 3,
        action: 'reprice_p10',
        operator: 'op',
        rationale: 'pin in 340 cohort',
      }),
    );
    const r = await GET(req('GET', undefined, '?cohort_id=330_wood_frame_q3'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.pins.map((p: { policy_id: number }) => p.policy_id).sort()).toEqual([1, 2]);
  });
});

describe('DELETE /api/pins', () => {
  test('removes the pin', async () => {
    await POST(
      req('POST', {
        policy_id: 99,
        action: 'retain',
        operator: 'op',
        rationale: 'pin we are about to delete',
      }),
    );
    expect(store.size).toBe(1);

    const r = await DELETE(req('DELETE', undefined, '?policy_id=99'));
    expect(r.status).toBe(200);
    expect(store.size).toBe(0);
  });

  test('400 when policy_id missing', async () => {
    const r = await DELETE(req('DELETE'));
    expect(r.status).toBe(400);
  });
});
