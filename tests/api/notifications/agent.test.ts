// @vitest-environment node
/**
 * Task P2.34 — POST /api/notifications/agent.
 *
 * Phase 2 behavior: the route validates the AgentNotification[] body and
 * logs each event to ``console.log`` as a structured JSON line. It does NOT
 * write to a DB or call any external channel — Phase 3 wires the real
 * channel (Slack/Teams/email/etc.) and a separate Phase 2 task (P2.36) adds
 * an audit log.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { POST } from '@/app/api/notifications/agent/route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/notifications/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const sampleNotification = {
  type: 'non_renew_decision' as const,
  cohort_id: '330_wood_frame_q3',
  action: 'non_renew' as const,
  policy_count: 12,
  total_tiv: 1_200_000,
  rationale: 'MIP voted non-renew; no notice / cap conflicts.',
  ts: '2026-05-17T00:00:00Z',
  stamps: [],
};

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silence stdout while spying so test output stays readable.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.clearAllMocks();
});

describe('POST /api/notifications/agent', () => {
  test('happy path: array of notifications → 200 with logged count', async () => {
    const r = await POST(
      req([
        sampleNotification,
        { ...sampleNotification, cohort_id: '330_wood_frame_q4' },
      ]),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.logged).toBe(2);
  });

  test('malformed body: not an array → 400', async () => {
    const r = await POST(req({ wat: 'this is not an array' }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(typeof body.error).toBe('string');
  });

  test('empty array → 200 with logged: 0 and no log side-effects', async () => {
    const r = await POST(req([]));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.logged).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('side effect: console.log called once per notification with structured JSON', async () => {
    const r = await POST(
      req([
        sampleNotification,
        { ...sampleNotification, cohort_id: 'X', action: 'non_renew_capped' },
      ]),
    );
    expect(r.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(2);
    // Each call should receive a string that parses as JSON and carries the
    // notification's cohort_id.
    for (const call of logSpy.mock.calls) {
      const arg = call[0];
      expect(typeof arg).toBe('string');
      const parsed = JSON.parse(arg as string);
      expect(parsed.type).toBe('non_renew_decision');
      expect(typeof parsed.cohort_id).toBe('string');
    }
  });
});
