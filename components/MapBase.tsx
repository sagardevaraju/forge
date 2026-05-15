'use client';
/**
 * Task 19 — Mapbox base component.
 *
 * Thin wrapper around `react-map-gl/mapbox` that:
 * - Reads the public Mapbox token from `NEXT_PUBLIC_MAPBOX_TOKEN`.
 * - Renders a graceful fallback panel when the token is missing so that
 *   `/portfolio` still loads in environments where the operator hasn't
 *   provisioned a Mapbox account (CI, fresh clones, autonomous builds).
 * - Forwards children so callers can compose `<Source />` / `<Layer />`
 *   declaratively.
 */
import Map, { type MapMouseEvent } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';

interface MapBaseProps {
  children?: React.ReactNode;
  initialViewState?: { longitude: number; latitude: number; zoom: number };
  style?: React.CSSProperties;
  interactiveLayerIds?: string[];
  onClick?: (e: MapMouseEvent) => void;
}

/** Centered on the Gulf of Mexico to frame the seeded FL/TX/LA book. */
const DEFAULT_VIEW = { longitude: -82.5, latitude: 28.5, zoom: 5 };

export function MapBase({
  children,
  initialViewState,
  style,
  interactiveLayerIds,
  onClick,
}: MapBaseProps) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          background: '#f5f5f5',
          color: '#888',
          ...style,
        }}
      >
        <div style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Map unavailable</div>
          <div style={{ fontSize: 12 }}>
            Set NEXT_PUBLIC_MAPBOX_TOKEN to render. Use a free public token from mapbox.com.
          </div>
        </div>
      </div>
    );
  }
  return (
    <Map
      mapboxAccessToken={token}
      initialViewState={initialViewState ?? DEFAULT_VIEW}
      style={{ width: '100%', height: '100%', ...style }}
      mapStyle="mapbox://styles/mapbox/light-v11"
      interactiveLayerIds={interactiveLayerIds}
      onClick={onClick}
    >
      {children}
    </Map>
  );
}
