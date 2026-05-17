/**
 * Shared NDJSON stream reader for /api/agent/chat. Yields parsed events
 * (tool_call, tool_result, final, error) so the AgentChat and Sitrep
 * panels can surface progress without re-implementing the line parser.
 *
 * Task 22 — `tool_call` events carry an optional `iteration` (1-indexed) so
 * the UI can render "Iter N/MAX_TOOL_ITERATIONS" and operators know when the
 * agent is approaching the loop cap. The cap itself lives here so both the
 * route and the client component import the same number.
 */
export const MAX_TOOL_ITERATIONS = 6;

export type Citation = { tool: string; args_hash: string; result_hash: string };

export type ChatEvent =
  | { type: 'tool_call'; name: string; arguments: unknown; iteration?: number }
  | {
      type: 'tool_result';
      name: string;
      ok: boolean;
      summary: string;
      args_hash?: string;
      result_hash?: string;
      /**
       * Optional structured result payload. Task P2.24 — the SITREP panel
       * pulls the StructuredSitrep off `draft_sitrep`'s tool_result rather
       * than parsing the assistant's final-message text. Other tools may
       * leave this undefined; consumers should feature-detect by tool name.
       */
      result?: unknown;
    }
  | { type: 'final'; text: string; citations?: Citation[] }
  | { type: 'error'; message: string };

export async function* readChatStream(
  response: Response,
): AsyncGenerator<ChatEvent, void, void> {
  const body = response.body;
  if (!body) throw new Error('response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          yield JSON.parse(line) as ChatEvent;
        } catch {
          yield { type: 'error', message: `unparseable line: ${line.slice(0, 80)}` };
        }
      }
      nl = buf.indexOf('\n');
    }
  }
  // Flush any trailing buffer (no terminating newline on last event).
  const tail = buf.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as ChatEvent;
    } catch {
      yield { type: 'error', message: `unparseable tail: ${tail.slice(0, 80)}` };
    }
  }
}
