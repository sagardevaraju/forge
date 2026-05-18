/**
 * draft_sitrep — produce a STRUCTURED SITREP (6 named fields) from a
 * posture summary string. Task P2.24 (Redesign Phase 2) replaced the
 * Phase-1 free-form markdown memo with a 6-key payload so the UI can
 * render a deterministic table and downstream tools (audit log, PDF
 * export) can index off named fields.
 *
 * Shape:
 *   {
 *     data_source: 'live' | 'synthetic_fallback',
 *     sitrep: {
 *       threat_tier: 'low' | 'medium' | 'high' | 'critical',
 *       lead_time_hours: number,
 *       portfolio_recommendation: string,
 *       operational_recommendation: string,
 *       claims_prep_recommendation: string,
 *       escalation_criteria: string,
 *     }
 *   }
 *
 * Flow:
 *   1. The handler prompts the cascading LLM client for a STRICT JSON
 *      body containing the 6 fields. The system prompt names each field
 *      and forbids prose around the JSON.
 *   2. A hand-rolled validator (`parseStructuredSitrep`) rejects any
 *      response that doesn't match the schema. We don't pull in Zod just
 *      for one tool — the surface area is small and the failure path is
 *      already "fall back to synthetic stub".
 *   3. Any failure (no LLM key, network error, malformed JSON, schema
 *      mismatch) returns `synthetic_fallback` with a deterministic stub
 *      so the SITREP panel never has to render an empty state.
 *
 * Carries a `__setDraftSitrepLlmFactory` test hook (mirrors the P2.19
 * DecisionNarrative pattern) so unit tests inject a stubbed `chat()`.
 */
import {
  CascadingLLM,
  makeOpenRouterProvider,
  makeGitHubModelsProvider,
} from '@/lib/llm/cascading-client';
import type { ChatRequest, ChatResponse, ProviderFn } from '@/lib/llm/types';

export type ThreatTier = 'low' | 'medium' | 'high' | 'critical';

export interface StructuredSitrep {
  threat_tier: ThreatTier;
  lead_time_hours: number;
  portfolio_recommendation: string;
  operational_recommendation: string;
  claims_prep_recommendation: string;
  escalation_criteria: string;
}

export interface DraftSitrepArgs {
  threat_id: string;
  posture_summary: string;
}

export interface DraftSitrepResult {
  data_source: 'live' | 'synthetic_fallback';
  sitrep: StructuredSitrep;
}

const VALID_TIERS: readonly ThreatTier[] = ['low', 'medium', 'high', 'critical'];

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

/**
 * Hand-rolled validator. Returns the parsed StructuredSitrep on success
 * or `null` on any schema violation. Zod is intentionally avoided —
 * one tool, one schema, no need to drag in a dependency.
 */
export function parseStructuredSitrep(raw: unknown): StructuredSitrep | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const tier = o.threat_tier;
  if (typeof tier !== 'string' || !VALID_TIERS.includes(tier as ThreatTier)) {
    return null;
  }
  const lead = o.lead_time_hours;
  if (typeof lead !== 'number' || !Number.isFinite(lead) || lead < 0) {
    return null;
  }
  const stringFields = [
    'portfolio_recommendation',
    'operational_recommendation',
    'claims_prep_recommendation',
    'escalation_criteria',
  ] as const;
  for (const k of stringFields) {
    if (typeof o[k] !== 'string') return null;
  }
  return {
    threat_tier: tier as ThreatTier,
    lead_time_hours: lead,
    portfolio_recommendation: o.portfolio_recommendation as string,
    operational_recommendation: o.operational_recommendation as string,
    claims_prep_recommendation: o.claims_prep_recommendation as string,
    escalation_criteria: o.escalation_criteria as string,
  };
}

/**
 * Strip code fences / leading prose so we can JSON.parse what's left.
 * LLMs sometimes wrap structured output in ```json ... ``` blocks even
 * when told not to. Cheaper to handle that here than to retry.
 */
function extractJsonObject(content: string): unknown {
  if (!content) return null;
  // Strip ``` fences (with or without a language hint).
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : content).trim();
  // Find the outermost {...} so we tolerate prose before/after.
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * Deterministic synthetic stub. Keyed off the posture summary text length
 * so the stub feels "shaped" rather than identical for every call, but
 * still 100% deterministic for tests.
 */
function syntheticStub(args: DraftSitrepArgs): StructuredSitrep {
  const len = (args.posture_summary || '').length;
  const tier: ThreatTier = len > 200 ? 'high' : len > 60 ? 'medium' : 'low';
  return {
    threat_tier: tier,
    lead_time_hours: 0,
    portfolio_recommendation:
      `Maintain current posture for threat ${args.threat_id}; ` +
      'no live LLM available, review action bars manually.',
    operational_recommendation:
      'Stage adjusters at the default ZIP3 anchors for the in-cone region.',
    claims_prep_recommendation:
      'Pre-flag historical-loss cohorts above the configured probability floor.',
    escalation_criteria:
      'Re-broadcast if peak wind exceeds prior forecast or cone shifts materially.',
  };
}

const SYSTEM_PROMPT =
  'You are a catastrophe-operations writer drafting an internal SITREP for a P&C insurer. ' +
  'Output ONLY a single JSON object — no prose, no markdown fences. The object MUST have ' +
  'EXACTLY these 6 keys: threat_tier (one of "low" | "medium" | "high" | "critical"), ' +
  'lead_time_hours (non-negative number — hours until expected impact), ' +
  'portfolio_recommendation (1-2 sentences), operational_recommendation (1-2 sentences), ' +
  'claims_prep_recommendation (1-2 sentences), escalation_criteria (1-2 sentences). ' +
  'Be concrete: cite ZIP3s, staff counts, dollar thresholds, peak-wind triggers where the ' +
  'posture summary provides them.';

export const draftSitrep = {
  name: 'draft_sitrep',
  description:
    'Draft a STRUCTURED SITREP memo (6 fields: threat_tier, lead_time_hours, ' +
    'portfolio_recommendation, operational_recommendation, claims_prep_recommendation, ' +
    'escalation_criteria) summarizing a threat and the current carrier posture. ' +
    'Returns { data_source, sitrep } where data_source is "live" or "synthetic_fallback".',
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
    // Mock when no LLM credentials — keeps demos and CI green without keys.
    const hasKey = Boolean(process.env.OPENROUTER_API_KEY || process.env.GITHUB_MODELS_PAT);
    if (process.env.FORGE_TOOLS_MODE === 'mock' || !hasKey) {
      return { data_source: 'synthetic_fallback', sitrep: syntheticStub(args) };
    }
    try {
      const llm = llmFactory();
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Threat ID: ${args.threat_id}\n\nPosture summary:\n${args.posture_summary}`,
          },
        ],
      });
      const parsed = parseStructuredSitrep(extractJsonObject(resp.content ?? ''));
      if (!parsed) {
        return { data_source: 'synthetic_fallback', sitrep: syntheticStub(args) };
      }
      return { data_source: 'live', sitrep: parsed };
    } catch {
      return { data_source: 'synthetic_fallback', sitrep: syntheticStub(args) };
    }
  },
};
