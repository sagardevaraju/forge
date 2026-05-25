/**
 * NDJSON event shape + reader for the streaming variant of
 * `POST /api/portfolio/reoptimize`. Used by `SimulationBanner` to render
 * a credible progress label (sim X of Y, MIP solving, elapsed time) on a
 * job that can take anywhere from ~30 s on a fresh DB to ~10 min on a
 * fully-loaded dev DB with 188 promoted sims.
 *
 * The legacy single-shot JSON contract still works for callers that
 * don't request streaming (the integration test under
 * `tests/api/portfolio/reoptimize.test.ts` is one such caller); the
 * route negotiates on the `Accept` header — request
 * `application/x-ndjson` to opt into the stream.
 *
 * Mirrors the established pattern in `lib/chat-stream.ts`. Kept in a
 * sibling file rather than reusing the chat reader because the event
 * shape is task-specific.
 */

/** Major stages emitted by the route. */
export type ReoptimizeStage =
  | 'sync_start' // syncing missing sim parquets begins (or skipped)
  | 'sync_tick' // one sim parquet just finished (idx of total)
  | 'sync_done' // sync stage finished, precompute is next
  | 'precompute_start' // precompute subprocess kicked off
  | 'precompute_tick'; // a pattern-matched stdout line bumped the phase

export type ReoptimizeEvent =
  | {
      type: 'phase';
      stage: ReoptimizeStage;
      /**
       * 1-indexed position within the stage, when meaningful. Undefined
       * for stage boundaries that don't have a count (start/done).
       */
      idx?: number;
      /** Total expected count for the stage, when known. */
      total?: number;
      /** Optional human-readable label the UI can use verbatim. */
      label?: string;
      /** Optional sim id that just finished, for the sync_tick stage. */
      sim_id?: string;
    }
  | { type: 'log'; line: string }
  | {
      type: 'done';
      solved_at: string;
      included_sims: string[];
      regenerated: string[];
      skipped: string[];
    }
  | { type: 'error'; message: string };

/**
 * Async iterator over the NDJSON stream body. Same line-parsing
 * convention as `readChatStream` — buffer between reads, split on `\n`,
 * yield one parsed event per non-empty line, flush any trailing
 * non-newline-terminated tail.
 */
export async function* readReoptimizeStream(
  response: Response,
): AsyncGenerator<ReoptimizeEvent, void, void> {
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
          yield JSON.parse(line) as ReoptimizeEvent;
        } catch {
          yield {
            type: 'error',
            message: `unparseable line: ${line.slice(0, 80)}`,
          };
        }
      }
      nl = buf.indexOf('\n');
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as ReoptimizeEvent;
    } catch {
      yield {
        type: 'error',
        message: `unparseable tail: ${tail.slice(0, 80)}`,
      };
    }
  }
}

/**
 * Format a wall-clock elapsed-ms count as `M:SS` (or `H:MM:SS` past
 * an hour). Used by the banner label.
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s
      .toString()
      .padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Pattern-match a precompute-script stdout line into a coarser
 * progress phase. Returns ``null`` if the line is just noise (the
 * caller still streams it as a raw `log` event so the operator can
 * eyeball detail when they want it).
 *
 * The phases pin to the print landmarks in
 * `scripts/precompute_portfolio_optimization.py`. Kept in this
 * module — rather than the route — so both sides can unit-test the
 * pattern map without spawning Python.
 */
export function classifyPrecomputeLine(
  line: string,
): { label: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('Aggregated ')) {
    // e.g. "Aggregated 570 cohorts from forge-local.db [joint multi-peril]"
    return { label: 'Loaded cohorts from DB' };
  }
  if (trimmed.startsWith('Book TIV:')) {
    return { label: 'Computing book aggregates' };
  }
  if (trimmed.startsWith('⇒ capital_budget')) {
    return { label: 'Budgets set, starting CBC solve' };
  }
  if (trimmed.startsWith('Wrote ') && trimmed.includes('.json')) {
    return { label: 'Wrote optimization artifact' };
  }
  if (trimmed.startsWith('Action distribution:')) {
    return { label: 'Tabulating action distribution' };
  }
  return null;
}
