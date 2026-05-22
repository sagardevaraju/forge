/**
 * Task 20 — PortfolioMap aggregation and drill-down behavior.
 *
 * react-map-gl is mocked so the suite runs in jsdom (no WebGL) and so we
 * can assert on the data wired into the legend and the GeoJSON source
 * without needing a real Mapbox instance.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup, within } from '@testing-library/react';
import type { Cohort } from '@/lib/db/cohorts';

// Stub react-map-gl/maplibre so we render plain DOM nodes in jsdom. Each Map,
// Source and Layer becomes a div so children (the legend) still mount.
// Task 19 swapped Mapbox for MapLibre; this mock was updated in Task 26.
vi.mock('react-map-gl/maplibre', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="map-base-stub">{children}</div>
  ),
  // The Source mock exposes its `id` and serialized `data` so tests can
  // assert on the GeoJSON wired into a layer without a WebGL canvas.
  Source: ({
    id,
    data,
    children,
  }: {
    id?: string;
    data?: unknown;
    children?: React.ReactNode;
  }) => (
    <div
      data-testid="map-source"
      data-source-id={id}
      data-geojson={data ? JSON.stringify(data) : ''}
    >
      {children}
    </div>
  ),
  Layer: () => <div data-testid="map-layer" />,
}));

// Also stub the CSS import — vitest can't parse it via the jsdom transform.
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

// Force the fallback-free path so the legend renders on top of the map shell.
process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test.token';

import { PortfolioMap } from '@/components/PortfolioMap';
import { PortfolioDrillDown } from '@/components/PortfolioDrillDown';
import type { PortfolioOptimization } from '@/lib/portfolio-actions';

function makeOptimization(): PortfolioOptimization {
  return {
    status: 'Optimal',
    objective: 12_500_000,
    budgets: {
      capital_budget: 50_000_000,
      max_nonrenew_pct: 0.1,
      cession_budget: 10_000_000,
    },
    book_totals: {
      tiv: 4_000_000,
      premium: 100_000,
      loss_p50: 1_000_000,
      loss_p99: 5_000_000,
    },
    action_summary: {
      retain: { count: 2, tiv: 3_500_000 },
      reprice_n20: { count: 0, tiv: 0 },
      reprice_n10: { count: 0, tiv: 0 },
      reprice_0: { count: 0, tiv: 0 },
      reprice_p5: { count: 0, tiv: 0 },
      reprice_p10: { count: 1, tiv: 500_000 },
      reprice_p15: { count: 0, tiv: 0 },
      reprice_p20: { count: 0, tiv: 0 },
      non_renew: { count: 0, tiv: 0 },
      cede_qs: { count: 0, tiv: 0 },
      cede_xs: { count: 0, tiv: 0 },
    },
    cohorts: [
      {
        id: '330_wood_frame_q0',
        zip3: '330',
        build_type: 'wood_frame',
        tiv_quintile: 0,
        policy_count: 5,
        total_tiv: 3_500_000,
        total_premium: 80_000,
        modal_flood_zone: 'X',
        avg_elevation_m: 3,
        loss_p50: 800_000,
        loss_p99: 3_500_000,
      },
      {
        id: '770_wood_frame_q2',
        zip3: '770',
        build_type: 'wood_frame',
        tiv_quintile: 2,
        policy_count: 10,
        total_tiv: 500_000,
        total_premium: 20_000,
        modal_flood_zone: 'X',
        avg_elevation_m: 3,
        loss_p50: 200_000,
        loss_p99: 1_500_000,
      },
    ],
    actions: [
      {
        cohort_id: '330_wood_frame_q0',
        retain: 1,
        reprice_n20: 0,
        reprice_n10: 0,
        reprice_0: 0,
        reprice_p5: 0,
        reprice_p10: 0,
        reprice_p15: 0,
        reprice_p20: 0,
        non_renew: 0,
        cede_qs: 0,
        cede_xs: 0,
        dominant_action: 'retain',
        dominant_share: 1,
      },
      {
        cohort_id: '770_wood_frame_q2',
        retain: 0,
        reprice_n20: 0,
        reprice_n10: 0,
        reprice_0: 0,
        reprice_p5: 0,
        reprice_p10: 1,
        reprice_p15: 0,
        reprice_p20: 0,
        non_renew: 0,
        cede_qs: 0,
        cede_xs: 0,
        dominant_action: 'reprice_p10',
        dominant_share: 1,
      },
    ],
  };
}

function cohort(over: Partial<Cohort>): Cohort {
  return {
    id: '330_wood_frame_q0',
    zip3: '330',
    build_type: 'wood_frame',
    tiv_quintile: 0,
    policy_count: 5,
    total_tiv: 1_000_000,
    total_premium: 25_000,
    // Task 13 — typed CvFeatures (5 modeled dims; 3 unmodeled dropped).
    avg_cv_features: {
      vegetation_density: { value: 0, modeled: true },
      fuel_proximity: { value: 0, modeled: true },
      water_proximity: { value: 0, modeled: true },
      elevation_bucket: { value: 0, modeled: true },
      structure_density: { value: 0, modeled: true },
    },
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
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 1_000_000, policy_count: 5 }),
      cohort({ id: '330_masonry_q1', zip3: '330', total_tiv: 500_000, policy_count: 3 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 2_500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} />);

    const legend = screen.getByTestId('portfolio-legend');
    // Two unique ZIP3s in the input.
    expect(legend.textContent).toMatch(/ZIP3s\s*2/);
    // 5 + 3 + 10 = 18 policies.
    expect(legend.textContent).toMatch(/Policies\s*18/);
    // 1.0M + 0.5M + 2.5M = 4.0M total TIV.
    expect(legend.textContent).toMatch(/Total TIV\s*\$4,000,000/);
  });

  test('renders the map shell so child Source/Layer mount under it', () => {
    render(<PortfolioMap cohorts={[cohort({})]} />);
    expect(screen.getByTestId('map-base-stub')).toBeInTheDocument();
    expect(screen.getByTestId('map-source')).toBeInTheDocument();
    expect(screen.getByTestId('map-layer')).toBeInTheDocument();
  });

  // Task 18 — legend semantic explanation of swatch colors.
  test('legend explains color semantics', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 3_500_000, policy_count: 5 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} optimization={makeOptimization()} />);
    expect(
      screen.getByText(/MIP's dominant recommendation by TIV-weighted share/i),
    ).toBeInTheDocument();
  });

  // Task 18 — ARIA on action color swatches for screen readers.
  test('action swatches have aria-labels', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 3_500_000, policy_count: 5 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} optimization={makeOptimization()} />);
    const swatches = screen.getAllByRole('img');
    expect(
      swatches.some((s) => s.getAttribute('aria-label')?.toLowerCase().includes('retain')),
    ).toBe(true);
  });

  // Bubbles must be plotted at the policy-derived centroids passed in via
  // `zip3Centroids` — not a hand-coded table. Guards the /portfolio vs
  // /simulate map agreement fixed by lib/db/zip3_centroids.ts.
  test('plots ZIP3 bubbles at the provided policy-derived centroids', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 3_500_000, policy_count: 5 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 500_000, policy_count: 10 }),
    ];
    // [lon, lat] as zip3Centroids() returns them from the live policy book.
    const centroids: Record<string, [number, number]> = {
      '330': [-82.04, 27.91],
      '770': [-95.13, 29.48],
    };
    render(<PortfolioMap cohorts={cohorts} zip3Centroids={centroids} />);

    const zipSource = screen
      .getAllByTestId('map-source')
      .find((el) => el.getAttribute('data-source-id') === 'zip3-points');
    expect(zipSource).toBeDefined();

    const fc = JSON.parse(zipSource!.getAttribute('data-geojson') ?? '{}') as {
      features: {
        properties: { zip3: string };
        geometry: { coordinates: [number, number] };
      }[];
    };
    const byZip: Record<string, [number, number]> = {};
    for (const f of fc.features) byZip[f.properties.zip3] = f.geometry.coordinates;

    expect(byZip['330']).toEqual([-82.04, 27.91]);
    expect(byZip['770']).toEqual([-95.13, 29.48]);
  });

  // Task P2.20 — single-pane is the default mount mode so the existing page
  // render stays unchanged.
  test('renders single-pane by default (one map shell)', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 3_500_000, policy_count: 5 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} optimization={makeOptimization()} />);
    expect(screen.getAllByTestId('map-base-stub')).toHaveLength(1);
    // The compare toggle button is present and labelled.
    expect(
      screen.getByRole('button', { name: /compare current vs recommended/i }),
    ).toBeInTheDocument();
  });

  // Task P2.20 — clicking the compare toggle reveals the second pane.
  test('toggle splits to dual-pane (two map shells, two pane regions)', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 3_500_000, policy_count: 5 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} optimization={makeOptimization()} />);
    fireEvent.click(
      screen.getByRole('button', { name: /compare current vs recommended/i }),
    );
    expect(screen.getAllByTestId('map-base-stub')).toHaveLength(2);
    expect(screen.getByTestId('portfolio-pane-current')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-pane-recommended')).toBeInTheDocument();
  });

  // Task P2.20 — hovering a cohort in the left pane sets shared state so the
  // matching cohort in the right pane is flagged as hovered too.
  test('hovering a cohort in the left pane highlights the same cohort in the right', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 3_500_000, policy_count: 5 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} optimization={makeOptimization()} />);
    fireEvent.click(
      screen.getByRole('button', { name: /compare current vs recommended/i }),
    );

    const currentPane = screen.getByTestId('portfolio-pane-current');
    const recommendedPane = screen.getByTestId('portfolio-pane-recommended');

    // Find the keyboard-list button for ZIP3 770 inside the current pane and
    // fire mouseEnter on it. The same ZIP3 in the other pane should report
    // `data-hovered="true"`.
    const leftZip770 = within(currentPane).getByRole('button', {
      name: /ZIP3 770/i,
    });
    fireEvent.mouseEnter(leftZip770);

    const rightZip770 = within(recommendedPane).getByRole('button', {
      name: /ZIP3 770/i,
    });
    expect(rightZip770.getAttribute('data-hovered')).toBe('true');

    const rightZip330 = within(recommendedPane).getByRole('button', {
      name: /ZIP3 330/i,
    });
    expect(rightZip330.getAttribute('data-hovered')).toBe('false');

    // And the hover clears on mouseLeave.
    fireEvent.mouseLeave(leftZip770);
    expect(rightZip770.getAttribute('data-hovered')).toBe('false');
  });

  // Task P2.20 — the right pane uses the MIP dominant_action color; the left
  // pane is the neutral "current" color (every cohort is retained today).
  test('right pane colors cohorts by dominant_action; current pane does not', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', total_tiv: 3_500_000, policy_count: 5 }),
      cohort({ id: '770_wood_frame_q2', zip3: '770', total_tiv: 500_000, policy_count: 10 }),
    ];
    render(<PortfolioMap cohorts={cohorts} optimization={makeOptimization()} />);
    fireEvent.click(
      screen.getByRole('button', { name: /compare current vs recommended/i }),
    );

    const currentPane = screen.getByTestId('portfolio-pane-current');
    const recommendedPane = screen.getByTestId('portfolio-pane-recommended');

    // ZIP3 770 has dominant_action = reprice_p10 in the fixture (post-P2.8
    // rate-grid); the recommended pane should color its row accordingly
    // while the current pane stays in the neutral "retain" color.
    const leftZip770 = within(currentPane).getByRole('button', {
      name: /ZIP3 770/i,
    });
    const rightZip770 = within(recommendedPane).getByRole('button', {
      name: /ZIP3 770/i,
    });
    expect(leftZip770.getAttribute('data-action')).toBe('retain');
    expect(rightZip770.getAttribute('data-action')).toBe('reprice_p10');
    expect(leftZip770.getAttribute('data-color')).not.toBe(
      rightZip770.getAttribute('data-color'),
    );
  });
});

describe('PortfolioDrillDown', () => {
  test('renders cohorts for the selected ZIP3', () => {
    const cohorts: Cohort[] = [
      cohort({ id: '330_wood_frame_q0', zip3: '330', policy_count: 7, total_tiv: 3_500_000 }),
      cohort({ id: '330_masonry_q2', zip3: '330', policy_count: 4, total_tiv: 1_200_000 }),
    ];
    render(<PortfolioDrillDown zip3="330" cohorts={cohorts} onClose={() => {}} />);

    expect(screen.getByText('ZIP3 330')).toBeInTheDocument();
    // 7 + 4 = 11 policies in the selected ZIP3.
    expect(screen.getByText('Policies: 11')).toBeInTheDocument();
    // Each cohort id should appear in the table.
    expect(screen.getByText('330_wood_frame_q0')).toBeInTheDocument();
    expect(screen.getByText('330_masonry_q2')).toBeInTheDocument();
  });
});
