// @vitest-environment node
/**
 * Task P2.19 — Server-side narrative route tests.
 *
 * The route calls the cascading LLM client to produce a 3-line summary of
 * the current optimization state. These tests stub the LLM factory so no
 * network call ever happens. Coverage:
 *
 *   1. Happy path — POST returns 3 lines for a valid LLM response.
 *   2. Cache hit — second POST with the same state_hash skips the LLM call.
 *   3. LLM provider failure — both providers throw → 200 with fallback=true
 *      and a deterministic stub.
 *   4. Missing state_hash — 400 validation error.
 *   5. Malformed LLM output (not 3 lines) — graceful fallback to stub.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { POST, _resetCache } from '@/app/api/agent/narrative/route';
import {
  __setNarrativeLlmFactory,
  __resetNarrativeLlmFactory,
} from '@/app/api/agent/narrative/_llm-factory';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/narrative', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const SAMPLE_STATE = {
  objective: 12_500_000,
  action_summary: {
    retain: { count: 120, tiv: 4.5e8 },
    reprice_up: { count: 18, tiv: 9e7 },
    reprice_down: { count: 3, tiv: 1.2e7 },
    non_renew: { count: 7, tiv: 5e7 },
    cede_qs: { count: 9, tiv: 2.1e8 },
    cede_xs: { count: 2, tiv: 8e7 },
  },
  budgets: {
    capital_budget: 1e7,
    max_nonrenew_pct: 0.1,
    cession_budget: 5e6,
  },
};

beforeEach(() => {
  _resetCache();
  __resetNarrativeLlmFactory();
});

afterEach(() => {
  __resetNarrativeLlmFactory();
  vi.clearAllMocks();
});

describe('POST /api/agent/narrative', () => {
  test('happy path — returns 3 lines from the LLM response', async () => {
    const chat = vi.fn().mockResolvedValue({
      content:
        'Portfolio objective is $12.5M for the horizon.\n' +
        'Recommended mix: retain 120, cede QS 9, reprice up 18 cohorts.\n' +
        'Capital budget is the binding constraint at $10M.',
    });
    __setNarrativeLlmFactory(() => ({ chat }));

    const r = await POST(
      req({ state_hash: 'abc123', state_summary: SAMPLE_STATE }),
    );

    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines.length).toBe(3);
    expect(body.lines[0]).toMatch(/objective/i);
    expect(body.cached).toBe(false);
    expect(body.fallback).toBeFalsy();
    expect(chat).toHaveBeenCalledTimes(1);

    // System prompt must be a portfolio-narrator brief.
    const sentMessages = chat.mock.calls[0][0].messages;
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages[0].content).toMatch(/portfolio|narrat/i);
    // User message must carry the JSON-stringified state summary.
    expect(sentMessages[1].role).toBe('user');
    expect(sentMessages[1].content).toMatch(/objective/);
    // loss_scenarios must NOT be passed through to the LLM (server-side strip).
    expect(sentMessages[1].content).not.toMatch(/loss_scenarios/);
  });

  test('cache hit — second POST with same state_hash returns cached lines, no LLM call', async () => {
    const chat = vi.fn().mockResolvedValue({
      content:
        'Line one of the narrative.\n' +
        'Line two of the narrative.\n' +
        'Line three of the narrative.',
    });
    __setNarrativeLlmFactory(() => ({ chat }));

    const body = { state_hash: 'state-xyz', state_summary: SAMPLE_STATE };
    const r1 = await POST(req(body));
    const r2 = await POST(req(body));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.cached).toBe(false);
    expect(b2.cached).toBe(true);
    expect(b2.lines).toEqual(b1.lines);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  test('LLM provider failure — returns 200 with fallback=true and stub lines', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('upstream provider exhausted'));
    __setNarrativeLlmFactory(() => ({ chat }));

    const r = await POST(
      req({ state_hash: 'fail-hash', state_summary: SAMPLE_STATE }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.fallback).toBe(true);
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines.length).toBeGreaterThanOrEqual(1);
    // Stub must surface the objective number (deterministic, no LLM).
    const joined = body.lines.join(' ');
    expect(joined).toMatch(/live-LLM unavailable|live narrative unavailable|\$12\.5M|objective/i);
  });

  test('missing state_hash — 400 validation error', async () => {
    const chat = vi.fn();
    __setNarrativeLlmFactory(() => ({ chat }));

    const r = await POST(req({ state_summary: SAMPLE_STATE }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBeTruthy();
    expect(chat).not.toHaveBeenCalled();
  });

  test('malformed LLM output (not 3 lines) — graceful fallback to stub', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: 'just one short blob, no newlines',
    });
    __setNarrativeLlmFactory(() => ({ chat }));

    const r = await POST(
      req({ state_hash: 'malformed-hash', state_summary: SAMPLE_STATE }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.fallback).toBe(true);
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines.length).toBeGreaterThanOrEqual(1);
  });

  test('force_refresh=true bypasses the cache', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: 'L1.\nL2.\nL3.',
    });
    __setNarrativeLlmFactory(() => ({ chat }));

    const body = { state_hash: 'refresh-hash', state_summary: SAMPLE_STATE };
    await POST(req(body));
    expect(chat).toHaveBeenCalledTimes(1);
    // Same body — would normally hit the cache.
    const r2 = await POST(
      new Request('http://localhost/api/agent/narrative?force_refresh=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    const b2 = await r2.json();
    expect(b2.cached).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
