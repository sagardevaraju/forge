'use client';

/**
 * Task P2.19 (Redesign Phase 2) — DecisionNarrative grammar primitive.
 *
 * Renders an agent-generated 3-line plain-English summary of the current
 * Portfolio MIP solve. Composed above the action bars on the portfolio
 * page (and on the what-if shell in a follow-up task) so a reviewer sees
 * the "why" of the recommendation before parsing the chart.
 *
 * Data flow:
 *   1. Parent computes a `stateHash` over the canonical-JSON of the
 *      optimization state (objective + action_summary + budgets) and
 *      passes it alongside a `stateSummary` payload.
 *   2. The component POSTs both to `/api/agent/narrative`. The server
 *      caches by hash for 5 minutes, so repeated renders are free.
 *   3. The component renders the returned lines beneath a
 *      RECOMMENDATION trust-tier badge plus a Refresh button that
 *      bypasses the server cache (`force_refresh=true`).
 *
 * Failure modes:
 *   • HTTP error → inline error message (no crash).
 *   • LLM upstream failure → server responds with `fallback: true` and a
 *     deterministic stub; the component shows a "live narrative
 *     unavailable" hint near the trust badge but still renders the stub
 *     lines so the surface isn't empty.
 *   • In-flight → small spinner; the previous lines stay visible underneath
 *     so the layout doesn't shift.
 *
 * Pure grammar primitive — no page coupling. The caller owns the state
 * hash and the summary payload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TrustTierBadge } from './TrustTierBadge';
import { ProvenanceFootnote } from './ProvenanceFootnote';

interface DecisionNarrativeProps {
  stateHash: string;
  stateSummary: Record<string, unknown>;
  /**
   * Optional override for the fetch endpoint — exists to keep tests and
   * Storybook hermetic. Defaults to `/api/agent/narrative`.
   */
  endpoint?: string;
}

interface NarrativeResponse {
  lines: string[];
  cached: boolean;
  fallback?: boolean;
}

export function DecisionNarrative({
  stateHash,
  stateSummary,
  endpoint = '/api/agent/narrative',
}: DecisionNarrativeProps) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [fallback, setFallback] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest summary in a ref so the fetch effect can read it without
  // bouncing on every re-render (the caller may rebuild the summary object
  // even when the underlying state hasn't changed).
  const summaryRef = useRef(stateSummary);
  summaryRef.current = stateSummary;

  const runFetch = useCallback(
    async (force: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const url = force ? `${endpoint}?force_refresh=true` : endpoint;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state_hash: stateHash,
            state_summary: summaryRef.current,
          }),
        });
        if (!resp.ok) {
          setError(
            `narrative service unavailable — HTTP ${resp.status}; please retry.`,
          );
          setLoading(false);
          return;
        }
        const data = (await resp.json()) as NarrativeResponse;
        setLines(Array.isArray(data.lines) ? data.lines : null);
        setFallback(Boolean(data.fallback));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`narrative fetch failed: ${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [endpoint, stateHash],
  );

  useEffect(() => {
    runFetch(false);
  }, [runFetch]);

  return (
    <div
      data-testid="decision-narrative"
      className="flex flex-col gap-2 p-3 border rounded bg-white"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrustTierBadge tier="RECOMMENDATION" />
          {fallback && (
            <span
              data-testid="decision-narrative-fallback-hint"
              className="text-[10px] text-amber-700"
              title="The cascading LLM is unavailable; a deterministic stub is shown."
            >
              live narrative unavailable — stub shown
            </span>
          )}
          {loading && (
            <span
              data-testid="decision-narrative-spinner"
              role="status"
              aria-label="loading narrative"
              className="inline-block h-3 w-3 rounded-full border-2 border-zinc-300 border-t-emerald-500 animate-spin"
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => runFetch(true)}
          disabled={loading}
          className="text-[10px] uppercase tracking-wide text-emerald-700 hover:text-emerald-900 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div
          data-testid="decision-narrative-error"
          role="alert"
          className="text-xs text-red-700"
        >
          {error}
        </div>
      )}

      {lines && lines.length > 0 && (
        <ol
          data-testid="decision-narrative-lines"
          className="flex flex-col gap-1 text-sm text-zinc-800 list-none m-0 p-0"
        >
          {lines.map((line, i) => (
            <li key={i} className="leading-snug">
              {line}
            </li>
          ))}
        </ol>
      )}

      <ProvenanceFootnote
        source="Generated by cascading LLM client (OpenRouter primary, GitHub Models PAT fallback)."
        method="Cached server-side by state hash for 5 minutes."
      />
    </div>
  );
}
