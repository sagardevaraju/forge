'use client';
/**
 * SimMap — owns the TerraDraw lifecycle and emits SimulationFootprint values
 * whenever the operator finishes drawing a shape.
 *
 * Mounts a react-map-gl/maplibre Map, attaches a TerraDraw instance (via the
 * terra-draw-maplibre-gl-adapter), and resets it whenever the active peril
 * changes. The DrawToolbar + IntensityStrip overlays are positioned absolutely
 * inside the map container.
 *
 * Policy overlay: when showPolicies is true, fetches /api/policies/points once
 * (cached in a ref), splits them inside/outside the current footprint using
 * @turf/boolean-point-in-polygon, and renders two MapLibre circle layers:
 *   - inside footprint:  red (#ef4444), rendered BEFORE terra-draw's layer
 *   - outside footprint: gray (#94a3b8), rendered BEFORE terra-draw's layer
 *
 * Task 20: SimMap + SimWorkspace.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Map, { Source, Layer, type MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { createDrawForPeril, PERIL_MODES } from '@/lib/sim/draw';
import { buildFootprint, bufferTornadoSwath } from '@/lib/sim/footprint';
import { DrawToolbar } from './DrawToolbar';
import { IntensityStrip } from './IntensityStrip';
import type { SimulationFootprint } from '@/lib/sim/footprint';
import type { Peril, Intensity } from '@/lib/sim/severity';
import type { TerraDraw } from 'terra-draw';

// terra-draw's FeatureId is string | number (not re-exported from the main barrel).
type FeatureId = string | number;

interface PolicyPoint {
  id: number;
  lat: number;
  lon: number;
  tiv: number;
  build_type: string;
  zip3: string;
}

export interface SimMapProps {
  peril: Peril;
  intensity: Intensity;
  onIntensityChange: (i: Intensity) => void;
  effectiveDate: string;
  onEffectiveDateChange: (d: string) => void;
  onFootprintChange: (fp: SimulationFootprint) => void;
  currentFootprint: SimulationFootprint | null;
}

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

export function SimMap(props: SimMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  // Capture latest props in a ref so the finish callback doesn't capture stale closure values.
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);

  // Policy overlay state.
  const [showPolicies, setShowPolicies] = useState(false);
  const [policies, setPolicies] = useState<PolicyPoint[]>([]);
  const policiesFetchedRef = useRef(false);

  // Fetch policies once when the toggle is first enabled.
  useEffect(() => {
    if (!showPolicies || policiesFetchedRef.current) return;
    policiesFetchedRef.current = true;
    fetch('/api/policies/points')
      .then((r) => r.json())
      .then((body: { policies: PolicyPoint[] }) => {
        setPolicies(body.policies);
      })
      .catch(() => {
        // Silently fail — overlay just stays empty.
      });
  }, [showPolicies]);

  // Split policies into inside/outside the current footprint.
  // Memoized on [policies, currentFootprint] so it doesn't recompute on every render.
  const { insideGeoJSON, outsideGeoJSON } = useMemo(() => {
    const inside: GeoJSON.Feature[] = [];
    const outside: GeoJSON.Feature[] = [];
    for (const p of policies) {
      const feat: GeoJSON.Feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: p.id },
      };
      if (
        props.currentFootprint &&
        booleanPointInPolygon(point([p.lon, p.lat]), {
          type: 'Feature',
          geometry: props.currentFootprint.geometry,
          properties: {},
        })
      ) {
        inside.push(feat);
      } else {
        outside.push(feat);
      }
    }
    const insideGeoJSON: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: inside };
    const outsideGeoJSON: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: outside };
    return { insideGeoJSON, outsideGeoJSON };
  }, [policies, props.currentFootprint]);

  // Recreate the draw instance whenever peril changes (or map first becomes ready).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;

    drawRef.current?.stop();

    const draw = createDrawForPeril(map as Parameters<typeof createDrawForPeril>[0], props.peril);
    draw.start();
    draw.setMode(PERIL_MODES[props.peril]);

    draw.on('finish', (id: FeatureId) => {
      const { peril, intensity, effectiveDate, onFootprintChange } = propsRef.current;
      const snapshot = draw.getSnapshot();
      const feat = snapshot.find((f) => f.id === id);
      if (!feat) return;

      const width_m = peril === 'tornado' ? 200 : undefined;

      let geometry: GeoJSON.Polygon;
      let centerline: GeoJSON.LineString | undefined;

      if (feat.geometry.type === 'LineString' && peril === 'tornado') {
        centerline = feat.geometry as GeoJSON.LineString;
        geometry = bufferTornadoSwath(centerline, width_m!);
      } else if (feat.geometry.type === 'Polygon') {
        geometry = feat.geometry as GeoJSON.Polygon;
      } else {
        // earthquake point handling deferred to v1.1
        return;
      }

      onFootprintChange(
        buildFootprint({
          peril,
          intensity,
          geometry,
          centerline,
          width_m,
          effective_date: effectiveDate,
          drawn_by: 'operator',
        }),
      );
    });

    drawRef.current = draw;
    return () => {
      draw.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.peril, ready]);

  function handleUndo() {
    const snapshot = drawRef.current?.getSnapshot() ?? [];
    const last = snapshot.at(-1);
    if (last?.id != null) {
      drawRef.current?.removeFeatures([last.id as FeatureId]);
    }
  }

  function handleClear() {
    drawRef.current?.clear();
  }

  return (
    <div className="relative w-full h-full">
      <Map
        ref={mapRef}
        initialViewState={{ longitude: -82, latitude: 27.5, zoom: 6 }}
        mapStyle={MAP_STYLE}
        onLoad={() => setReady(true)}
      >
        {/* Policy overlay layers — rendered BEFORE terra-draw's drawing layer
            so the operator can draw on top of the policy dots. */}
        {showPolicies && (
          <>
            <Source id="policies-outside" type="geojson" data={outsideGeoJSON}>
              <Layer
                id="policies-outside-circles"
                type="circle"
                paint={{
                  'circle-radius': 2.5,
                  'circle-color': '#94a3b8',
                  'circle-opacity': 0.7,
                }}
              />
            </Source>
            <Source id="policies-inside" type="geojson" data={insideGeoJSON}>
              <Layer
                id="policies-inside-circles"
                type="circle"
                paint={{
                  'circle-radius': 2.5,
                  'circle-color': '#ef4444',
                  'circle-opacity': 0.7,
                }}
              />
            </Source>
          </>
        )}
      </Map>
      <DrawToolbar
        peril={props.peril}
        onUndo={handleUndo}
        onClear={handleClear}
        showPolicies={showPolicies}
        onTogglePolicies={() => setShowPolicies((v) => !v)}
      />
      <IntensityStrip
        intensity={props.intensity}
        onChange={props.onIntensityChange}
        effectiveDate={props.effectiveDate}
        onDateChange={props.onEffectiveDateChange}
      />
    </div>
  );
}
