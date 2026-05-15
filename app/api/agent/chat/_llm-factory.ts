/**
 * Module-scoped LLM factory used by route.ts. Lives outside the route file so
 * that Next.js's route-export validator only sees HTTP method handlers in
 * route.ts itself.
 */
import {
  CascadingLLM,
  makeOpenRouterProvider,
  makeGitHubModelsProvider,
} from '@/lib/llm/cascading-client';
import type { ChatRequest, ChatResponse, ProviderFn } from '@/lib/llm/types';

export interface LLMLike {
  chat: (req: ChatRequest) => Promise<ChatResponse>;
}

export function defaultLlmFactory(): LLMLike {
  const primary: ProviderFn = makeOpenRouterProvider(
    process.env.OPENROUTER_API_KEY ?? '',
    process.env.LLM_PRIMARY_MODEL ?? 'openai/gpt-4.1',
  );
  const fallback: ProviderFn = makeGitHubModelsProvider(
    process.env.GITHUB_MODELS_PAT ?? '',
    process.env.LLM_FALLBACK_MODEL ?? 'gpt-4o',
  );
  return new CascadingLLM({
    primary,
    fallback,
    maxRetries: Number(process.env.LLM_RETRY_MAX ?? 3),
    baseDelayMs: Number(process.env.LLM_RETRY_BASE_MS ?? 500),
  });
}

let llmFactory: () => LLMLike = defaultLlmFactory;

export function getLlmFactory(): () => LLMLike {
  return llmFactory;
}

export function __setChatRouteLlmFactory(f: () => LLMLike) {
  llmFactory = f;
}

export function __resetChatRouteLlmFactory() {
  llmFactory = defaultLlmFactory;
}
