/**
 * Task P2.19 — Narrative route LLM factory.
 *
 * Module-scoped factory mirroring `app/api/agent/chat/_llm-factory.ts`. Lives
 * outside route.ts so Next.js's route-export validator only sees HTTP method
 * handlers in route.ts itself. Tests use `__setNarrativeLlmFactory` to inject
 * a mock so we never hit the real OpenRouter / GitHub Models endpoints.
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
  // Same provider-preference logic as the chat route: GitHub Models takes the
  // primary slot when a PAT is configured, OpenRouter is the fallback. When
  // no PAT is set we double-up on OpenRouter with two free models so a single
  // upstream outage doesn't kill narrative generation.
  const githubPat = process.env.GITHUB_MODELS_PAT ?? '';
  const openRouterKey = process.env.OPENROUTER_API_KEY ?? '';

  let primary: ProviderFn;
  let fallback: ProviderFn;
  if (githubPat) {
    primary = makeGitHubModelsProvider(
      githubPat,
      process.env.LLM_PRIMARY_MODEL ?? 'gpt-4o-mini',
    );
    fallback = makeOpenRouterProvider(
      openRouterKey,
      process.env.LLM_FALLBACK_MODEL ?? 'z-ai/glm-4.5-air:free',
    );
  } else {
    primary = makeOpenRouterProvider(
      openRouterKey,
      process.env.LLM_PRIMARY_MODEL ?? 'z-ai/glm-4.5-air:free',
    );
    fallback = makeOpenRouterProvider(
      openRouterKey,
      process.env.LLM_FALLBACK_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free',
    );
  }

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

export function __setNarrativeLlmFactory(f: () => LLMLike): void {
  llmFactory = f;
}

export function __resetNarrativeLlmFactory(): void {
  llmFactory = defaultLlmFactory;
}
