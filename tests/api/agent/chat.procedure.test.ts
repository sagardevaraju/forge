// @vitest-environment node
/**
 * Task P2.25 — Procedure-mode chat route.
 *
 * Verifies:
 *   * mode='procedure' + valid runbook_id executes every runbook step in
 *     order, emits tool_call + tool_result NDJSON events, then a single
 *     `final` event from the summarize LLM call.
 *   * audit log row's prompt field is `procedure:<runbook_id>` so the
 *     chosen runbook is identifiable by inspection.
 *   * missing runbook_id with mode='procedure' returns 400.
 *   * unknown runbook_id returns 400.
 *   * Free mode (no mode specified) still works (regression).
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
import { getRunbook } from '@/lib/runbooks';
import type { AuditInput, AuditRow } from '@/lib/audit/log';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/chat', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readNdjson(r: Response): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const ev of readChatStream(r)) {
    events.push(ev as unknown as Record<string, unknown>);
  }
  return events;
}

beforeEach(() => {
  __resetChatRouteLlmFactory();
  __resetChatRouteAuditSink();
  // Tool handlers fall back to mocks when no API keys are configured, but
  // many of them still try a live HTTP request first. Force mock mode so the
  // tests are hermetic and fast.
  process.env.FORGE_TOOLS_MODE = 'mock';
});

afterEach(() => {
  __resetChatRouteLlmFactory();
  __resetChatRouteAuditSink();
  delete process.env.FORGE_TOOLS_MODE;
});

describe('POST /api/agent/chat — procedure mode', () => {
  test('executes all steps of pre_landfall_t72 then summarizes', async () => {
    const summarize = vi
      .fn()
      .mockResolvedValue({ content: 'SITREP synthesized: T-72 posture established.' });
    __setChatRouteLlmFactory(() => ({ chat: summarize }));

    const sink = vi.fn<(i: AuditInput) => Promise<AuditRow>>().mockResolvedValue({
      id: 'x'.repeat(64),
      ts: '2026-05-17T00:00:00.000Z',
      user_id: 'demo_user',
      prompt_hash: 'p',
      tool_calls_json: '[]',
      final_hash: 'f',
    });
    __setChatRouteAuditSink(sink);

    const r = await POST(
      req({
        messages: [{ role: 'user', content: 'Run T-72 for AL092024' }],
        mode: 'procedure',
        runbook_id: 'pre_landfall_t72',
        runbook_params: { storm_id: 'AL092024' },
      }),
    );
    expect(r.status).toBe(200);
    const events = await readNdjson(r);

    const expectedSteps = getRunbook('pre_landfall_t72')!.steps;
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(expectedSteps.length);
    expect(toolResults).toHaveLength(expectedSteps.length);

    // Step order is preserved.
    expectedSteps.forEach((step, i) => {
      expect(toolCalls[i].name).toBe(step.tool);
      expect(toolCalls[i].iteration).toBe(i + 1);
      expect(toolCalls[i].description).toBe(step.description);
    });

    // Exactly one LLM call — the summarize call — and no `tools` schema.
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0].tools).toBeUndefined();

    const finalEvent = events[events.length - 1] as { type: string; text: string };
    expect(finalEvent.type).toBe('final');
    expect(finalEvent.text).toMatch(/SITREP synthesized/);
  });

  test('audit log captures procedure:<runbook_id> as the prompt', async () => {
    const summarize = vi.fn().mockResolvedValue({ content: 'done' });
    __setChatRouteLlmFactory(() => ({ chat: summarize }));

    const sink = vi.fn<(i: AuditInput) => Promise<AuditRow>>().mockResolvedValue({
      id: 'y'.repeat(64),
      ts: '2026-05-17T00:00:00.000Z',
      user_id: 'demo_user',
      prompt_hash: 'p',
      tool_calls_json: '[]',
      final_hash: 'f',
    });
    __setChatRouteAuditSink(sink);

    const r = await POST(
      req({
        messages: [{ role: 'user', content: 'Run landfall for AL092024' }],
        mode: 'procedure',
        runbook_id: 'landfall',
        runbook_params: { storm_id: 'AL092024' },
      }),
    );
    expect(r.status).toBe(200);
    await readNdjson(r);
    // Let the fire-and-forget audit settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sink).toHaveBeenCalledTimes(1);
    const payload = sink.mock.calls[0][0];
    expect(payload.prompt).toBe('procedure:landfall');
    expect(payload.final).toBe('done');
    // Tool calls list reflects every step.
    const expectedSteps = getRunbook('landfall')!.steps;
    expect(payload.tool_calls).toHaveLength(expectedSteps.length);
    expectedSteps.forEach((step, i) => {
      expect(payload.tool_calls[i].name).toBe(step.tool);
    });
  });

  test('400 when runbook_id missing in procedure mode', async () => {
    const r = await POST(
      req({
        messages: [{ role: 'user', content: 'x' }],
        mode: 'procedure',
      }),
    );
    expect(r.status).toBe(400);
  });

  test('400 when runbook_id is unknown', async () => {
    const r = await POST(
      req({
        messages: [{ role: 'user', content: 'x' }],
        mode: 'procedure',
        runbook_id: 'not_a_real_runbook',
      }),
    );
    expect(r.status).toBe(400);
  });

  test('free mode unchanged when no mode field is supplied', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'hello operator' });
    __setChatRouteLlmFactory(() => ({ chat }));
    const r = await POST(req({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(r.status).toBe(200);
    const events = await readNdjson(r);
    const finalEvent = events[events.length - 1] as { type: string; text: string };
    expect(finalEvent.type).toBe('final');
    expect(finalEvent.text).toBe('hello operator');
    expect(chat).toHaveBeenCalledTimes(1);
    // Free mode passes `tools` schema to the LLM so it can dispatch.
    expect(chat.mock.calls[0][0].tools).toBeDefined();
  });

  test('procedure mode bypasses MAX_TOOL_ITERATIONS when step count > 6', async () => {
    // No public 7+ step runbook exists today, so just confirm that runbooks
    // with the full step count still run all steps (sanity check that the
    // loop is bounded by step count, not the free-mode iteration cap).
    const summarize = vi.fn().mockResolvedValue({ content: 'ok' });
    __setChatRouteLlmFactory(() => ({ chat: summarize }));

    const rbId = 'post_storm_post_mortem';
    const rb = getRunbook(rbId)!;
    const r = await POST(
      req({
        messages: [{ role: 'user', content: 'after action' }],
        mode: 'procedure',
        runbook_id: rbId,
        runbook_params: { storm_id: 'AL092024' },
      }),
    );
    expect(r.status).toBe(200);
    const events = await readNdjson(r);
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(rb.steps.length);
  });

  test('rejects runbook step that requires storm_id when missing', async () => {
    // Pre-landfall runbooks call requireStormId() in their arg resolver. With
    // no storm_id supplied, the route surfaces the error as a tool_result
    // and continues; the summarize call still runs. Pin that behavior.
    const summarize = vi
      .fn()
      .mockResolvedValue({ content: 'storm_id missing — could not run' });
    __setChatRouteLlmFactory(() => ({ chat: summarize }));

    const r = await POST(
      req({
        messages: [{ role: 'user', content: 'try' }],
        mode: 'procedure',
        runbook_id: 'pre_landfall_t72',
        runbook_params: {},
      }),
    );
    expect(r.status).toBe(200);
    const events = await readNdjson(r);
    const toolResults = events.filter((e) => e.type === 'tool_result') as Array<{
      ok: boolean;
      summary: string;
    }>;
    // At least one step errored (the cone fetch — needs storm_id).
    const errored = toolResults.filter((tr) => tr.ok === false);
    expect(errored.length).toBeGreaterThan(0);
  });
});
