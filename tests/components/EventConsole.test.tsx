/**
 * Task 21 — EventConsole rendering.
 *
 * react-map-gl is stubbed so the component mounts in jsdom (no WebGL). We
 * assert on the floating summary card — that's the load-bearing piece for
 * operators glancing at the page, and it's the only DOM we own in the map
 * column. Children of the stubbed Map render flat, so the cone Source and
 * fire-points Source both materialize as test-id nodes.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Stub react-map-gl/mapbox so children mount as plain divs in jsdom.
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
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));

// Force the Mapbox-rendered branch so the summary card mounts on top.
process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test.token';

import { EventConsole } from '@/components/EventConsole';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';

afterEach(() => cleanup());

function makeCone(): FetchNhcConeResult {
  return {
    cone: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    advisory_number: '14A',
    peak_wind: 115,
    source: 'mock',
  };
}

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
});
