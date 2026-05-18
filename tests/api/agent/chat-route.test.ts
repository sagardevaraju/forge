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

// Task 21 — /api/agent/chat is an NDJSON stream. Each line is one JSON event
// of shape {type:"tool_call"|"tool_result"|"final"|"error", ...}. Parse the
// body line-by-line so tests can assert on individual events.
async function readNdjson(r: Response): Promise<Array<Record<string, unknown>>> {
  const text = await r.text();
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// Task P2.35 — tool results sent back to the LLM are wrapped in
// <tool_result name="..."> ... </tool_result> delimiters. Strip the wrapper
// before JSON-parsing the body.
function stripToolResultWrapper(content: string): string {
  return content.replace(
    /^<tool_result name="[^"]+">|<\/tool_result>$/g,
    '',
  );
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
    const events = await readNdjson(r);
    // Last event must be the final assistant turn.
    const finalEvent = events[events.length - 1];
    expect(finalEvent.type).toBe('final');
    expect(finalEvent.text).toBe('hello operator');
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
    const events = await readNdjson(r);
    const finalEvent = events[events.length - 1] as { type: string; text: string };
    expect(finalEvent.type).toBe('final');
    expect(finalEvent.text).toMatch(/109M|342/);
    expect(chat).toHaveBeenCalledTimes(2);

    // Second call must include the tool result.
    const secondMessages = chat.mock.calls[1][0].messages;
    const toolMsg = secondMessages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('tc1');
    // Task P2.35 — strip <tool_result name="..."> wrapper before parsing.
    const parsed = JSON.parse(stripToolResultWrapper(toolMsg.content));
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
    // Consume the stream so the async tool-dispatch + second LLM call complete.
    await readNdjson(r);
    const secondMessages = chat.mock.calls[1][0].messages;
    const toolMsg = secondMessages.find((m: { role: string }) => m.role === 'tool');
    // Task P2.35 — strip <tool_result name="..."> wrapper before parsing.
    expect(
      JSON.parse(stripToolResultWrapper(toolMsg.content)),
    ).toMatchObject({ error: expect.stringMatching(/storm_id/) });
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
    // Task P2.35 — tool results are wrapped in <tool_result name="..."> tags.
    // Strip the wrapper before JSON-parsing the body.
    const stripped = toolMsg.content.replace(
      /^<tool_result name="[^"]+">|<\/tool_result>$/g,
      '',
    );
    expect(JSON.parse(stripped)).toMatchObject({ error: 'unknown tool: not_a_tool' });
  });

  test('hits the 6-iteration loop ceiling and emits an error event', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '',
      tool_calls: [
        { id: 'tc', name: 'query_book_exposure', arguments: { zip3_list: ['330'] } },
      ],
    });
    __setChatRouteLlmFactory(() => ({ chat }));
    const r = await POST(req({ messages: [{ role: 'user', content: 'x' }] }));
    // Task 21 — NDJSON stream: the route returns 200 with an inline error
    // event on the LAST line instead of a non-200 status.
    expect(r.status).toBe(200);
    const events = await readNdjson(r);
    const lastEvent = events[events.length - 1] as { type: string; message: string };
    expect(lastEvent.type).toBe('error');
    expect(lastEvent.message).toMatch(/exceeded 6 iterations/);
    expect(chat).toHaveBeenCalledTimes(6);
  });
});
