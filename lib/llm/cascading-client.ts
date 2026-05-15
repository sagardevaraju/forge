import type { ChatRequest, ChatResponse, ProviderFn } from './types';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class CascadingLLM {
  constructor(
    private opts: {
      primary: ProviderFn;
      fallback: ProviderFn;
      maxRetries: number;
      baseDelayMs: number;
    },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      return await this.withRetry(this.opts.primary, req);
    } catch (e: unknown) {
      const err = e as { status?: number } | null;
      if (err?.status && !RETRY_STATUSES.has(err.status)) throw e;
      return await this.withRetry(this.opts.fallback, req);
    }
  }

  private async withRetry(fn: ProviderFn, req: ChatRequest): Promise<ChatResponse> {
    let lastErr: unknown;
    for (let i = 0; i < this.opts.maxRetries; i++) {
      try {
        return await fn(req);
      } catch (e: unknown) {
        lastErr = e;
        const err = e as { status?: number } | null;
        if (!err?.status || !RETRY_STATUSES.has(err.status)) throw e;
        await new Promise((r) => setTimeout(r, this.opts.baseDelayMs * Math.pow(2, i)));
      }
    }
    throw lastErr;
  }
}

interface OpenAIToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIResponse {
  choices: Array<{ message: OpenAIMessage }>;
}

async function callOpenAICompatible(
  url: string,
  headers: Record<string, string>,
  model: string,
  req: ChatRequest,
): Promise<ChatResponse> {
  const body = JSON.stringify({
    model,
    messages: req.messages,
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
  });

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

  if (!r.ok) throw { status: r.status, body: await r.text() };

  const data = (await r.json()) as OpenAIResponse;
  const message = data.choices[0].message;

  const tool_calls = message.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
  }));

  return {
    content: message.content ?? '',
    ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
  };
}

export function makeOpenRouterProvider(apiKey: string, model: string): ProviderFn {
  return (req: ChatRequest) =>
    callOpenAICompatible(
      'https://openrouter.ai/api/v1/chat/completions',
      { Authorization: `Bearer ${apiKey}` },
      model,
      req,
    );
}

export function makeGitHubModelsProvider(pat: string, model: string): ProviderFn {
  return (req: ChatRequest) =>
    callOpenAICompatible(
      'https://models.inference.ai.azure.com/chat/completions',
      { Authorization: `Bearer ${pat}` },
      model,
      req,
    );
}
