/**
 * POST /api/agent/chat — FORGE natural-language interface.
 *
 * Runs a CascadingLLM-backed tool-calling loop. Each iteration: send the
 * conversation, if the model returns tool_calls, dispatch them through
 * TOOL_MAP, append the tool results, and loop. Stops at MAX_TOOL_ITERATIONS.
 *
 * Currently Node runtime (NOT Edge): @libsql/client touches the local
 * forge-local.db file during dev and the DB tools need direct access.
 * TODO: switch to `export const runtime = 'edge';` once Turso is provisioned
 * and @libsql/client/web becomes viable.
 */
import type { ChatRequest } from '@/lib/llm/types';
import { TOOLS, TOOL_MAP } from '@/lib/llm/tool-registry';
import { getLlmFactory } from './_llm-factory';

export const runtime = 'nodejs';

const MAX_TOOL_ITERATIONS = 6;

const SYSTEM_PROMPT =
  'You are FORGE, a catastrophe-operations co-pilot for a P&C insurance carrier. ' +
  'You have tools that pull live hazard data (hurricane cones, fire detections, FEMA declarations), ' +
  'query the carrier book (TIV by ZIP3, historical storm events), run ensemble scenario generation, ' +
  'and draft SITREP memos. Use the tools to look up real numbers before answering. ' +
  'Cite specific numeric values from tool results. Keep answers tight and operational.';

export async function POST(req: Request) {
  let body: { messages: unknown[] } | undefined;
  try {
    body = (await req.json()) as { messages: unknown[] };
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (!body || !Array.isArray(body.messages)) {
    return new Response('messages required', { status: 400 });
  }

  const llm = getLlmFactory()();
  const toolsSchema = TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const convo: ChatRequest['messages'] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(body.messages as ChatRequest['messages']),
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await llm.chat({ messages: convo, tools: toolsSchema });
    if (!resp.tool_calls?.length) {
      return new Response(resp.content, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    // Record the assistant's tool-call message so subsequent turns have context.
    // tool_calls is non-standard for our local ChatRequest['messages'] shape
    // but OpenAI-compatible providers tolerate the extra field, and replaying
    // it preserves the canonical tool-calling loop.
    convo.push({
      role: 'assistant',
      content: resp.content ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ tool_calls: resp.tool_calls } as any),
    });
    for (const tc of resp.tool_calls) {
      const tool = TOOL_MAP[tc.name];
      let result: unknown;
      if (!tool) {
        result = { error: `unknown tool: ${tc.name}` };
      } else {
        try {
          result = await tool.handler(tc.arguments);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          result = { error: msg };
        }
      }
      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: JSON.stringify(result),
      });
    }
  }
  return new Response('Tool-call loop exceeded', { status: 500 });
}
