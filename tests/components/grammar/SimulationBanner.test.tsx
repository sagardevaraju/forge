// tests/components/grammar/SimulationBanner.test.tsx
// @vitest-environment jsdom
import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SimulationBanner } from '@/components/grammar/SimulationBanner';
import type { ReoptimizeEvent } from '@/lib/reoptimize-stream';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SimulationBanner — render shape', () => {
  test('hidden when no unresolved sims', () => {
    const { container } = render(<SimulationBanner unresolved={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test('shows count + buttons for one unresolved sim', () => {
    render(
      <SimulationBanner
        unresolved={[
          {
            id: 'a',
            name: 'Tampa hail',
            peril: 'hail',
            promoted_at: '2026-05-18T12:00:00Z',
          },
        ]}
      />,
    );
    expect(screen.getByText(/1 unresolved simulation/i)).toBeInTheDocument();
    expect(screen.getByText(/Tampa hail/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Re-optimize portfolio/i }),
    ).toBeInTheDocument();
  });

  test('collapses multiple sims into a single count', () => {
    render(
      <SimulationBanner
        unresolved={[
          {
            id: 'a',
            name: 'A',
            peril: 'hail',
            promoted_at: '2026-05-18T12:00:00Z',
          },
          {
            id: 'b',
            name: 'B',
            peril: 'flood',
            promoted_at: '2026-05-18T13:00:00Z',
          },
        ]}
      />,
    );
    expect(screen.getByText(/2 unresolved simulations/i)).toBeInTheDocument();
  });
});

// ── streaming-progress behavior ────────────────────────────────────────

/**
 * Build a streaming `Response` whose body lazily yields the supplied
 * NDJSON events one-by-one — letting the test drive the banner through
 * each progress phase under realistic stream semantics rather than a
 * "everything arrives at once" fast path.
 */
function streamingResponse(events: ReoptimizeEvent[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(JSON.stringify(events[i]) + '\n'));
      i++;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

describe('SimulationBanner — re-optimize progress stream', () => {
  beforeEach(() => {
    // Stub reload — JSDOM throws on `window.location.reload`.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: vi.fn() },
    });
  });

  test('reads NDJSON stream and surfaces per-sim progress in the button label', async () => {
    const events: ReoptimizeEvent[] = [
      { type: 'phase', stage: 'sync_start', total: 3 },
      { type: 'phase', stage: 'sync_tick', idx: 1, total: 3, sim_id: 'a' },
      { type: 'phase', stage: 'sync_tick', idx: 2, total: 3, sim_id: 'b' },
      { type: 'phase', stage: 'sync_tick', idx: 3, total: 3, sim_id: 'c' },
      { type: 'phase', stage: 'sync_done' },
      { type: 'phase', stage: 'precompute_start' },
      { type: 'phase', stage: 'precompute_tick', label: 'Loaded cohorts from DB' },
      { type: 'phase', stage: 'precompute_tick', label: 'Budgets set, starting CBC solve' },
      {
        type: 'done',
        solved_at: '2026-05-25T17:00:00Z',
        included_sims: ['a', 'b', 'c'],
        regenerated: ['a', 'b', 'c'],
        skipped: [],
      },
    ];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(streamingResponse(events));

    render(
      <SimulationBanner
        unresolved={[
          {
            id: 'a',
            name: 'A',
            peril: 'hail',
            promoted_at: '2026-05-18T12:00:00Z',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('reoptimize-button'));

    // The route was called with the NDJSON Accept header — that's the
    // opt-in pin for the streaming branch.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/portfolio/reoptimize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/x-ndjson',
        }),
      }),
    );

    // The terminal `done` event triggers the page reload at the end of
    // the success path — wait for that to fire as the completion pin
    // (after which the button briefly returns to idle before reload).
    await waitFor(() =>
      expect(window.location.reload).toHaveBeenCalled(),
    );
  });

  test('skips the sync label when all caches are present', async () => {
    const events: ReoptimizeEvent[] = [
      { type: 'phase', stage: 'sync_start', total: 0 }, // nothing to do
      { type: 'phase', stage: 'sync_done' },
      { type: 'phase', stage: 'precompute_start' },
      {
        type: 'done',
        solved_at: '2026-05-25T17:00:00Z',
        included_sims: [],
        regenerated: [],
        skipped: [],
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingResponse(events));

    render(
      <SimulationBanner
        unresolved={[
          {
            id: 'a',
            name: 'A',
            peril: 'hail',
            promoted_at: '2026-05-18T12:00:00Z',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('reoptimize-button'));

    await waitFor(() =>
      expect(window.location.reload).toHaveBeenCalled(),
    );
  });

  test('surfaces stream errors on the banner without reloading the page', async () => {
    const events: ReoptimizeEvent[] = [
      { type: 'phase', stage: 'sync_start', total: 0 },
      { type: 'error', message: 'precompute failed: CBC infeasible' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingResponse(events));

    render(
      <SimulationBanner
        unresolved={[
          {
            id: 'a',
            name: 'A',
            peril: 'hail',
            promoted_at: '2026-05-18T12:00:00Z',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('reoptimize-button'));

    // Error text surfaces in the banner; reload is NOT called.
    await waitFor(() =>
      expect(
        screen.getByText(/precompute failed: CBC infeasible/),
      ).toBeInTheDocument(),
    );
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  test('elapsed counter advances at 1 Hz while busy', async () => {
    vi.useFakeTimers();
    // A stream that pulls slowly — keep the banner in the busy state
    // long enough to advance fake timers a few times.
    let resolveStream!: () => void;
    const streamHeld = new Promise<void>((r) => (resolveStream = r));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                type: 'phase',
                stage: 'sync_start',
                total: 0,
              }) + '\n',
            ),
          );
          // Park until the test releases us — let the timer tick
          // observably advance.
          await streamHeld;
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
      );
    });

    render(
      <SimulationBanner
        unresolved={[
          {
            id: 'a',
            name: 'A',
            peril: 'hail',
            promoted_at: '2026-05-18T12:00:00Z',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('reoptimize-button'));

    // Let the initial `sync_start` (total 0) event flow through →
    // 'sync_idle' label.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Advance 3 seconds — banner should show 0:03 in the label.
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('reoptimize-button').textContent).toMatch(/0:03/);

    // Release the stream so the test can clean up.
    resolveStream();
    await act(async () => {
      await Promise.resolve();
    });
    vi.useRealTimers();
    fetchMock.mockRestore();
  });
});
