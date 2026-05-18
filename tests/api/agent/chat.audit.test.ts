// @vitest-environment node
/**
 * Task P2.36 — Chat route writes a content-addressed audit row per turn.
 *
 * The route calls ``appendAuditRow`` (via the swappable
 * ``_audit-factory.ts`` injection) after emitting the ``final`` event. The
 * write is fire-and-forget so the NDJSON stream is not blocked on the DB.
 *
 * We swap in a ``vi.fn()`` audit sink and assert:
 *   * it is invoked exactly once per turn,
 *   * the payload carries the user_id placeholder, the user prompt verbatim,
 *     the sequence of tool calls dispatched in this turn (name + args, NOT
 *     results), and the final assistant text.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '@/app/api/agent/chat/route';
import {
  __setChatRouteLlmFactory,
  __resetChatRouteLlmFactory,
} from '@/app/api/agent/chat/_llm-factory';
import {
  __setChatRouteAuditSink,
  __resetChatRouteAuditSink,
} from '@/app/api/agent/chat/_audit-factory';
import { readChatStream } from '@/lib/chat-stream';
import type { AuditInput, AuditRow } from '@/lib/audit/log';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/chat', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function drain(r: Response) {
  for await (const _ of readChatStream(r)) {
    // exhaust the stream so the writer's audit fire-and-forget runs
  }
}

beforeEach(() => {
  __resetChatRouteLlmFactory();
  __resetChatRouteAuditSink();
});

afterEach(() => {
  __resetChatRouteLlmFactory();
  __resetChatRouteAuditSink();
});

describe('POST /api/agent/chat — content-addressed audit log', () => {
  test('writes one audit row per turn with the right shape', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'query_book_exposure', arguments: { zip3_list: ['330'] } },
        ],
      })
      .mockResolvedValueOnce({ content: 'FL ZIP3 330: $109M TIV.' });
    __setChatRouteLlmFactory(() => ({ chat }));

    const sink = vi.fn<(i: AuditInput) => Promise<AuditRow>>().mockResolvedValue({
      id: 'a'.repeat(64),
      ts: '2026-05-17T00:00:00.000Z',
      user_id: 'demo_user',
      prompt_hash: 'p',
      tool_calls_json: '[]',
      final_hash: 'f',
    });
    __setChatRouteAuditSink(sink);

    const r = await POST(req({ messages: [{ role: 'user', content: 'TIV in 330?' }] }));
    expect(r.status).toBe(200);
    await drain(r);

    // Allow the fire-and-forget audit call to settle before assertions.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sink).toHaveBeenCalledTimes(1);
    const payload = sink.mock.calls[0][0];
    expect(payload.user_id).toBe('demo_user');
    expect(payload.prompt).toBe('TIV in 330?');
    expect(payload.final).toBe('FL ZIP3 330: $109M TIV.');
    expect(payload.tool_calls).toEqual([
      { name: 'query_book_exposure', args: { zip3_list: ['330'] } },
    ]);
  });

  test('audit captures empty tool_calls when LLM answers without dispatching', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'hello operator' });
    __setChatRouteLlmFactory(() => ({ chat }));

    const sink = vi.fn<(i: AuditInput) => Promise<AuditRow>>().mockResolvedValue({
      id: 'b'.repeat(64),
      ts: '2026-05-17T00:00:00.000Z',
      user_id: 'demo_user',
      prompt_hash: 'p',
      tool_calls_json: '[]',
      final_hash: 'f',
    });
    __setChatRouteAuditSink(sink);

    const r = await POST(req({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(r.status).toBe(200);
    await drain(r);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sink).toHaveBeenCalledTimes(1);
    const payload = sink.mock.calls[0][0];
    expect(payload.prompt).toBe('hi');
    expect(payload.final).toBe('hello operator');
    expect(payload.tool_calls).toEqual([]);
  });

  test('sink rejection is swallowed — request still completes with status 200', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'ok' });
    __setChatRouteLlmFactory(() => ({ chat }));

    const sink = vi
      .fn<(i: AuditInput) => Promise<AuditRow>>()
      .mockRejectedValue(new Error('db unavailable'));
    __setChatRouteAuditSink(sink);

    // Silence the expected console.error from the route.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await POST(req({ messages: [{ role: 'user', content: 'x' }] }));
      expect(r.status).toBe(200);
      await drain(r);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
