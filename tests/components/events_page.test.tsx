/**
 * Task P2.23 — wire the GEFS cone-uncertainty envelope through /events.
 *
 * The envelope is produced by `generate_scenarios` and rendered inside
 * EventConsole's map column, but the page is the join point: it has to
 * call both tools in parallel and merge the envelope onto the cone prop.
 * Pre-fix, the page never invoked `generate_scenarios` at all and the
 * orange band silently went missing on the live route.
 *
 * Strategy: mock the agent tool handlers + `aggregateCohorts` + the
 * `EventConsole` component itself. The mocked EventConsole simply
 * serializes whatever cone it received into a hidden DOM node so the
 * test can assert on the cone's `cone_envelope` shape directly without
 * mounting react-map-gl in jsdom.
 *
 * Two cases are covered:
 *   1. happy path — both tools succeed; envelope reaches EventConsole.
 *   2. scenarios tool fails — page still renders, `cone_envelope` is
 *      null (best-effort), and the cone prop is still non-null.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const fetchNhcConeHandler = vi.fn();
const fetchFirmsFiresHandler = vi.fn();
const generateScenariosHandler = vi.fn();
const aggregateCohortsMock = vi.fn();
const eventConsoleSpy = vi.fn();

vi.mock('@/app/api/agent/tools/fetch_nhc_cone', () => ({
  fetchNhcCone: { handler: (...args: unknown[]) => fetchNhcConeHandler(...args) },
}));
vi.mock('@/app/api/agent/tools/fetch_firms_fires', () => ({
  fetchFirmsFires: { handler: (...args: unknown[]) => fetchFirmsFiresHandler(...args) },
}));
vi.mock('@/app/api/agent/tools/generate_scenarios', () => ({
  generateScenarios: { handler: (...args: unknown[]) => generateScenariosHandler(...args) },
}));
vi.mock('@/lib/db/cohorts', () => ({
  aggregateCohorts: (...args: unknown[]) => aggregateCohortsMock(...args),
}));

// The real EventConsole pulls in react-map-gl, which needs WebGL. Stub it
// to a div that captures the cone prop on a spy so the assertion can read
// the merged envelope directly.
vi.mock('@/components/EventConsole', () => ({
  EventConsole: (props: { cone: unknown; fires: unknown; cohorts: unknown }) => {
    eventConsoleSpy(props);
    return (
      <div
        data-testid="event-console-stub"
        data-cone={JSON.stringify(props.cone)}
      />
    );
  },
}));

// ThreatBanner is a server-safe presentational component, but we stub it
// too so the test doesn't have to set up its grammar-tier dependencies.
vi.mock('@/components/grammar/ThreatBanner', () => ({
  ThreatBanner: () => <div data-testid="threat-banner-stub" />,
}));

import EventsPage from '@/app/events/page';

afterEach(() => {
  cleanup();
  fetchNhcConeHandler.mockReset();
  fetchFirmsFiresHandler.mockReset();
  generateScenariosHandler.mockReset();
  aggregateCohortsMock.mockReset();
  eventConsoleSpy.mockReset();
});

function makeCone() {
  return {
    cone: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    },
    advisory_number: '14A',
    peak_wind: 115,
    prior_peak_wind: 108,
    prior_cones: [],
    source: 'mock',
  };
}

function makeEnvelope() {
  // Three identical square hulls — the geometry detail isn't load-bearing
  // for this test, only that the field flows through.
  const ring: number[][] = [
    [-83, 25],
    [-81, 25],
    [-81, 27],
    [-83, 27],
    [-83, 25],
  ];
  const poly = { type: 'Polygon' as const, coordinates: [ring] };
  return { t24h: poly, t48h: poly, t72h: poly };
}

describe('EventsPage — P2.23 cone envelope wiring', () => {
  test('merges cone_envelope from generate_scenarios onto the cone prop', async () => {
    fetchNhcConeHandler.mockResolvedValue(makeCone());
    fetchFirmsFiresHandler.mockResolvedValue([]);
    aggregateCohortsMock.mockResolvedValue([]);
    const envelope = makeEnvelope();
    generateScenariosHandler.mockResolvedValue({
      scenarios: [],
      cone_envelope: envelope,
    });

    const ui = await EventsPage();
    render(ui);

    // The page must have called generate_scenarios with the demo storm.
    expect(generateScenariosHandler).toHaveBeenCalledTimes(1);
    const args = generateScenariosHandler.mock.calls[0][0] as {
      storm_id: string;
      n?: number;
    };
    expect(args.storm_id).toBe('AL092024');

    // EventConsole received a non-null cone whose `cone_envelope` matches.
    expect(eventConsoleSpy).toHaveBeenCalledTimes(1);
    const passed = eventConsoleSpy.mock.calls[0][0] as {
      cone: { cone_envelope?: unknown } | null;
    };
    expect(passed.cone).not.toBeNull();
    expect(passed.cone?.cone_envelope).toEqual(envelope);

    // And the serialized DOM marker carries the envelope too.
    const stub = screen.getByTestId('event-console-stub');
    const cone = JSON.parse(stub.getAttribute('data-cone') ?? 'null');
    expect(cone?.cone_envelope?.t24h?.type).toBe('Polygon');
  });

  test('page still renders when generate_scenarios throws (envelope falls back to null)', async () => {
    fetchNhcConeHandler.mockResolvedValue(makeCone());
    fetchFirmsFiresHandler.mockResolvedValue([]);
    aggregateCohortsMock.mockResolvedValue([]);
    generateScenariosHandler.mockRejectedValue(new Error('boom'));

    const ui = await EventsPage();
    render(ui);

    // EventConsole still mounts; cone is non-null; envelope is null
    // because the tool failed.
    const passed = eventConsoleSpy.mock.calls[0][0] as {
      cone: { cone_envelope?: unknown } | null;
    };
    expect(passed.cone).not.toBeNull();
    expect(passed.cone?.cone_envelope).toBeNull();
  });
});
