'use client';
/**
 * Task P3.23 — State-level choropleth layer for the Portfolio Map.
 *
 * Aggregates the book at state granularity (USPS two-letter codes)
 * and renders one polygon per state, colored by total TIV (log10 scale).
 * Complements the existing bubble layer in PortfolioMap — for books
 * with > ~50 ZIP3s, the bubbles overlap into a single blob and the
 * choropleth gives readable geographic distribution at a glance.
 *
 * Rendering:
 *   - GeoJSON FeatureCollection of US state polygons from
 *     lib/geo/state_topojson.ts. v2 ships real Census cartographic
 *     boundary polygons via us-atlas (Polygon or MultiPolygon per
 *     state — MapLibre handles both natively).
 *   - Paint expression bins log10(total_tiv) into 6 sequential blues
 *     (no exposure → very-light gray; up to ~$10B → dark blue).
 *
 * The component intentionally takes the aggregate set as a prop so
 * the parent route reads it server-side (no client-side DB round-trip
 * on every render).
 */
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { statesFeatureCollection } from '@/lib/geo/state_topojson';
import type { StateAggregate } from '@/lib/db/state_aggregates';

const ZERO_FILL = '#f3f4f6';        // gray-100
const SCALE = [
  '#dbeafe',   // blue-100
  '#bfdbfe',   // blue-200
  '#93c5fd',   // blue-300
  '#60a5fa',   // blue-400
  '#3b82f6',   // blue-500
  '#1e40af',   // blue-800
];

interface Props {
  aggregates: StateAggregate[];
  /** Encoded metric — defaults to `total_tiv`. */
  metric?: 'total_tiv' | 'total_premium' | 'policy_count';
  /** Optional click handler — receives the iso_code of the clicked state. */
  onStateClick?: (isoCode: string) => void;
}

/**
 * Map an iso_code → metric value lookup into a maplibre paint
 * expression. Buckets the log10 of the metric into the 6-color
 * sequential blues. States missing from the aggregates fall back to
 * the ZERO_FILL.
 */
function buildFillPaint(
  aggregates: StateAggregate[],
  metric: NonNullable<Props['metric']>,
): unknown[] {
  const values = aggregates.map((a) => a[metric]).filter((v) => v > 0);
  if (values.length === 0) {
    return ['literal', ZERO_FILL];
  }
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  // 6 equal-width log buckets between minVal and maxVal.
  const logMin = Math.log10(Math.max(minVal, 1));
  const logMax = Math.log10(Math.max(maxVal, 10));
  const stepSize = (logMax - logMin) / SCALE.length;
  const stops: Array<[string, string]> = aggregates.map((a) => {
    const v = a[metric];
    if (!v || v <= 0) return [a.iso_code, ZERO_FILL];
    const lv = Math.log10(v);
    const idx = Math.min(
      SCALE.length - 1,
      Math.max(0, Math.floor((lv - logMin) / Math.max(stepSize, 1e-9))),
    );
    return [a.iso_code, SCALE[idx]!];
  });

  // Build a `match` expression keyed on the iso_code property.
  const expr: unknown[] = ['match', ['get', 'iso_code']];
  for (const [code, color] of stops) {
    expr.push(code, color);
  }
  // Default fallback.
  expr.push(ZERO_FILL);
  return expr;
}

export function PortfolioChoropleth({
  aggregates,
  metric = 'total_tiv',
  onStateClick,
}: Props) {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;
    // OpenFreeMap is the canonical basemap — free, MapLibre-compatible,
    // no token, no metering. Never swap this for a Mapbox URL.
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [-98.0, 39.0],   // continental US center
      zoom: 3,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('states', {
        type: 'geojson',
        data: statesFeatureCollection() as never,
      });
      map.addLayer({
        id: 'states-fill',
        type: 'fill',
        source: 'states',
        paint: {
          'fill-color': buildFillPaint(aggregates, metric) as never,
          'fill-opacity': 0.7,
          'fill-outline-color': '#475569',
        },
      });
      // Click → callback with iso_code (testable through the prop).
      if (onStateClick) {
        map.on('click', 'states-fill', (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const code = f.properties?.iso_code as string | undefined;
          if (code) onStateClick(code);
        });
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [aggregates, metric, onStateClick]);

  // Legend: render a tiny side panel showing the 6 bins.
  const legendBuckets = SCALE.map((color, idx) => (
    <div
      key={idx}
      data-testid={`legend-bucket-${idx}`}
      className="flex items-center gap-1"
    >
      <span
        className="inline-block w-4 h-3 rounded-sm border border-zinc-300"
        style={{ backgroundColor: color }}
      />
      <span className="text-xs text-zinc-700">{`bin ${idx + 1}`}</span>
    </div>
  ));

  return (
    <div
      data-testid="portfolio-choropleth"
      className="relative w-full h-[480px] rounded border border-zinc-200 overflow-hidden"
    >
      <div
        ref={mapContainer}
        data-testid="portfolio-choropleth-map"
        className="absolute inset-0"
      />
      <div
        data-testid="portfolio-choropleth-legend"
        className="absolute bottom-2 right-2 bg-white/95 rounded border border-zinc-300 p-2 flex flex-col gap-1 text-xs"
      >
        <div className="font-medium mb-1">
          {metric === 'total_tiv'
            ? 'Total TIV (log10)'
            : metric === 'total_premium'
              ? 'Total premium (log10)'
              : 'Policy count (log10)'}
        </div>
        {legendBuckets}
      </div>
    </div>
  );
}
