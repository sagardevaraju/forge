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
  // Provider preference: GitHub Models (free, higher capacity, paid-tier
  // quality via gpt-4o-mini) takes primary slot when a PAT is configured.
  // OpenRouter (which is more rate-limited on free tiers) becomes the
  // fallback. When no PAT is set we fall back to OpenRouter for both slots
  // using two distinct free models so a single upstream provider outage
  // doesn't break the chat.
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

export function __setChatRouteLlmFactory(f: () => LLMLike) {
  llmFactory = f;
}

export function __resetChatRouteLlmFactory() {
  llmFactory = defaultLlmFactory;
}
