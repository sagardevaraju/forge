/**
 * Task P2.14 — SensitivityBars component tests.
 *
 * Given a baseline `PortfolioOptimization` (current budgets + objective), the
 * component fires 6 perturbed solves (3 budgets × {−, +} perturbation) in
 * parallel via Promise.all and renders the resulting Δobjectives as ± bars.
 *
 * Tests inject an `onSolve` callback so we don't have to mock global fetch —
 * the production fallback (using `fetch('/api/optimize/portfolio')`) is
 * exercised in the integration wiring task, not here.
 *
 * Coverage:
 *   1. Renders skeleton on mount before solves resolve.
 *   2. Runs 6 solves in parallel — counted + correct perturbation triples.
 *   3. Renders 3 ± bars after Promise.all resolves, each with neg + pos delta.
 *   4. Bar labels show dollar deltas.
 *   5. Visual baseline tick at center of each bar.
 *   6. Error fallback: one rejected solve marks that bar with `?`; others render.
 *   7. `perturbation` prop override changes the multiplier.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SensitivityBars } from '@/components/grammar/SensitivityBars';

const BASELINE = {
  capital_budget: 10_000_000,
  max_nonrenew_pct: 0.1,
  cession_budget: 5_000_000,
  objective: 12_500_000,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SensitivityBars', () => {
  test('renders skeleton on mount before solves resolve', () => {
    // Never-resolving promise keeps the component in its loading state.
    const onSolve = vi.fn().mockImplementation(() => new Promise(() => {}));
    render(<SensitivityBars baseline={BASELINE} onSolve={onSolve} />);
    expect(screen.getByTestId('sensitivity-bars-skeleton')).toBeInTheDocument();
  });

  test('runs 6 solves in parallel with the right perturbed budget triples', async () => {
    // Resolve every call with the same objective so we can inspect the call args.
    const onSolve = vi
      .fn()
      .mockResolvedValue({ objective: BASELINE.objective });

    render(<SensitivityBars baseline={BASELINE} onSolve={onSolve} />);

    await waitFor(() => {
      expect(onSolve).toHaveBeenCalledTimes(6);
    });

    // Collect every triple the component asked for and confirm coverage.
    const triples = onSolve.mock.calls.map(
      (call) => call[0] as {
        capital_budget: number;
        max_nonrenew_pct: number;
        cession_budget: number;
      },
    );

    const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const has = (
      budget: 'capital_budget' | 'max_nonrenew_pct' | 'cession_budget',
      mult: number,
    ) =>
      triples.some(
        (t) =>
          approx(t.capital_budget, budget === 'capital_budget' ? BASELINE.capital_budget * mult : BASELINE.capital_budget) &&
          approx(t.max_nonrenew_pct, budget === 'max_nonrenew_pct' ? BASELINE.max_nonrenew_pct * mult : BASELINE.max_nonrenew_pct) &&
          approx(t.cession_budget, budget === 'cession_budget' ? BASELINE.cession_budget * mult : BASELINE.cession_budget),
      );

    expect(has('capital_budget', 0.9)).toBe(true);
    expect(has('capital_budget', 1.1)).toBe(true);
    expect(has('max_nonrenew_pct', 0.9)).toBe(true);
    expect(has('max_nonrenew_pct', 1.1)).toBe(true);
    expect(has('cession_budget', 0.9)).toBe(true);
    expect(has('cession_budget', 1.1)).toBe(true);
  });

  test('renders 3 ± bars after Promise.all resolves, each with negative + positive delta', async () => {
    // Return different objectives so each bar gets a distinguishable delta.
    // We key off the perturbed field/value to assign per-axis responses.
    const onSolve = vi.fn().mockImplementation(
      async (b: {
        capital_budget: number;
        max_nonrenew_pct: number;
        cession_budget: number;
      }) => {
        if (b.capital_budget === BASELINE.capital_budget * 0.9) {
          return { objective: BASELINE.objective - 800_000 };
        }
        if (b.capital_budget === BASELINE.capital_budget * 1.1) {
          return { objective: BASELINE.objective + 600_000 };
        }
        if (b.max_nonrenew_pct === BASELINE.max_nonrenew_pct * 0.9) {
          return { objective: BASELINE.objective - 200_000 };
        }
        if (b.max_nonrenew_pct === BASELINE.max_nonrenew_pct * 1.1) {
          return { objective: BASELINE.objective + 300_000 };
        }
        if (b.cession_budget === BASELINE.cession_budget * 0.9) {
          return { objective: BASELINE.objective - 100_000 };
        }
        return { objective: BASELINE.objective + 150_000 };
      },
    );

    render(<SensitivityBars baseline={BASELINE} onSolve={onSolve} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('sensitivity-bar')).toHaveLength(3);
    });

    const bars = screen.getAllByTestId('sensitivity-bar');
    for (const bar of bars) {
      expect(bar.querySelector('[data-testid="sensitivity-bar-low"]')).not.toBeNull();
      expect(bar.querySelector('[data-testid="sensitivity-bar-high"]')).not.toBeNull();
    }
  });

  test('bar labels show dollar deltas', async () => {
    const onSolve = vi.fn().mockImplementation(
      async (b: {
        capital_budget: number;
        max_nonrenew_pct: number;
        cession_budget: number;
      }) => {
        if (b.capital_budget === BASELINE.capital_budget * 0.9) {
          return { objective: BASELINE.objective - 1_200_000 };
        }
        if (b.capital_budget === BASELINE.capital_budget * 1.1) {
          return { objective: BASELINE.objective + 800_000 };
        }
        return { objective: BASELINE.objective };
      },
    );

    render(<SensitivityBars baseline={BASELINE} onSolve={onSolve} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('sensitivity-bar')).toHaveLength(3);
    });

    // Locate the capital-budget bar by its label and assert the formatted deltas.
    const bar = screen.getByTestId('sensitivity-bar-capital_budget');
    expect(bar.textContent).toMatch(/-\$1\.2M/);
    expect(bar.textContent).toMatch(/\+\$0\.8M/);
  });

  test('renders a visual baseline tick at the center of each bar', async () => {
    const onSolve = vi.fn().mockResolvedValue({ objective: BASELINE.objective });
    render(<SensitivityBars baseline={BASELINE} onSolve={onSolve} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('sensitivity-bar')).toHaveLength(3);
    });
    const ticks = screen.getAllByTestId('sensitivity-bar-baseline-tick');
    expect(ticks).toHaveLength(3);
  });

  test('if one solve rejects, that bar shows `?` but others render normally', async () => {
    const onSolve = vi.fn().mockImplementation(
      async (b: {
        capital_budget: number;
        max_nonrenew_pct: number;
        cession_budget: number;
      }) => {
        // Reject only the capital_budget × 1.1 perturbation.
        if (b.capital_budget === BASELINE.capital_budget * 1.1) {
          throw new Error('solver explosion');
        }
        return { objective: BASELINE.objective + 100_000 };
      },
    );

    render(<SensitivityBars baseline={BASELINE} onSolve={onSolve} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('sensitivity-bar')).toHaveLength(3);
    });

    const capitalBar = screen.getByTestId('sensitivity-bar-capital_budget');
    expect(capitalBar.textContent).toMatch(/\?/);

    // The other two bars should still render their delta values.
    const nonrenewBar = screen.getByTestId('sensitivity-bar-max_nonrenew_pct');
    const cessionBar = screen.getByTestId('sensitivity-bar-cession_budget');
    expect(nonrenewBar.textContent).not.toMatch(/^\?$/);
    expect(cessionBar.textContent).not.toMatch(/^\?$/);
  });

  test('perturbation prop overrides the default multiplier', async () => {
    const onSolve = vi
      .fn()
      .mockResolvedValue({ objective: BASELINE.objective });

    render(
      <SensitivityBars baseline={BASELINE} onSolve={onSolve} perturbation={0.05} />,
    );

    await waitFor(() => {
      expect(onSolve).toHaveBeenCalledTimes(6);
    });

    const triples = onSolve.mock.calls.map(
      (call) => call[0] as { capital_budget: number },
    );
    const capitals = triples.map((t) => t.capital_budget).sort((a, b) => a - b);
    // Expect exactly one ×0.95 and one ×1.05 sample for capital_budget.
    expect(capitals).toContain(BASELINE.capital_budget * 0.95);
    expect(capitals).toContain(BASELINE.capital_budget * 1.05);
    // The other four samples sit at the baseline capital level.
    const atBaseline = capitals.filter(
      (v) => Math.abs(v - BASELINE.capital_budget) < 1e-6,
    );
    expect(atBaseline).toHaveLength(4);
  });
});
