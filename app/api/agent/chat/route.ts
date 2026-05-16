/**
 * POST /api/agent/chat — FORGE natural-language interface.
 *
 * Returns a streaming NDJSON response so the client can show tool-call
 * progress in real time instead of staring at "Thinking…" for 30 seconds.
 * Each line is a JSON event of shape:
 *   {type:"tool_call",  name, arguments}    — LLM requested a tool
 *   {type:"tool_result",name, ok, summary}  — tool finished
 *   {type:"final",      text}               — final assistant content
 *   {type:"error",      message}            — fatal error mid-stream
 *
 * Node runtime (NOT Edge) because @libsql/client touches the local
 * forge-local.db file in dev and the DB-backed tools need direct fs access.
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

function ndjsonStream(write: (controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void>) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeEvent = (obj: unknown) =>
        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      // expose writer to the worker via closure on `controller`
      (controller as unknown as { writeEvent: typeof writeEvent }).writeEvent = writeEvent;
      try {
        await write(controller);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        writeEvent({ type: 'error', message: msg });
      } finally {
        controller.close();
      }
    },
  });
}

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

  const stream = ndjsonStream(async (controller) => {
    const writeEvent = (controller as unknown as {
      writeEvent: (obj: unknown) => void;
    }).writeEvent;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const resp = await llm.chat({ messages: convo, tools: toolsSchema });
      if (!resp.tool_calls?.length) {
        writeEvent({ type: 'final', text: resp.content ?? '' });
        return;
      }

      // Reformat tool_calls to OpenAI-standard shape before replaying. Strict
      // providers (Z.AI, etc.) require the nested {id, type: "function",
      // function: {name, arguments}} shape with arguments as a string.
      convo.push({
        role: 'assistant',
        content: resp.content ?? '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({
          tool_calls: resp.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments:
                typeof tc.arguments === 'string'
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
            },
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      });

      for (const tc of resp.tool_calls) {
        writeEvent({
          type: 'tool_call',
          name: tc.name,
          arguments: tc.arguments,
        });
        const tool = TOOL_MAP[tc.name];
        let result: unknown;
        let ok = true;
        if (!tool) {
          result = { error: `unknown tool: ${tc.name}` };
          ok = false;
        } else {
          try {
            result = await tool.handler(tc.arguments);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            result = { error: msg };
            ok = false;
          }
        }
        const summary = typeof result === 'object' && result !== null
          ? Object.keys(result as object).slice(0, 5).join(', ')
          : String(result).slice(0, 100);
        writeEvent({ type: 'tool_result', name: tc.name, ok, summary });
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(result),
        });
      }
    }
    writeEvent({
      type: 'error',
      message: `Tool-call loop exceeded ${MAX_TOOL_ITERATIONS} iterations`,
    });
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
