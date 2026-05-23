import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PortfolioHeader } from '@/components/PortfolioHeader';

afterEach(cleanup);

describe('PortfolioHeader', () => {
  test('renders five exec cards', () => {
    render(
      <PortfolioHeader
        totalTiv={3_100_000_000}
        objective={44_500_000}
        capitalUsed={89_200_000}
        capitalBudget={100_000_000}
        nonrenewUsedTiv={210_000_000}
        nonrenewCapTiv={310_000_000}
        cessionSpend={4_300_000}
        cessionBudget={5_000_000}
      />
    );
    expect(screen.getAllByTestId('exec-card').length).toBe(5);
    expect(screen.getByText(/\$44\.5M/)).toBeInTheDocument();
    // Task P2.20 — ratio cards now stack: headline value on its own line, the
    // budget context in a small caption underneath ("of $100.0M capital
    // budget"). This kills the mid-figure wrap that happened when both values
    // shared a line in narrow grid cells.
    expect(screen.getByText(/\$89\.2M/)).toBeInTheDocument();
    expect(screen.getByText(/of \$100\.0M capital budget/)).toBeInTheDocument();
  });

  test('Task 24: renders treaty-year caption when horizon props supplied', () => {
    render(
      <PortfolioHeader
        totalTiv={3_100_000_000}
        objective={44_500_000}
        capitalUsed={89_200_000}
        capitalBudget={100_000_000}
        nonrenewUsedTiv={210_000_000}
        nonrenewCapTiv={310_000_000}
        cessionSpend={4_300_000}
        cessionBudget={5_000_000}
        horizonStart="2026-07-01"
        horizonEnd="2027-06-30"
      />
    );
    expect(screen.getByText(/Treaty year.*Jul 2026 to Jun 2027/)).toBeInTheDocument();
  });

  test('Task 24: suppresses caption when horizon props missing', () => {
    render(
      <PortfolioHeader
        totalTiv={3_100_000_000}
        objective={44_500_000}
        capitalUsed={89_200_000}
        capitalBudget={100_000_000}
        nonrenewUsedTiv={210_000_000}
        nonrenewCapTiv={310_000_000}
        cessionSpend={4_300_000}
        cessionBudget={5_000_000}
      />
    );
    expect(screen.queryByText(/Treaty year/)).toBeNull();
  });
});

describe('PortfolioHeader — Infeasible status downgrade (2026-05-23)', () => {
  test('renders "—" for margin/tail/non-renew/cession when status=Infeasible', () => {
    render(
      <PortfolioHeader
        totalTiv={3_100_000_000}
        status="Infeasible"
        objective={null}
        capitalUsed={89_200_000}
        capitalBudget={100_000_000}
        nonrenewUsedTiv={210_000_000}
        nonrenewCapTiv={310_000_000}
        cessionSpend={4_300_000}
        cessionBudget={5_000_000}
      />
    );
    // Total TIV still renders (it's a SYNTHETIC_SCAFFOLD card anyway).
    expect(screen.getByText(/\$3\.10B/)).toBeInTheDocument();
    // But every solve-derived card collapses to "—" — no fake margin, no
    // invariant gross-book tail number under a RECOMMENDATION badge.
    expect(screen.queryByText(/\$44\.5M/)).toBeNull();
    expect(screen.queryByText(/\$89\.2M/)).toBeNull();
    expect(screen.queryByText(/\$210\.0M/)).toBeNull();
    expect(screen.queryByText(/\$4\.3M/)).toBeNull();
    // And the banner appears.
    expect(screen.getByTestId('portfolio-infeasible-banner')).toBeInTheDocument();
  });

  test('Optimal status renders headline numbers and omits banner', () => {
    render(
      <PortfolioHeader
        totalTiv={3_100_000_000}
        status="Optimal"
        objective={37_600_000}
        capitalUsed={148_500_000}
        capitalBudget={168_800_000}
        nonrenewUsedTiv={461_400_000}
        nonrenewCapTiv={477_900_000}
        cessionSpend={3_500_000}
        cessionBudget={5_300_000}
      />
    );
    expect(screen.getByText(/\$37\.6M/)).toBeInTheDocument();
    expect(screen.getByText(/\$148\.5M/)).toBeInTheDocument();
    expect(screen.queryByTestId('portfolio-infeasible-banner')).toBeNull();
  });
});
