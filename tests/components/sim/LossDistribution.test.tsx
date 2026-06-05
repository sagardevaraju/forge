// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { describe, test, expect, afterEach } from 'vitest';
import { LossDistribution } from '@/components/sim/LossDistribution';

afterEach(() => cleanup());

describe('LossDistribution', () => {
  test('renders one bar per histogram bin and the TVaR-99 stat', () => {
    const { container } = render(
      <LossDistribution
        histogram={{ bin_edges: [0, 1, 2, 3], counts: [2, 5, 3] }}
        summary={{ mean: 1_500_000, p50: 1_000_000, p90: 2_000_000,
                   p99: 2_800_000, tvar99: 3_100_000, min: 0, max: 3_500_000 }}
      />,
    );
    expect(container.querySelectorAll('rect').length).toBe(3);
    expect(screen.getByText('TVaR-99')).toBeInTheDocument();
    expect(screen.getByText('$3.1M')).toBeInTheDocument();   // tvar99 via fmtUSD
  });
});
