/**
 * Task 19 / Task 26 — MapBase renders an OpenFreeMap-styled MapLibre map.
 *
 * jsdom cannot render WebGL, so we stub `react-map-gl/maplibre` to flat divs
 * and assert that:
 *   1. The component mounts without throwing (no token required — the
 *      OpenFreeMap basemap is keyless).
 *   2. The OpenFreeMap style URL is forwarded to the underlying `<Map>`.
 *   3. Children passed in are rendered inside the map shell so callers can
 *      compose `<Source />` / `<Layer />` declaratively.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Stub react-map-gl/maplibre so the component mounts in jsdom (no WebGL).
// The stub captures `mapStyle` as a data attribute so we can assert on it.
vi.mock('react-map-gl/maplibre', () => ({
  __esModule: true,
  default: ({
    children,
    mapStyle,
  }: {
    children?: React.ReactNode;
    mapStyle?: string;
  }) => (
    <div data-testid="map-base-stub" data-map-style={mapStyle}>
      {children}
    </div>
  ),
}));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

import { MapBase } from '@/components/MapBase';

describe('MapBase', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders a MapLibre map with the OpenFreeMap positron style', () => {
    render(
      <MapBase>
        <div data-testid="map-child">child</div>
      </MapBase>,
    );
    const map = screen.getByTestId('map-base-stub');
    expect(map).toBeInTheDocument();
    expect(map.getAttribute('data-map-style')).toBe(
      'https://tiles.openfreemap.org/styles/positron',
    );
    // Children compose inside the map shell.
    expect(screen.getByTestId('map-child')).toBeInTheDocument();
  });
});
