// @vitest-environment node
/**
 * Task P2.26 — POST /api/claims/push.
 *
 * Phase 2 behavior: the route validates a `{policy_ids: number[]}` body and
 * logs the push (count + sample IDs) to ``console.log``. It does NOT
 * persist to the DB — Phase 3 will swap the log for a write to a
 * ``decisions`` table. The response is ``200 { received: N, ids_preview:
 * number[] }``.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { POST } from '@/app/api/claims/push/route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/claims/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silence stdout while spying so test output stays readable.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.clearAllMocks();
});

describe('POST /api/claims/push', () => {
  test('happy path: {policy_ids: [1,2,3]} → 200 with received count + preview', async () => {
    const r = await POST(req({ policy_ids: [1, 2, 3] }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.received).toBe(3);
    expect(Array.isArray(body.ids_preview)).toBe(true);
    expect(body.ids_preview).toEqual([1, 2, 3]);
  });

  test('preview slice caps at 5 even when the payload is larger', async () => {
    const ids = [10, 20, 30, 40, 50, 60, 70];
    const r = await POST(req({ policy_ids: ids }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.received).toBe(7);
    expect(body.ids_preview).toEqual([10, 20, 30, 40, 50]);
  });

  test('logs a single structured line per push (count + sample IDs)', async () => {
    const r = await POST(req({ policy_ids: [101, 202, 303] }));
    expect(r.status).toBe(200);
    expect(logSpy).toHaveBeenCalled();
    // Find at least one call whose first argument is a string containing
    // the push payload. The route may log additional context but must
    // log the count + a few IDs.
    const lines = logSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((a: unknown): a is string => typeof a === 'string');
    expect(lines.length).toBeGreaterThan(0);
    const combined = lines.join('\n');
    expect(combined).toContain('claims_push');
    expect(combined).toMatch(/101|202|303/);
  });

  test('400 on missing policy_ids', async () => {
    const r = await POST(req({}));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(typeof body.error).toBe('string');
  });

  test('400 on non-array policy_ids', async () => {
    const r = await POST(req({ policy_ids: 'not-an-array' }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(typeof body.error).toBe('string');
  });

  test('400 on empty array', async () => {
    const r = await POST(req({ policy_ids: [] }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(typeof body.error).toBe('string');
  });

  test('400 on non-integer policy_id values', async () => {
    const r = await POST(req({ policy_ids: [1, 2.5, 3] }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(typeof body.error).toBe('string');
  });

  test('400 on negative policy_id values', async () => {
    const r = await POST(req({ policy_ids: [1, -2, 3] }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(typeof body.error).toBe('string');
  });

  test('400 on non-numeric policy_id entries', async () => {
    const r = await POST(req({ policy_ids: [1, 'two', 3] }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(typeof body.error).toBe('string');
  });

  test('400 on invalid JSON body', async () => {
    const bad = new Request('http://localhost/api/claims/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const r = await POST(bad);
    expect(r.status).toBe(400);
  });
});
