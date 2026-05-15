/**
 * Task 20 — PortfolioMap aggregation and drill-down behavior.
 *
 * react-map-gl is mocked so the suite runs in jsdom (no WebGL) and so we
 * can assert on the data wired into the legend and the GeoJSON source
 * without needing a real Mapbox instance.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Cohort } from '@/lib/db/cohorts';

// Stub react-map-gl/mapbox so we render plain DOM nodes in jsdom. Each Map,
// Source and Layer becomes a div so children (the legend) still mount.
vi.mock('react-map-gl/mapbox', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="map-base-stub">{children}</div>
  ),
  Source: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="map-source">{children}</div>
  ),
  Layer: () => <div data-testid="map-layer" />,
}));

// Also stub the CSS import — vitest can't parse it via the jsdom transform.
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));

// Force the fallback-free path so the legend renders on top of the map shell.
process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test.token';

import { PortfolioMap } from '@/components/PortfolioMap';
import { PortfolioDrillDown } from '@/components/PortfolioDrillDown';

function cohort(over: Partial<Cohort>): Cohort {
  return {
    id: '330_wood_frame_d0',
    zip3: '330',
    build_type: 'wood_frame',
    tiv_decile: 0,
    policy_count: 5,
    total_tiv: 1_000_000,
    total_premium: 25_000,
    avg_cv_features: new Array(8).fill(0),
    modal_flood_zone: 'X',
    avg_elevation_m: 3,
    ...over,
  };
}

// Vitest doesn't auto-call cleanup the way Jest's testing-library preset does,
// so we wire it ourselves to isolate rendered trees per test.
afterEach(() => {
  cleanup();
});

describe('PortfolioMap', () => {
  test('renders aggregate stats in the legend', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_d0', zip3: '330', total_tiv: 1_000_000, policy_count: 5 }),
      cohort({ id: '330_masonry_d1', zip3: '330', total_tiv: 500_000, policy_count: 3 }),
      cohort({ id: '770_wood_frame_d2', zip3: '770', total_tiv: 2_500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} />);

    const legend = screen.getByTestId('portfolio-legend');
    // Two unique ZIP3s in the input.
    expect(legend).toHaveTextContent('ZIP3s: 2');
    // 5 + 3 + 10 = 18 policies.
    expect(legend).toHaveTextContent('Total policies: 18');
    // 1.0M + 0.5M + 2.5M = 4.0M total TIV.
    expect(legend).toHaveTextContent('Total TIV: $4,000,000');
  });

  test('renders the map shell so child Source/Layer mount under it', () => {
    render(<PortfolioMap cohorts={[cohort({})]} />);
    expect(screen.getByTestId('map-base-stub')).toBeInTheDocument();
    expect(screen.getByTestId('map-source')).toBeInTheDocument();
    expect(screen.getByTestId('map-layer')).toBeInTheDocument();
  });
});

describe('PortfolioDrillDown', () => {
  test('renders cohorts for the selected ZIP3', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_d0', zip3: '330', policy_count: 7, total_tiv: 3_500_000 }),
      cohort({ id: '330_masonry_d2', zip3: '330', policy_count: 4, total_tiv: 1_200_000 }),
    ];
    render(<PortfolioDrillDown zip3="330" cohorts={cohorts} onClose={() => {}} />);

    expect(screen.getByText('ZIP3 330')).toBeInTheDocument();
    // 7 + 4 = 11 policies in the selected ZIP3.
    expect(screen.getByText('Policies: 11')).toBeInTheDocument();
    // Each cohort id should appear in the table.
    expect(screen.getByText('330_wood_frame_d0')).toBeInTheDocument();
    expect(screen.getByText('330_masonry_d2')).toBeInTheDocument();
  });
});
