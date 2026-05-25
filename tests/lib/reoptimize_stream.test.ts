// @vitest-environment node
import { describe, test, expect } from 'vitest';
import {
  classifyPrecomputeLine,
  formatElapsed,
  readReoptimizeStream,
  type ReoptimizeEvent,
} from '@/lib/reoptimize-stream';

/**
 * Unit pins for the reoptimize NDJSON stream helpers.
 *
 * The streaming variant of `POST /api/portfolio/reoptimize` writes one
 * JSON event per line. `readReoptimizeStream` is the client-side
 * consumer; tested against a hand-built `Response` rather than the
 * route so we can pin parsing semantics (line splits, trailing-tail
 * flush, malformed-line behaviour) independently of the route's
 * Python subprocess plumbing.
 */

function ndjsonResponse(events: ReoptimizeEvent[]): Response {
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

async function collect(
  res: Response,
): Promise<ReoptimizeEvent[]> {
  const out: ReoptimizeEvent[] = [];
  for await (const ev of readReoptimizeStream(res)) out.push(ev);
  return out;
}

describe('readReoptimizeStream', () => {
  test('parses one event per non-empty line', async () => {
    const res = ndjsonResponse([
      { type: 'phase', stage: 'sync_start', total: 3 },
      { type: 'phase', stage: 'sync_tick', idx: 1, total: 3, sim_id: 'a' },
      { type: 'phase', stage: 'sync_tick', idx: 2, total: 3, sim_id: 'b' },
      { type: 'phase', stage: 'sync_tick', idx: 3, total: 3, sim_id: 'c' },
      { type: 'phase', stage: 'sync_done' },
      {
        type: 'done',
        solved_at: '2026-05-25T17:00:00Z',
        included_sims: ['a', 'b', 'c'],
        regenerated: ['a', 'b', 'c'],
        skipped: [],
      },
    ]);
    const events = await collect(res);
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({ type: 'phase', stage: 'sync_start' });
    expect(events[5]).toMatchObject({
      type: 'done',
      solved_at: '2026-05-25T17:00:00Z',
    });
  });

  test('flushes a trailing event with no terminating newline', async () => {
    // Two events, the second one missing the trailing `\n`. The reader
    // must still surface it (this matches how a server that closes the
    // stream cleanly without a terminator behaves).
    const body =
      JSON.stringify({ type: 'phase', stage: 'sync_start', total: 0 }) +
      '\n' +
      JSON.stringify({
        type: 'done',
        solved_at: '2026-05-25T17:00:00Z',
        included_sims: [],
        regenerated: [],
        skipped: [],
      });
    const res = new Response(body, { status: 200 });
    const events = await collect(res);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'done' });
  });

  test('surfaces an `error` event when a line is unparseable', async () => {
    const body =
      JSON.stringify({ type: 'phase', stage: 'sync_start' }) +
      '\n' +
      '{not_json_here' +
      '\n' +
      JSON.stringify({ type: 'done', solved_at: 'x', included_sims: [], regenerated: [], skipped: [] });
    const res = new Response(body, { status: 200 });
    const events = await collect(res);
    // First the phase event, then the synthesised error, then the done.
    expect(events[0]).toMatchObject({ type: 'phase' });
    expect(events[1]).toMatchObject({ type: 'error' });
    expect(events[2]).toMatchObject({ type: 'done' });
  });

  test('throws if response has no body', async () => {
    const res = new Response(null, { status: 204 });
    await expect(async () => {
      for await (const _ev of readReoptimizeStream(res)) {
        // unreachable
      }
    }).rejects.toThrow(/no body/);
  });
});

describe('formatElapsed', () => {
  test('renders sub-minute as 0:SS', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_500)).toBe('0:07');
    expect(formatElapsed(59_999)).toBe('0:59');
  });

  test('renders minutes as M:SS', () => {
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(125_000)).toBe('2:05');
    expect(formatElapsed(3_599_000)).toBe('59:59');
  });

  test('renders ≥ 1h as H:MM:SS', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });

  test('clamps negative input to 0:00', () => {
    // Defensive — wall-clock subtraction should never go negative, but
    // the formatter shouldn't render gibberish if it does.
    expect(formatElapsed(-100)).toBe('0:00');
  });
});

describe('classifyPrecomputeLine', () => {
  // The line patterns pin to the precompute script's `print()` calls.
  // If the script renames a checkpoint, the banner stops surfacing
  // that phase — these tests are the canary.
  test('returns null for noise lines', () => {
    expect(classifyPrecomputeLine('')).toBeNull();
    expect(classifyPrecomputeLine('   ')).toBeNull();
    expect(classifyPrecomputeLine('some unrelated line')).toBeNull();
  });

  test('maps the cohort-aggregation header', () => {
    expect(
      classifyPrecomputeLine(
        'Aggregated 570 cohorts from forge-local.db [joint multi-peril]',
      ),
    ).toEqual({ label: 'Loaded cohorts from DB' });
  });

  test('maps the book-aggregates landmark', () => {
    expect(classifyPrecomputeLine('  Book TIV: $50,000,000,000')).toEqual({
      label: 'Computing book aggregates',
    });
  });

  test('maps the capital-budget landmark to the CBC-solve label', () => {
    expect(
      classifyPrecomputeLine(
        '  ⇒ capital_budget = $24,389,916 (40 % of Σ per-cohort p99)',
      ),
    ).toEqual({ label: 'Budgets set, starting CBC solve' });
  });

  test('maps the artifact-write line', () => {
    expect(
      classifyPrecomputeLine('Wrote artifacts/portfolio_optimization.json  (5,012,345 bytes)'),
    ).toEqual({ label: 'Wrote optimization artifact' });
  });

  test('maps the action-distribution header', () => {
    expect(classifyPrecomputeLine('Action distribution:')).toEqual({
      label: 'Tabulating action distribution',
    });
  });
});
