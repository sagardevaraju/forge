/**
 * draft_sitrep — LLM-drafts a short markdown SITREP (situation report) memo
 * from a posture summary string. Builds its own CascadingLLM so it remains a
 * self-contained tool the agent can invoke.
 */
import {
  CascadingLLM,
  makeOpenRouterProvider,
  makeGitHubModelsProvider,
} from '@/lib/llm/cascading-client';
import type { ChatRequest, ChatResponse, ProviderFn } from '@/lib/llm/types';

export interface DraftSitrepArgs {
  threat_id: string;
  posture_summary: string;
}

export interface DraftSitrepResult {
  memo_markdown: string;
}

// Allow tests to inject a fake LLM without hitting the network.
let llmFactory: () => { chat: (req: ChatRequest) => Promise<ChatResponse> } = defaultLlmFactory;

function defaultLlmFactory() {
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

export function __setDraftSitrepLlmFactory(
  f: () => { chat: (req: ChatRequest) => Promise<ChatResponse> },
) {
  llmFactory = f;
}

export function __resetDraftSitrepLlmFactory() {
  llmFactory = defaultLlmFactory;
}

function mockMemo(args: DraftSitrepArgs): string {
  return [
    `# SITREP — ${args.threat_id}`,
    '',
    '**Posture summary:**',
    args.posture_summary,
    '',
    '**Recommended actions:** stage adjusters, pre-stage claims pre-briefs, monitor reinsurance triggers.',
    '',
    '_Note: draft generated in mock mode (no LLM key configured)._',
  ].join('\n');
}

export const draftSitrep = {
  name: 'draft_sitrep',
  description:
    'Draft a short markdown SITREP memo summarizing a threat and the current carrier posture. Returns memo_markdown.',
  parameters: {
    type: 'object' as const,
    properties: {
      threat_id: {
        type: 'string',
        description: 'Identifier for the threat (e.g., storm id, fire id, declaration number)',
      },
      posture_summary: {
        type: 'string',
        description:
          'Plain-text summary of the current operational posture, including key exposure numbers',
      },
    },
    required: ['threat_id', 'posture_summary'],
  },
  handler: async (args: DraftSitrepArgs): Promise<DraftSitrepResult> => {
    if (!args?.threat_id || !args?.posture_summary) {
      throw new Error('threat_id and posture_summary required');
    }
    // Mock when no LLM credentials are available — keeps demos working.
    const hasKey = Boolean(process.env.OPENROUTER_API_KEY || process.env.GITHUB_MODELS_PAT);
    if (process.env.FORGE_TOOLS_MODE === 'mock' || !hasKey) {
      return { memo_markdown: mockMemo(args) };
    }
    try {
      const llm = llmFactory();
      const resp = await llm.chat({
        messages: [
          {
            role: 'system',
            content:
              'You are a catastrophe-operations writer drafting an internal SITREP for a P&C insurer. Output ONLY markdown. Keep it under 250 words. Include: H1 title, bullet list of key exposures, one-paragraph posture, and a "Recommended actions" list.',
          },
          {
            role: 'user',
            content: `Threat ID: ${args.threat_id}\n\nPosture summary:\n${args.posture_summary}`,
          },
        ],
      });
      return { memo_markdown: resp.content || mockMemo(args) };
    } catch {
      return { memo_markdown: mockMemo(args) };
    }
  },
};
