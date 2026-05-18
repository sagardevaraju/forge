/**
 * Task P2.19 — POST /api/agent/narrative — agent-generated 3-line summary.
 *
 * Given a small JSON state summary of the current Portfolio MIP solve,
 * produces exactly three plain-English lines via the existing cascading LLM
 * client. Cached in-process by `state_hash` (5-min TTL) so re-renders of the
 * portfolio page don't re-roll the narrative on every view. The caller is
 * responsible for computing the state hash — typically
 * `sha256(canonical_json({objective, action_summary, budgets}))`. Don't
 * include `loss_scenarios` or any large arrays in the summary; the route
 * strips them defensively anyway.
 *
 * Behavior:
 *   • Cache key is just `state_hash` — persona-mode awareness is a follow-up
 *     (P2.18). On a hit, the route returns immediately without invoking the
 *     LLM.
 *   • `force_refresh=true` query param bypasses the cache lookup (the entry
 *     is still rewritten with the fresh narrative so subsequent reads hit).
 *   • If the cascading LLM throws (both providers exhausted) OR returns
 *     malformed output (not 3 lines), the route surfaces HTTP 200 with
 *     `fallback: true` + a deterministic stub built from the state summary.
 *     The UI shows a "live narrative unavailable" hint near the badge.
 *   • Node runtime (NOT Edge) — keeps us aligned with the chat route and
 *     avoids any future fs/libsql friction if we pull state from the DB.
 *
 * Response shape: { lines: string[], cached: boolean, fallback?: boolean }
 */
import { TTLCache } from '@/lib/cache/lru';
import type { ChatRequest } from '@/lib/llm/types';
import { getLlmFactory } from './_llm-factory';

export const runtime = 'nodejs';

const SYSTEM_PROMPT =
  'You are a portfolio-decision narrator for a cat-ops insurance console. ' +
  'Given a JSON summary of the current MIP solve, produce exactly 3 plain-English lines, ' +
  'each ≤ 25 words, in the order: (1) the headline financial result, ' +
  '(2) the recommended portfolio action mix, ' +
  '(3) the key constraint that is binding or the most-pressing decision. ' +
  'Do NOT include numbers without units. Do NOT speculate on data you were not given. ' +
  'Output only the 3 lines, one per row.';

// 5-minute TTL, 128 entries. Per-process only (same trade-off as P2.12).
type CachedNarrative = { lines: string[]; fallback?: boolean };
const CACHE = new TTLCache<CachedNarrative>(128, 5 * 60 * 1000);

/** Test-only: clear the in-memory cache between test cases. */
export function _resetCache(): void {
  CACHE.clear();
}

interface NarrativeBody {
  state_hash: string;
  // Free-form summary — we forward it to the LLM as JSON. We strip any
  // `loss_scenarios` key defensively before serializing.
  state_summary: Record<string, unknown>;
}

function validate(
  body: unknown,
): { ok: true; value: NarrativeBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.state_hash !== 'string' || b.state_hash.length === 0) {
    return { ok: false, error: 'state_hash is required and must be a non-empty string' };
  }
  if (!b.state_summary || typeof b.state_summary !== 'object') {
    return { ok: false, error: 'state_summary is required and must be an object' };
  }
  return {
    ok: true,
    value: {
      state_hash: b.state_hash,
      state_summary: b.state_summary as Record<string, unknown>,
    },
  };
}

/** Strip large arrays we never want to push to the LLM. */
function compactState(state: Record<string, unknown>): Record<string, unknown> {
  const { loss_scenarios: _drop, ...rest } = state as {
    loss_scenarios?: unknown;
  } & Record<string, unknown>;
  void _drop;
  // Defensive: if cohorts come along, strip loss_scenarios per cohort too.
  if (Array.isArray((rest as Record<string, unknown>).cohorts)) {
    const cohorts = (rest as { cohorts: unknown[] }).cohorts.map((c) => {
      if (c && typeof c === 'object' && 'loss_scenarios' in c) {
        const { loss_scenarios: _drop2, ...inner } = c as {
          loss_scenarios?: unknown;
        } & Record<string, unknown>;
        void _drop2;
        return inner;
      }
      return c;
    });
    return { ...rest, cohorts };
  }
  return rest;
}

function parseLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Strip a leading "1. ", "2) ", "- " bullet if the model decides to add one.
    .map((line) => line.replace(/^(\d+[.)]\s+|[-•]\s+)/, ''));
}

function formatMoney(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

/**
 * Deterministic non-LLM stub used when both LLM providers fail or when the
 * LLM produces output we can't parse into 3 lines. Driven entirely by the
 * supplied state summary so the UI shows *something* useful instead of
 * silently swallowing the error.
 */
function buildStub(state: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const objLabel = formatMoney(state.objective);
  if (objLabel) {
    lines.push(`[live-LLM unavailable] objective ${objLabel}.`);
  } else {
    lines.push('[live-LLM unavailable] portfolio summary not available.');
  }

  const summary = state.action_summary;
  if (summary && typeof summary === 'object') {
    const counts = Object.entries(summary as Record<string, unknown>)
      .map(([k, v]) => {
        const c = (v as { count?: unknown })?.count;
        return typeof c === 'number' ? ([k, c] as const) : null;
      })
      .filter((x): x is readonly [string, number] => x !== null)
      .sort((a, b) => b[1] - a[1]);
    const top = counts.slice(0, 2);
    if (top.length > 0) {
      lines.push(
        `Top actions: ${top.map(([k, c]) => `${k} ${c}`).join(', ')}.`,
      );
    }
  }

  const budgets = state.budgets;
  if (budgets && typeof budgets === 'object') {
    const cap = formatMoney((budgets as { capital_budget?: unknown }).capital_budget);
    if (cap) {
      lines.push(`Capital budget set at ${cap}; review binding constraints.`);
    }
  }

  if (lines.length === 0) {
    lines.push('[live-LLM unavailable] live narrative could not be generated.');
  }
  return lines;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const v = validate(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const { state_hash, state_summary } = v.value;

  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get('force_refresh') === 'true';

  if (!forceRefresh) {
    const cached = CACHE.get(state_hash);
    if (cached) {
      return Response.json({
        lines: cached.lines,
        cached: true,
        ...(cached.fallback ? { fallback: true } : {}),
      });
    }
  }

  const compact = compactState(state_summary);

  const messages: ChatRequest['messages'] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(compact) },
  ];

  let lines: string[];
  let fallback = false;

  try {
    const llm = getLlmFactory()();
    const resp = await llm.chat({ messages });
    const parsed = parseLines(resp.content ?? '');
    if (parsed.length !== 3) {
      // Malformed output — fall back to the deterministic stub.
      lines = buildStub(state_summary);
      fallback = true;
    } else {
      lines = parsed;
    }
  } catch {
    lines = buildStub(state_summary);
    fallback = true;
  }

  CACHE.set(state_hash, { lines, fallback });

  return Response.json({
    lines,
    cached: false,
    ...(fallback ? { fallback: true } : {}),
  });
}
