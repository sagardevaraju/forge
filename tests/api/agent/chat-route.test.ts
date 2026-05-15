// @vitest-environment node
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '@/app/api/agent/chat/route';
import {
  __setChatRouteLlmFactory,
  __resetChatRouteLlmFactory,
} from '@/app/api/agent/chat/_llm-factory';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/chat', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => __resetChatRouteLlmFactory());
afterEach(() => __resetChatRouteLlmFactory());

describe('POST /api/agent/chat', () => {
  test('400 on invalid JSON', async () => {
    const r = await POST(req('not-json'));
    expect(r.status).toBe(400);
  });

  test('400 when messages missing', async () => {
    const r = await POST(req({}));
    expect(r.status).toBe(400);
  });

  test('returns final content when LLM responds without tool_calls', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'hello operator' });
    __setChatRouteLlmFactory(() => ({ chat }));
    const r = await POST(req({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello operator');
    expect(chat).toHaveBeenCalledTimes(1);
    // System prompt must be prepended.
    const sentMessages = chat.mock.calls[0][0].messages;
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages[0].content).toMatch(/FORGE/);
  });

  test('dispatches tool_calls then returns final content', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'query_book_exposure', arguments: { zip3_list: ['330'] } },
        ],
      })
      .mockResolvedValueOnce({ content: 'FL ZIP3 330 has $109M TIV across 342 policies.' });
    __setChatRouteLlmFactory(() => ({ chat }));

    const r = await POST(
      req({ messages: [{ role: 'user', content: 'TIV in 330?' }] }),
    );

    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/109M|342/);
    expect(chat).toHaveBeenCalledTimes(2);

    // Second call must include the tool result.
    const secondMessages = chat.mock.calls[1][0].messages;
    const toolMsg = secondMessages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('tc1');
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed.policies).toBeGreaterThan(0);
    expect(parsed.total_tiv).toBeGreaterThan(0);
  });

  test('returns {error} JSON to the model when tool throws', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'fetch_nhc_cone', arguments: { storm_id: '' } },
        ],
      })
      .mockResolvedValueOnce({ content: 'ok i recovered' });
    __setChatRouteLlmFactory(() => ({ chat }));

    const r = await POST(req({ messages: [{ role: 'user', content: 'cone?' }] }));
    expect(r.status).toBe(200);
    const secondMessages = chat.mock.calls[1][0].messages;
    const toolMsg = secondMessages.find((m: { role: string }) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ error: expect.stringMatching(/storm_id/) });
  });

  test('returns {error:unknown tool} for unrecognized tool name', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{ id: 'x', name: 'not_a_tool', arguments: {} }],
      })
      .mockResolvedValueOnce({ content: 'done' });
    __setChatRouteLlmFactory(() => ({ chat }));

    const r = await POST(req({ messages: [{ role: 'user', content: 'q' }] }));
    expect(r.status).toBe(200);
    const toolMsg = chat.mock.calls[1][0].messages.find((m: { role: string }) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ error: 'unknown tool: not_a_tool' });
  });

  test('hits the 6-iteration loop ceiling and returns 500', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '',
      tool_calls: [
        { id: 'tc', name: 'query_book_exposure', arguments: { zip3_list: ['330'] } },
      ],
    });
    __setChatRouteLlmFactory(() => ({ chat }));
    const r = await POST(req({ messages: [{ role: 'user', content: 'x' }] }));
    expect(r.status).toBe(500);
    expect(chat).toHaveBeenCalledTimes(6);
  });
});
