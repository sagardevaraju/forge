/**
 * Task 21 — EventConsole rendering.
 * Task P2.21 — Cone-vs-outside book exposure mini-map assertions.
 *
 * react-map-gl is stubbed so the component mounts in jsdom (no WebGL). We
 * assert on the floating summary card — that's the load-bearing piece for
 * operators glancing at the page, and it's the only DOM we own in the map
 * column. Children of the stubbed Map render flat, so the cone Source and
 * fire-points Source both materialize as test-id nodes.
 *
 * The component imports `react-map-gl/maplibre`; we mock both that entry and
 * the legacy `react-map-gl/mapbox` so the file is resilient against a future
 * rebase that flips the renderer back.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';

// Stub react-map-gl/maplibre (current renderer) AND the legacy
// /mapbox entry so children mount as plain divs in jsdom. vi.mock factories
// are hoisted to the top of the file before any imports run, so the stub
// has to be inlined per call (no shared `const` — vitest errors on access
// before initialization).
vi.mock('react-map-gl/maplibre', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="map-base-stub">{children}</div>
  ),
  Source: ({ id, children }: { id: string; children?: React.ReactNode }) => (
    <div data-testid={`source-${id}`}>{children}</div>
  ),
  Layer: ({ id }: { id: string }) => <div data-testid={`layer-${id}`} />,
}));
vi.mock('react-map-gl/mapbox', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="map-base-stub">{children}</div>
  ),
  Source: ({ id, children }: { id: string; children?: React.ReactNode }) => (
    <div data-testid={`source-${id}`}>{children}</div>
  ),
  Layer: ({ id }: { id: string }) => <div data-testid={`layer-${id}`} />,
}));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));

// Force the Mapbox-rendered branch so the summary card mounts on top.
process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test.token';

import { EventConsole } from '@/components/EventConsole';
import type { ConeExposureCohort } from '@/components/ConeExposureBars';
import { pointInPolygon } from '@/lib/geo/point_in_polygon';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';

afterEach(() => cleanup());

function makeCone(): FetchNhcConeResult {
  return {
    cone: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    advisory_number: '14A',
    peak_wind: 115,
    prior_peak_wind: 108,
    prior_cones: [],
    source: 'mock',
  };
}

/**
 * A wide rectangular cone covering most of Florida (lon -83..-79.5, lat
 * 24.5..31). Paired with TEST_CENTROIDS below, the FL cohort ZIP3s land
 * INSIDE and the NC ZIP3s land OUTSIDE — a clean "inside vs outside"
 * partition the assertions can rely on.
 */
function floridaCone(): FetchNhcConeResult {
  return {
    cone: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-83.0, 24.5],
            [-79.5, 24.5],
            [-79.5, 31.0],
            [-83.0, 31.0],
            [-83.0, 24.5],
          ],
        ],
      },
    },
    advisory_number: '14A',
    peak_wind: 115,
    prior_peak_wind: 108,
    prior_cones: [],
    source: 'mock',
  };
}

/**
 * Per-ZIP3 [lon, lat] centroids for the cone-exposure tests — the prop
 * EventConsole forwards to the mini-map. In production these come from
 * lib/db/zip3_centroids.ts (mean policy lat/lon per ZIP3); here they are
 * chosen so FL ZIP3s sit inside floridaCone() and NC ZIP3s sit outside.
 */
const TEST_CENTROIDS: Record<string, [number, number]> = {
  '330': [-82.0, 28.0], '335': [-82.3, 27.9], '339': [-81.8, 26.6],
  '275': [-78.6, 35.8], '280': [-80.8, 35.2], '281': [-80.8, 35.3],
  '282': [-82.5, 35.6], '283': [-78.9, 34.2], '284': [-77.9, 34.2],
  '285': [-77.0, 35.6],
};

describe('EventConsole', () => {
  test('renders the storm summary banner when a cone is provided', () => {
    render(
      <EventConsole
        cone={makeCone()}
        fires={[
          { lat: 28.1, lon: -82.3, brightness: 320, confidence: 'h', acq_time: 'x' },
          { lat: 28.5, lon: -82.0, brightness: 305, confidence: 'n', acq_time: 'y' },
        ]}
      />,
    );
    const card = screen.getByTestId('event-summary');
    expect(card).toHaveTextContent('Storm: 14A');
    expect(card).toHaveTextContent('Peak wind: 115 mph');
    expect(card).toHaveTextContent('2 active fires nearby');
    // Both data layers wired through the stub:
    expect(screen.getByTestId('source-cone')).toBeInTheDocument();
    expect(screen.getByTestId('source-fires')).toBeInTheDocument();
  });

  test('renders without crashing when cone is null and shows no summary card', () => {
    render(<EventConsole cone={null} fires={[]} />);
    expect(screen.queryByTestId('event-summary')).not.toBeInTheDocument();
    // The map shell still mounts so the panel area is laid out.
    expect(screen.getByTestId('map-base-stub')).toBeInTheDocument();
    // Sub-panels render regardless of cone availability.
    expect(screen.getByTestId('agent-chat')).toBeInTheDocument();
    expect(screen.getByTestId('sitrep-panel')).toBeInTheDocument();
  });

  test('renders TrustTierBadge for source', () => {
    const liveCone: FetchNhcConeResult = { ...makeCone(), source: 'live' };
    render(<EventConsole cone={liveCone} fires={[]} />);
    // The summary card carries the cone-source badge; the mini-map carries
    // its own MODEL_OUTPUT badge. Scope to the summary card so we don't
    // collide with the exposure-bars badge.
    const card = screen.getByTestId('event-summary');
    expect(within(card).getByTestId('trust-tier-badge')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Task P2.22 — multi-advisory ribbon. Prior advisories render as faint
  // outlines under the current cone. Each one gets its own Source so the
  // stubbed Layer ids let us assert on it.
  // -------------------------------------------------------------------------

  test('renders prior cones as faint outlines under the current cone (Task P2.22)', () => {
    const coneWithPriors: FetchNhcConeResult = {
      ...makeCone(),
      prior_cones: [
        {
          advisory_number: 13,
          issued_at: '2026-05-16T18:00:00Z',
          cone: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[0.2, 0], [1.2, 0], [1.2, 1], [0.2, 0]]] },
          },
        },
        {
          advisory_number: 12,
          issued_at: '2026-05-16T12:00:00Z',
          cone: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[0.4, 0], [1.4, 0], [1.4, 1], [0.4, 0]]] },
          },
        },
        {
          advisory_number: 11,
          issued_at: '2026-05-16T06:00:00Z',
          cone: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[0.6, 0], [1.6, 0], [1.6, 1], [0.6, 0]]] },
          },
        },
      ],
    };
    render(<EventConsole cone={coneWithPriors} fires={[]} />);
    // Current cone source still renders.
    expect(screen.getByTestId('source-cone')).toBeInTheDocument();
    // One Source per prior advisory, keyed by advisory_number so we can pin them.
    expect(screen.getByTestId('source-prior-cone-13')).toBeInTheDocument();
    expect(screen.getByTestId('source-prior-cone-12')).toBeInTheDocument();
    expect(screen.getByTestId('source-prior-cone-11')).toBeInTheDocument();
    // Each prior advisory renders ONLY a line layer (faint outline, no fill).
    // The stub renders Layer ids as `layer-${id}` test ids.
    expect(screen.getByTestId('layer-prior-cone-line-13')).toBeInTheDocument();
    expect(screen.getByTestId('layer-prior-cone-line-12')).toBeInTheDocument();
    expect(screen.getByTestId('layer-prior-cone-line-11')).toBeInTheDocument();
    // No fill layer for priors — the ribbon is outlines-only by design.
    expect(screen.queryByTestId('layer-prior-cone-fill-13')).not.toBeInTheDocument();
    expect(screen.queryByTestId('layer-prior-cone-fill-12')).not.toBeInTheDocument();
    expect(screen.queryByTestId('layer-prior-cone-fill-11')).not.toBeInTheDocument();
    // A legend strip surfaces the advisory numbers so operators can read them.
    const legend = screen.getByTestId('advisory-ribbon-legend');
    expect(legend).toHaveTextContent('#13');
    expect(legend).toHaveTextContent('#12');
    expect(legend).toHaveTextContent('#11');
  });

  test('empty prior_cones array renders single-cone behavior (regression guard, Task P2.22)', () => {
    const coneNoPriors: FetchNhcConeResult = { ...makeCone(), prior_cones: [] };
    render(<EventConsole cone={coneNoPriors} fires={[]} />);
    // Current cone still rendered.
    expect(screen.getByTestId('source-cone')).toBeInTheDocument();
    // No prior cone sources, no legend strip.
    expect(screen.queryByTestId('advisory-ribbon-legend')).not.toBeInTheDocument();
    // Spot-check a couple of advisory ids that should NOT appear.
    expect(screen.queryByTestId('source-prior-cone-13')).not.toBeInTheDocument();
    expect(screen.queryByTestId('source-prior-cone-12')).not.toBeInTheDocument();
  });

  test('undefined prior_cones is tolerated (legacy callers, Task P2.22)', () => {
    // Callers built before P2.22 may not set prior_cones at all. The
    // component must treat that as "no priors" rather than throwing.
    const coneLegacy = makeCone() as FetchNhcConeResult;
    // @ts-expect-error — deliberately strip the field to mimic legacy shape.
    delete coneLegacy.prior_cones;
    render(<EventConsole cone={coneLegacy} fires={[]} />);
    expect(screen.getByTestId('source-cone')).toBeInTheDocument();
    expect(screen.queryByTestId('advisory-ribbon-legend')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Task P2.23 — cone uncertainty envelope (GEFS perturbation hull).
  // -------------------------------------------------------------------------

  test('renders 3 envelope polygons UNDER prior cones and current cone (Task P2.23)', () => {
    // A current cone with the envelope payload attached. The envelope
    // sources must mount, AND they must render before the priors and the
    // current cone in DOM order so MapLibre paints them at the bottom of
    // the stack.
    const envelopePoly = (offset: number): GeoJSON.Polygon => ({
      type: 'Polygon',
      coordinates: [
        [
          [-83 - offset, 24 - offset],
          [-79 + offset, 24 - offset],
          [-79 + offset, 31 + offset],
          [-83 - offset, 31 + offset],
          [-83 - offset, 24 - offset],
        ],
      ],
    });
    const coneWithEnvelope: FetchNhcConeResult = {
      ...makeCone(),
      prior_cones: [
        {
          advisory_number: 13,
          issued_at: '2026-05-16T18:00:00Z',
          cone: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[0.2, 0], [1.2, 0], [1.2, 1], [0.2, 0]]] },
          },
        },
      ],
      cone_envelope: {
        t24h: envelopePoly(0.5),
        t48h: envelopePoly(1.0),
        t72h: envelopePoly(1.5),
      },
    } as FetchNhcConeResult & {
      cone_envelope: {
        t24h: GeoJSON.Polygon;
        t48h: GeoJSON.Polygon;
        t72h: GeoJSON.Polygon;
      };
    };
    const { container } = render(<EventConsole cone={coneWithEnvelope} fires={[]} />);
    // Three envelope sources mount, one per horizon.
    const env24 = screen.getByTestId('source-cone-envelope-t24h');
    const env48 = screen.getByTestId('source-cone-envelope-t48h');
    const env72 = screen.getByTestId('source-cone-envelope-t72h');
    expect(env24).toBeInTheDocument();
    expect(env48).toBeInTheDocument();
    expect(env72).toBeInTheDocument();
    // Fill layers materialize (the envelope is rendered as semi-transparent fills).
    expect(screen.getByTestId('layer-cone-envelope-t24h-fill')).toBeInTheDocument();
    expect(screen.getByTestId('layer-cone-envelope-t48h-fill')).toBeInTheDocument();
    expect(screen.getByTestId('layer-cone-envelope-t72h-fill')).toBeInTheDocument();
    // Layer-stack order check: all three envelope sources must appear in
    // the DOM before the prior-cone source and the current-cone source.
    // MapLibre paints in DOM order, so this is the regression guard that
    // the envelope sits at the bottom of the stack.
    const allSources = Array.from(
      container.querySelectorAll('[data-testid^="source-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    const idxEnv72 = allSources.indexOf('source-cone-envelope-t72h');
    const idxEnv48 = allSources.indexOf('source-cone-envelope-t48h');
    const idxEnv24 = allSources.indexOf('source-cone-envelope-t24h');
    const idxPrior = allSources.indexOf('source-prior-cone-13');
    const idxCurrent = allSources.indexOf('source-cone');
    expect(idxEnv72).toBeGreaterThanOrEqual(0);
    expect(idxEnv48).toBeGreaterThanOrEqual(0);
    expect(idxEnv24).toBeGreaterThanOrEqual(0);
    expect(idxPrior).toBeGreaterThanOrEqual(0);
    expect(idxCurrent).toBeGreaterThanOrEqual(0);
    // Envelopes paint first — all three before any prior or the current cone.
    expect(idxEnv72).toBeLessThan(idxPrior);
    expect(idxEnv48).toBeLessThan(idxPrior);
    expect(idxEnv24).toBeLessThan(idxPrior);
    expect(idxEnv72).toBeLessThan(idxCurrent);
    expect(idxEnv48).toBeLessThan(idxCurrent);
    expect(idxEnv24).toBeLessThan(idxCurrent);
  });

  test('no envelope renders when cone_envelope is missing (regression-safe, Task P2.23)', () => {
    // Plain cone with no cone_envelope field — legacy P2.22-era result
    // shape. The component must not throw and must not mount the envelope
    // sources.
    render(<EventConsole cone={makeCone()} fires={[]} />);
    expect(screen.queryByTestId('source-cone-envelope-t24h')).not.toBeInTheDocument();
    expect(screen.queryByTestId('source-cone-envelope-t48h')).not.toBeInTheDocument();
    expect(screen.queryByTestId('source-cone-envelope-t72h')).not.toBeInTheDocument();
    // Current cone still renders as the headline.
    expect(screen.getByTestId('source-cone')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task P2.21 — Cone-vs-outside book exposure mini-map.
// ---------------------------------------------------------------------------

describe('EventConsole · cone exposure mini-map', () => {
  test('renders the two bars when a valid cone + cohorts are provided', () => {
    // 3 FL cohorts (inside the Florida cone) + 7 NC cohorts (outside).
    const cohorts: ConeExposureCohort[] = [
      { id: 'fl-1', zip3: '330', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'fl-2', zip3: '335', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'fl-3', zip3: '339', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-1', zip3: '275', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-2', zip3: '280', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-3', zip3: '281', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-4', zip3: '282', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-5', zip3: '283', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-6', zip3: '284', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-7', zip3: '285', total_tiv: 1_000_000, policy_count: 1 },
    ];
    render(
      <EventConsole
        cone={floridaCone()}
        fires={[]}
        cohorts={cohorts}
        zip3Centroids={TEST_CENTROIDS}
      />,
    );
    expect(screen.getByTestId('cone-exposure-bars')).toBeInTheDocument();
    expect(screen.getByTestId('cone-exposure-row-inside')).toBeInTheDocument();
    expect(screen.getByTestId('cone-exposure-row-outside')).toBeInTheDocument();
    expect(screen.getByTestId('cone-exposure-inside-fill')).toBeInTheDocument();
    expect(screen.getByTestId('cone-exposure-outside-fill')).toBeInTheDocument();
  });

  test('inside ratio sums correctly (3 inside / 7 outside ⇒ 30% by count)', () => {
    const cohorts: ConeExposureCohort[] = [
      // 3 FL cohorts ⇒ inside.
      { id: 'fl-1', zip3: '330', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'fl-2', zip3: '335', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'fl-3', zip3: '339', total_tiv: 1_000_000, policy_count: 1 },
      // 7 NC cohorts ⇒ outside.
      { id: 'nc-1', zip3: '275', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-2', zip3: '280', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-3', zip3: '281', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-4', zip3: '282', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-5', zip3: '283', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-6', zip3: '284', total_tiv: 1_000_000, policy_count: 1 },
      { id: 'nc-7', zip3: '285', total_tiv: 1_000_000, policy_count: 1 },
    ];
    render(
      <EventConsole
        cone={floridaCone()}
        fires={[]}
        cohorts={cohorts}
        zip3Centroids={TEST_CENTROIDS}
      />,
    );
    const insideLabel = screen.getByTestId('cone-exposure-inside-label');
    const outsideLabel = screen.getByTestId('cone-exposure-outside-label');
    // 3 of 10 inside ⇒ 30% by count, also 30% by TIV since each cohort is $1M.
    expect(insideLabel.getAttribute('data-inside-count')).toBe('3');
    expect(outsideLabel.getAttribute('data-outside-count')).toBe('7');
    expect(insideLabel).toHaveTextContent('30%');
    expect(outsideLabel).toHaveTextContent('70%');
  });

  test('inside TIV is computed from total_tiv, not count', () => {
    // 1 inside cohort with $9M, 1 outside with $1M ⇒ 90% TIV inside but 50%
    // by count. The headline must surface the TIV ratio.
    const cohorts: ConeExposureCohort[] = [
      { id: 'fl-big', zip3: '330', total_tiv: 9_000_000, policy_count: 1 },
      { id: 'nc-small', zip3: '275', total_tiv: 1_000_000, policy_count: 1 },
    ];
    render(
      <EventConsole
        cone={floridaCone()}
        fires={[]}
        cohorts={cohorts}
        zip3Centroids={TEST_CENTROIDS}
      />,
    );
    const insideLabel = screen.getByTestId('cone-exposure-inside-label');
    expect(insideLabel.getAttribute('data-inside-tiv')).toBe('9000000');
    expect(insideLabel.getAttribute('data-inside-count')).toBe('1');
    // 50% by count, 90% by TIV — assert TIV is what the visible label shows.
    expect(insideLabel).toHaveTextContent('90%');
    expect(insideLabel).toHaveTextContent('$9'); // dollar value rendered in millions
  });

  test('empty cone renders the "select a storm" placeholder', () => {
    const cohorts: ConeExposureCohort[] = [
      { id: 'fl-1', zip3: '330', total_tiv: 1_000_000, policy_count: 1 },
    ];
    render(<EventConsole cone={null} fires={[]} cohorts={cohorts} />);
    expect(screen.getByTestId('cone-exposure-empty-cone')).toBeInTheDocument();
    expect(screen.queryByTestId('cone-exposure-bars')).not.toBeInTheDocument();
  });

  test('empty cohorts renders the "no book loaded" placeholder', () => {
    render(<EventConsole cone={floridaCone()} fires={[]} cohorts={[]} />);
    expect(screen.getByTestId('cone-exposure-empty-cohorts')).toBeInTheDocument();
    expect(screen.queryByTestId('cone-exposure-bars')).not.toBeInTheDocument();
  });

  test('point-in-polygon utility correctly classifies a unit square', () => {
    // Unit square [0,1] x [0,1] as a GeoJSON Polygon outer ring.
    const square = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    expect(pointInPolygon([0.5, 0.5], square)).toBe(true); // center → inside
    expect(pointInPolygon([0.1, 0.9], square)).toBe(true); // near corner → inside
    expect(pointInPolygon([1.5, 0.5], square)).toBe(false); // east of square
    expect(pointInPolygon([-0.1, 0.5], square)).toBe(false); // west of square
    // Edge case: cone polygon === null short-circuits to false rather than
    // throwing — callers pass through the unparsed cone payload.
    expect(pointInPolygon([0.5, 0.5], null)).toBe(false);
  });

  test('cone polygon boundary classification is deterministic across runs', () => {
    // Pick a polygon and a point such that ray-casting hits an edge crossing
    // event ambiguously. Whatever the classification is, it must be the same
    // value on every call. We assert the function is deterministic by calling
    // it multiple times and confirming the boolean does not flip.
    const triangle = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [1, 2],
          [0, 0],
        ],
      ],
    };
    // Point exactly on the top-vertex's y-coordinate, x straddling the apex.
    const boundaryPoint: [number, number] = [1, 0]; // on the bottom edge
    const v1 = pointInPolygon(boundaryPoint, triangle);
    const v2 = pointInPolygon(boundaryPoint, triangle);
    const v3 = pointInPolygon(boundaryPoint, triangle);
    expect(v2).toBe(v1);
    expect(v3).toBe(v1);
  });
});
