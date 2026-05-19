/**
 * terra-draw adapter factory. Pass a MapLibre map instance and a peril;
 * returns a configured TerraDraw instance ready to start. The caller is
 * responsible for `draw.start()` / `draw.stop()` lifecycle and for
 * subscribing to the `finish` event to read out the drawn feature.
 *
 * Task 14.
 */
import { TerraDraw } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { modeFactoriesForPeril, PERIL_MODES } from './modes';
import type { Peril } from '@/lib/sim/severity';

export function createDrawForPeril(map: MapLibreMap, peril: Peril): TerraDraw {
  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: modeFactoriesForPeril(peril),
  });
  return draw;
}

export { PERIL_MODES };
