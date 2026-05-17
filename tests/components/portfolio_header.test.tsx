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
    expect(screen.getByText(/89\.2M.*100\.0M/)).toBeInTheDocument();
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
    expect(screen.getByText(/Treaty year: Jul 2026 – Jun 2027/)).toBeInTheDocument();
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
    expect(screen.queryByText(/Treaty year:/)).toBeNull();
  });
});
