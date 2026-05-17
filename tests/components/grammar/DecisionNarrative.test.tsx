/**
 * Task P2.19 — DecisionNarrative component tests.
 *
 * The component fetches `/api/agent/narrative` on mount + on `stateHash`
 * change and renders the 3-line summary. We stub `fetch` at the global
 * level so no network call is made. Coverage:
 *
 *   1. Renders 3 lines from the API response.
 *   2. Fetches once on initial mount.
 *   3. stateHash prop change triggers a re-fetch.
 *   4. Refresh button forces a new fetch.
 *   5. fallback=true response shows the "live narrative unavailable" hint.
 *   6. Loading state shows a small spinner while fetch is in flight.
 *   7. HTTP error response renders an inline error message (no crash).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { DecisionNarrative } from '@/components/grammar/DecisionNarrative';

const SAMPLE_STATE = {
  objective: 12_500_000,
  action_summary: {
    retain: { count: 120, tiv: 4.5e8 },
    reprice_n20: { count: 0, tiv: 0 },
    reprice_n10: { count: 3, tiv: 1.2e7 },
    reprice_0: { count: 0, tiv: 0 },
    reprice_p5: { count: 6, tiv: 3e7 },
    reprice_p10: { count: 8, tiv: 4e7 },
    reprice_p15: { count: 4, tiv: 2e7 },
    reprice_p20: { count: 0, tiv: 0 },
    non_renew: { count: 7, tiv: 5e7 },
    cede_qs: { count: 9, tiv: 2.1e8 },
    cede_xs: { count: 2, tiv: 8e7 },
  },
  budgets: { capital_budget: 1e7, max_nonrenew_pct: 0.1, cession_budget: 5e6 },
};

function mockFetchOnce(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchAlways(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return mockFetchOnce(body, status);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  // Default: well-formed 3-line response.
});

describe('DecisionNarrative', () => {
  test('renders 3 lines from the API response', async () => {
    mockFetchAlways({
      lines: [
        'Objective $12.5M projected over the horizon.',
        'Mix: retain 120, cede QS 9, reprice up 18 cohorts.',
        'Capital budget binds at $10M.',
      ],
      cached: false,
    });

    render(
      <DecisionNarrative stateHash="hash-1" stateSummary={SAMPLE_STATE} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Objective \$12\.5M/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/cede QS 9/)).toBeInTheDocument();
    expect(screen.getByText(/Capital budget binds/)).toBeInTheDocument();
  });

  test('fetches once on initial mount', async () => {
    const fetchFn = mockFetchAlways({
      lines: ['a.', 'b.', 'c.'],
      cached: false,
    });

    render(
      <DecisionNarrative stateHash="hash-init" stateSummary={SAMPLE_STATE} />,
    );

    await waitFor(() => {
      expect(screen.getByText('a.')).toBeInTheDocument();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('stateHash prop change triggers a re-fetch', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          lines: ['first1.', 'first2.', 'first3.'],
          cached: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          lines: ['second1.', 'second2.', 'second3.'],
          cached: false,
        }),
      });
    vi.stubGlobal('fetch', fetchFn);

    const { rerender } = render(
      <DecisionNarrative stateHash="hash-A" stateSummary={SAMPLE_STATE} />,
    );
    await waitFor(() => {
      expect(screen.getByText('first1.')).toBeInTheDocument();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    rerender(
      <DecisionNarrative stateHash="hash-B" stateSummary={SAMPLE_STATE} />,
    );
    await waitFor(() => {
      expect(screen.getByText('second1.')).toBeInTheDocument();
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('Refresh button forces a new fetch', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          lines: ['v1-a.', 'v1-b.', 'v1-c.'],
          cached: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          lines: ['v2-a.', 'v2-b.', 'v2-c.'],
          cached: false,
        }),
      });
    vi.stubGlobal('fetch', fetchFn);

    render(
      <DecisionNarrative stateHash="hash-refresh" stateSummary={SAMPLE_STATE} />,
    );
    await waitFor(() => {
      expect(screen.getByText('v1-a.')).toBeInTheDocument();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const button = screen.getByRole('button', { name: /refresh/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByText('v2-a.')).toBeInTheDocument();
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Second call must carry force_refresh=true on the URL.
    const secondCallUrl = fetchFn.mock.calls[1][0] as string;
    expect(secondCallUrl).toMatch(/force_refresh=true/);
  });

  test('fallback=true shows the "live narrative unavailable" hint', async () => {
    mockFetchAlways({
      lines: ['[live-LLM unavailable] objective $12.5M.'],
      cached: false,
      fallback: true,
    });

    render(
      <DecisionNarrative
        stateHash="hash-fallback"
        stateSummary={SAMPLE_STATE}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/live-LLM unavailable/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/live narrative unavailable/i),
    ).toBeInTheDocument();
  });

  test('loading state shows a spinner while fetch is in flight', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const pending = new Promise((res) => {
      resolveFn = res;
    });
    const fetchFn = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchFn);

    render(
      <DecisionNarrative stateHash="hash-loading" stateSummary={SAMPLE_STATE} />,
    );

    expect(screen.getByTestId('decision-narrative-spinner')).toBeInTheDocument();

    resolveFn({
      ok: true,
      status: 200,
      json: async () => ({
        lines: ['done1.', 'done2.', 'done3.'],
        cached: false,
      }),
    });
    await waitFor(() => {
      expect(screen.getByText('done1.')).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('decision-narrative-spinner'),
    ).not.toBeInTheDocument();
  });

  test('HTTP error response renders an inline error message and does not crash', async () => {
    mockFetchAlways({ error: 'boom' }, 500);

    render(
      <DecisionNarrative stateHash="hash-err" stateSummary={SAMPLE_STATE} />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('decision-narrative-error'),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('decision-narrative-error').textContent).toMatch(
      /error|unavailable|failed/i,
    );
  });
});
