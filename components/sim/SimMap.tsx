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
 * Task 20: SimMap + SimWorkspace.
 */
import { useEffect, useRef, useState } from 'react';
import Map, { type MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDrawForPeril, PERIL_MODES } from '@/lib/sim/draw';
import { buildFootprint, bufferTornadoSwath } from '@/lib/sim/footprint';
import { DrawToolbar } from './DrawToolbar';
import { IntensityStrip } from './IntensityStrip';
import type { SimulationFootprint } from '@/lib/sim/footprint';
import type { Peril, Intensity } from '@/lib/sim/severity';
import type { TerraDraw } from 'terra-draw';

// terra-draw's FeatureId is string | number (not re-exported from the main barrel).
type FeatureId = string | number;

export interface SimMapProps {
  peril: Peril;
  intensity: Intensity;
  onIntensityChange: (i: Intensity) => void;
  effectiveDate: string;
  onEffectiveDateChange: (d: string) => void;
  onFootprintChange: (fp: SimulationFootprint) => void;
}

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

export function SimMap(props: SimMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  // Capture latest props in a ref so the finish callback doesn't capture stale closure values.
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);

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
      />
      <DrawToolbar
        peril={props.peril}
        onUndo={handleUndo}
        onClear={handleClear}
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
