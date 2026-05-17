/**
 * Task P2.15 — Pareto sweep on the Portfolio page.
 *
 * Tests the 3×3 grid solve over (capital_budget, cession_budget) with
 * `max_nonrenew_pct` pinned to the baseline. Grid scale: [0.7×, 1.0×, 1.5×]
 * of each baseline budget => 9 (capital, cession) combinations.
 *
 * The component renders behind a toggle button; on toggle, 9 parallel POSTs
 * to `/api/optimize/portfolio` populate the grid. Each cell shows budget
 * label + achieved objective in $M; the baseline (1.0×, 1.0×) cell is
 * highlighted. Cells whose response is Infeasible (after server-side
 * relaxation also fails) render an "Infeasible" badge instead of an
 * objective.
 */
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from '@testing-library/react';
import { PortfolioPareto } from '@/components/PortfolioPareto';
import type { PortfolioOptimization } from '@/lib/portfolio-actions';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const BASELINE_CAPITAL = 100_000_000;
const BASELINE_CESSION = 5_000_000;
const BASELINE_NONRENEW_PCT = 0.1;
const BASELINE_OBJECTIVE = 44_500_000;

function makeOptimization(
  overrides: Partial<PortfolioOptimization> = {},
): PortfolioOptimization {
  return {
    status: 'Optimal',
    objective: BASELINE_OBJECTIVE,
    horizon_start: '2026-07-01',
    horizon_end: '2027-06-30',
    budgets: {
      capital_budget: BASELINE_CAPITAL,
      max_nonrenew_pct: BASELINE_NONRENEW_PCT,
      cession_budget: BASELINE_CESSION,
    },
    book_totals: {
      tiv: 3_100_000_000,
      premium: 50_000_000,
      loss_p50: 20_000_000,
      loss_p99: 89_200_000,
    },
    action_summary: {
      retain: { count: 100, tiv: 1_000_000_000 },
      reprice_up: { count: 50, tiv: 500_000_000 },
      reprice_down: { count: 10, tiv: 100_000_000 },
      non_renew: { count: 30, tiv: 210_000_000 },
      cede_qs: { count: 20, tiv: 200_000_000 },
      cede_xs: { count: 5, tiv: 50_000_000 },
    },
    cohorts: [],
    actions: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Build a fetch mock that responds based on the request's capital_budget +
 * cession_budget. Returns a fresh `PortfolioOptimization` each call whose
 * `objective` is deterministically derived from the requested budgets, so
 * tests can assert on specific cells by value.
 */
function makeFetchMock(
  objectiveFor: (capital: number, cession: number) => number,
) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    const cap = body.capital_budget as number;
    const ces = body.cession_budget as number;
    return jsonResponse(
      makeOptimization({
        objective: objectiveFor(cap, ces),
        budgets: {
          capital_budget: cap,
          max_nonrenew_pct: BASELINE_NONRENEW_PCT,
          cession_budget: ces,
        },
      }),
    );
  });
}

describe('PortfolioPareto', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock((cap, ces) => 40_000_000 + cap * 0.05 + ces * 0.2),
    );
  });

  test('renders a toggle button and hides the panel by default', () => {
    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    expect(
      screen.getByRole('button', { name: /pareto sweep/i }),
    ).toBeInTheDocument();
    // No grid before toggle.
    expect(screen.queryByTestId('pareto-grid')).toBeNull();
  });

  test('toggling on fires 9 parallel POSTs with the 3×3 budget pairs', async () => {
    const fetchMock = makeFetchMock(
      (cap, ces) => 40_000_000 + cap * 0.05 + ces * 0.2,
    );
    vi.stubGlobal('fetch', fetchMock);

    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    fireEvent.click(screen.getByRole('button', { name: /pareto sweep/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));

    // Every call should hit the same route with POST + JSON body whose
    // max_nonrenew_pct is pinned to the baseline.
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const bodies = calls.map((c) => JSON.parse(c[1].body as string));
    for (const [url, init] of calls) {
      expect(url).toBe('/api/optimize/portfolio');
      expect(init.method).toBe('POST');
    }
    // All 9 bodies pin non-renew to baseline.
    for (const b of bodies) {
      expect(b.max_nonrenew_pct).toBe(BASELINE_NONRENEW_PCT);
    }
    // Three distinct capital values × three distinct cession values.
    const caps = new Set(bodies.map((b) => b.capital_budget));
    const cessions = new Set(bodies.map((b) => b.cession_budget));
    expect(caps.size).toBe(3);
    expect(cessions.size).toBe(3);
    // Baseline must be one of the values on each axis.
    expect(caps.has(BASELINE_CAPITAL)).toBe(true);
    expect(cessions.has(BASELINE_CESSION)).toBe(true);
    // All 9 (capital, cession) pairs must be distinct.
    const pairs = new Set(bodies.map((b) => `${b.capital_budget}_${b.cession_budget}`));
    expect(pairs.size).toBe(9);
  });

  test('renders the 9-cell grid populated with achieved objectives in $M', async () => {
    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    fireEvent.click(screen.getByRole('button', { name: /pareto sweep/i }));

    await waitFor(() => expect(screen.getByTestId('pareto-grid')).toBeInTheDocument());

    const cells = await screen.findAllByTestId('pareto-cell');
    expect(cells).toHaveLength(9);

    // Baseline (1.0× capital, 1.0× cession) objective = 40 + 100M*0.05 + 5M*0.2
    // = 40 + 5 + 1 = $46.0M. Pick that cell out by data-baseline="true".
    const baselineCell = cells.find((c) => c.getAttribute('data-baseline') === 'true');
    expect(baselineCell).toBeDefined();
    expect(baselineCell!.textContent ?? '').toMatch(/\$46\.0M/);
  });

  test('shows a loading state while the 9 solves are in flight', async () => {
    let resolveFns: Array<(value: Response) => void> = [];
    const pending = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFns.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', pending);

    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    fireEvent.click(screen.getByRole('button', { name: /pareto sweep/i }));

    await waitFor(() => expect(screen.getByTestId('pareto-loading')).toBeInTheDocument());

    // Resolve all 9 and verify the spinner clears + grid appears.
    await waitFor(() => expect(resolveFns).toHaveLength(9));
    for (const resolve of resolveFns) {
      resolve(jsonResponse(makeOptimization({ objective: BASELINE_OBJECTIVE })));
    }

    await waitFor(() => expect(screen.queryByTestId('pareto-loading')).toBeNull());
    expect(screen.getByTestId('pareto-grid')).toBeInTheDocument();
  });

  test('Infeasible response from the server renders an Infeasible badge for that cell', async () => {
    // First call (top-left of the grid: smallest capital + cession) is
    // Infeasible; all others succeed.
    let callIdx = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      const idx = callIdx++;
      if (idx === 0) {
        return jsonResponse({
          ...makeOptimization({ objective: 0 }),
          status: 'Infeasible',
          error: 'no feasible solution',
        });
      }
      return jsonResponse(
        makeOptimization({
          objective: 40_000_000 + body.capital_budget * 0.05 + body.cession_budget * 0.2,
          budgets: {
            capital_budget: body.capital_budget,
            max_nonrenew_pct: BASELINE_NONRENEW_PCT,
            cession_budget: body.cession_budget,
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    fireEvent.click(screen.getByRole('button', { name: /pareto sweep/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));
    const cells = await screen.findAllByTestId('pareto-cell');
    expect(cells).toHaveLength(9);

    const infeasibleCells = cells.filter((c) =>
      /infeasible/i.test(c.textContent ?? ''),
    );
    expect(infeasibleCells).toHaveLength(1);
  });

  test('toggling the panel off hides the grid', async () => {
    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    const toggle = screen.getByRole('button', { name: /pareto sweep/i });

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('pareto-grid')).toBeInTheDocument());

    fireEvent.click(toggle);
    expect(screen.queryByTestId('pareto-grid')).toBeNull();
  });

  test('surfaces the MODEL_OUTPUT trust tier and a provenance footnote', async () => {
    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    fireEvent.click(screen.getByRole('button', { name: /pareto sweep/i }));

    await waitFor(() => expect(screen.getByTestId('pareto-grid')).toBeInTheDocument());

    const panel = screen.getByTestId('pareto-panel');
    // The TrustTierBadge renders the short label ("Model"); the full
    // "Model output" gloss lives in the title attribute.
    const badge = within(panel).getByTestId('trust-tier-badge');
    expect(badge.textContent).toMatch(/model/i);
    expect(badge.getAttribute('title') ?? '').toMatch(/model output/i);
    expect(within(panel).getByTestId('provenance-footnote').textContent).toMatch(
      /9 parallel solves/i,
    );
  });

  test('Infeasible_relaxed response still displays the objective with a relaxed marker', async () => {
    let callIdx = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      const idx = callIdx++;
      if (idx === 0) {
        return jsonResponse({
          ...makeOptimization({
            objective: 30_000_000,
            budgets: {
              capital_budget: body.capital_budget,
              max_nonrenew_pct: BASELINE_NONRENEW_PCT,
              cession_budget: body.cession_budget,
            },
          }),
          status: 'Infeasible_relaxed',
          relaxation_factor: 1.5,
        });
      }
      return jsonResponse(
        makeOptimization({
          objective: 40_000_000 + body.capital_budget * 0.05 + body.cession_budget * 0.2,
          budgets: {
            capital_budget: body.capital_budget,
            max_nonrenew_pct: BASELINE_NONRENEW_PCT,
            cession_budget: body.cession_budget,
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const opt = makeOptimization();
    render(<PortfolioPareto baselineOptimization={opt} totalTiv={3_100_000_000} />);
    fireEvent.click(screen.getByRole('button', { name: /pareto sweep/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));
    const cells = await screen.findAllByTestId('pareto-cell');

    const relaxed = cells.filter((c) => /relaxed/i.test(c.textContent ?? ''));
    expect(relaxed.length).toBeGreaterThanOrEqual(1);
    // The objective from the relaxed solve ($30.0M) should still appear.
    expect(relaxed[0].textContent ?? '').toMatch(/\$30\.0M/);
  });
});
