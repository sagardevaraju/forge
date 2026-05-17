/**
 * Task P2.13 — What-if controls on the Portfolio page.
 *
 * Tests the interactive right-rail that lets the operator perturb the three
 * MIP budgets (capital, max non-renew %, cession spend) and re-solve the
 * Portfolio MIP server-side via `/api/optimize/portfolio`. The ExecCard strip
 * re-renders with the new objective + capital usage + delta vs the original
 * solve.
 */
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { PortfolioWhatIfShell } from '@/components/PortfolioWhatIfShell';
import type { PortfolioOptimization } from '@/lib/portfolio-actions';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeOptimization(
  overrides: Partial<PortfolioOptimization> = {},
): PortfolioOptimization {
  return {
    status: 'Optimal',
    objective: 44_500_000,
    horizon_start: '2026-07-01',
    horizon_end: '2027-06-30',
    budgets: {
      capital_budget: 100_000_000,
      max_nonrenew_pct: 0.1,
      cession_budget: 5_000_000,
    },
    book_totals: {
      tiv: 3_100_000_000,
      premium: 50_000_000,
      loss_p50: 20_000_000,
      loss_p99: 89_200_000,
    },
    action_summary: {
      retain: { count: 100, tiv: 1_000_000_000 },
      reprice_n20: { count: 0, tiv: 0 },
      reprice_n10: { count: 10, tiv: 100_000_000 },
      reprice_0: { count: 0, tiv: 0 },
      reprice_p5: { count: 20, tiv: 200_000_000 },
      reprice_p10: { count: 20, tiv: 200_000_000 },
      reprice_p15: { count: 10, tiv: 100_000_000 },
      reprice_p20: { count: 0, tiv: 0 },
      non_renew: { count: 30, tiv: 210_000_000 },
      cede_qs: { count: 20, tiv: 200_000_000 },
      cede_xs: { count: 5, tiv: 50_000_000 },
    },
    cohorts: [],
    actions: [],
    ...overrides,
  };
}

/**
 * Build a `Response`-like object compatible with `await fetch().json()`.
 */
function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('PortfolioWhatIfShell', () => {
  beforeEach(() => {
    // Default: fetch returns the original optimization echoed back.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(makeOptimization())));
  });

  test('renders three WhatIfControls wired to the three budgets', () => {
    const opt = makeOptimization();
    render(<PortfolioWhatIfShell initialOptimization={opt} totalTiv={3_100_000_000} />);
    const controls = screen.getAllByTestId('whatif-control');
    expect(controls).toHaveLength(3);

    // Each control should announce its own label. (`non-renew` matches both
    // the slider label "Max non-renew %" and the ExecCard "Non-renew used /
    // cap" — using getAllByText asserts at least one of each is present.)
    expect(screen.getAllByText(/capital budget/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/max non-renew/i)).toBeInTheDocument();
    expect(screen.getByText(/cession budget/i)).toBeInTheDocument();

    // The three sliders should currently sit at the initial budget values.
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(3);
    expect(sliders[0]).toHaveAttribute('aria-valuenow', '100000000');
    expect(sliders[1]).toHaveAttribute('aria-valuenow', '0.1');
    expect(sliders[2]).toHaveAttribute('aria-valuenow', '5000000');
  });

  test('committing a new capital_budget POSTs to /api/optimize/portfolio with the new value', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(makeOptimization()));
    vi.stubGlobal('fetch', fetchMock);

    const opt = makeOptimization();
    render(<PortfolioWhatIfShell initialOptimization={opt} totalTiv={3_100_000_000} />);
    const sliders = screen.getAllByRole('slider');
    const capitalSlider = sliders[0];
    fireEvent.change(capitalSlider, { target: { value: '120000000' } });
    fireEvent.mouseUp(capitalSlider);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('/api/optimize/portfolio');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.capital_budget).toBe(120000000);
    expect(body.max_nonrenew_pct).toBe(0.1);
    expect(body.cession_budget).toBe(5000000);
  });

  test('mocked fetch response updates the ExecCard objective and capital used', async () => {
    const initial = makeOptimization();
    const solved = makeOptimization({
      objective: 47_800_000,
      budgets: {
        capital_budget: 120_000_000,
        max_nonrenew_pct: 0.1,
        cession_budget: 5_000_000,
      },
      book_totals: {
        tiv: 3_100_000_000,
        premium: 50_000_000,
        loss_p50: 20_000_000,
        loss_p99: 93_500_000,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(solved)),
    );

    render(<PortfolioWhatIfShell initialOptimization={initial} totalTiv={3_100_000_000} />);
    // Initial objective shown.
    expect(screen.getByText(/\$44\.5M/)).toBeInTheDocument();

    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[0], { target: { value: '120000000' } });
    fireEvent.mouseUp(sliders[0]);

    await waitFor(() => expect(screen.getByText(/\$47\.8M/)).toBeInTheDocument());
    // New capital_used / budget pair should render.
    expect(screen.getByText(/93\.5M.*120\.0M/)).toBeInTheDocument();
  });

  test('ExecCard deltas show the change vs baseline after a commit', async () => {
    const initial = makeOptimization();
    const solved = makeOptimization({
      objective: 47_800_000,
      budgets: {
        capital_budget: 120_000_000,
        max_nonrenew_pct: 0.1,
        cession_budget: 5_000_000,
      },
      book_totals: {
        tiv: 3_100_000_000,
        premium: 50_000_000,
        loss_p50: 20_000_000,
        loss_p99: 93_500_000,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(solved)),
    );

    render(<PortfolioWhatIfShell initialOptimization={initial} totalTiv={3_100_000_000} />);
    // No delta line before a re-solve happens.
    expect(screen.queryByText(/vs baseline/i)).toBeNull();

    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[0], { target: { value: '120000000' } });
    fireEvent.mouseUp(sliders[0]);

    // After the re-solve the objective delta should appear (47.8 − 44.5 = +3.3M).
    await waitFor(() =>
      expect(screen.getByText(/\+\$3\.3M.*vs baseline/i)).toBeInTheDocument(),
    );
  });

  test('shows a solving spinner during fetch and clears it on response', async () => {
    let resolveFn: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveFn = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => pending));

    const opt = makeOptimization();
    render(<PortfolioWhatIfShell initialOptimization={opt} totalTiv={3_100_000_000} />);
    expect(screen.queryByTestId('whatif-spinner')).toBeNull();

    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[0], { target: { value: '120000000' } });
    fireEvent.mouseUp(sliders[0]);

    await waitFor(() => expect(screen.getByTestId('whatif-spinner')).toBeInTheDocument());

    resolveFn(jsonResponse(makeOptimization({ objective: 47_800_000 })));

    await waitFor(() => expect(screen.queryByTestId('whatif-spinner')).toBeNull());
  });

  test('Reset to baseline restores both budgets and ExecCard values', async () => {
    const initial = makeOptimization();
    const solved = makeOptimization({
      objective: 47_800_000,
      budgets: {
        capital_budget: 120_000_000,
        max_nonrenew_pct: 0.1,
        cession_budget: 5_000_000,
      },
      book_totals: {
        tiv: 3_100_000_000,
        premium: 50_000_000,
        loss_p50: 20_000_000,
        loss_p99: 93_500_000,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(solved)));

    render(<PortfolioWhatIfShell initialOptimization={initial} totalTiv={3_100_000_000} />);
    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[0], { target: { value: '120000000' } });
    fireEvent.mouseUp(sliders[0]);

    await waitFor(() => expect(screen.getByText(/\$47\.8M/)).toBeInTheDocument());

    const resetBtn = screen.getByRole('button', { name: /reset to baseline/i });
    fireEvent.click(resetBtn);

    // Objective + capital pair return to the initial values.
    expect(screen.getByText(/\$44\.5M/)).toBeInTheDocument();
    expect(screen.getByText(/89\.2M.*100\.0M/)).toBeInTheDocument();
    // The capital slider returns to the initial budget.
    expect(screen.getAllByRole('slider')[0]).toHaveAttribute('aria-valuenow', '100000000');
    // Delta line disappears once we are back to baseline.
    expect(screen.queryByText(/vs baseline/i)).toBeNull();
  });

  test('Infeasible_relaxed response shows a warning banner with relaxation factor', async () => {
    const initial = makeOptimization();
    const relaxed = {
      ...makeOptimization({ objective: 38_000_000 }),
      status: 'Infeasible_relaxed',
      relaxation_factor: 1.5,
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(relaxed)));

    render(<PortfolioWhatIfShell initialOptimization={initial} totalTiv={3_100_000_000} />);
    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[0], { target: { value: '5000000' } });
    fireEvent.mouseUp(sliders[0]);

    const banner = await screen.findByTestId('whatif-warning');
    expect(banner.textContent).toMatch(/infeasible/i);
    expect(banner.textContent).toMatch(/1\.5/);
  });

  test('error response shows a clear message and does NOT blank out the ExecCards', async () => {
    const initial = makeOptimization();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'solver crashed' }, { status: 500, ok: false }),
      ),
    );

    render(<PortfolioWhatIfShell initialOptimization={initial} totalTiv={3_100_000_000} />);
    // Initial values present.
    expect(screen.getByText(/\$44\.5M/)).toBeInTheDocument();

    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[0], { target: { value: '120000000' } });
    fireEvent.mouseUp(sliders[0]);

    const err = await screen.findByTestId('whatif-error');
    expect(err.textContent).toMatch(/solver crashed/i);
    // Original numbers still visible.
    expect(screen.getByText(/\$44\.5M/)).toBeInTheDocument();
    expect(screen.getByText(/89\.2M.*100\.0M/)).toBeInTheDocument();
  });
});
