'use client';
/**
 * Task 19 — MapLibre base component.
 *
 * Thin wrapper around `react-map-gl/maplibre` rendering OpenFreeMap vector
 * tiles. No API key required. Forwards children so callers can compose
 * `<Source />` / `<Layer />` declaratively.
 */
import Map, { type MapMouseEvent } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapBaseProps {
  children?: React.ReactNode;
  initialViewState?: { longitude: number; latitude: number; zoom: number };
  style?: React.CSSProperties;
  interactiveLayerIds?: string[];
  onClick?: (e: MapMouseEvent) => void;
  /**
   * Task P2.20 — forwarded so the Portfolio Map can drive a shared hover
   * state across two synchronized panes. Receives the same MapLibre move
   * event; callers typically inspect `e.features?.[0]?.properties` to find
   * the hovered feature.
   */
  onMouseMove?: (e: MapMouseEvent) => void;
}

const DEFAULT_VIEW = { longitude: -82.5, latitude: 28.5, zoom: 5 };
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

export function MapBase({
  children,
  initialViewState,
  style,
  interactiveLayerIds,
  onClick,
  onMouseMove,
}: MapBaseProps) {
  return (
    <Map
      initialViewState={initialViewState ?? DEFAULT_VIEW}
      style={{ width: '100%', height: '100%', ...style }}
      mapStyle={MAP_STYLE}
      interactiveLayerIds={interactiveLayerIds}
      onClick={onClick}
      onMouseMove={onMouseMove}
    >
      {children}
    </Map>
  );
}
