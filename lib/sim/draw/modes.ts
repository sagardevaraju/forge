/**
 * Per-peril terra-draw mode mapping. Each peril uses one or two modes:
 *   tornado    → linestring (centerline; buffered to a polygon on commit)
 *   flood      → polygon (freehand)
 *   hail       → polygon (outer swath) + optional polygon (inner core)
 *   wildfire   → polygon
 *   earthquake → point (epicenter; concentric circles derived from magnitude)
 *   winter     → polygon
 *
 * See spec §4 (drawing toolkit). Task 14.
 */
import {
  TerraDrawPolygonMode,
  TerraDrawLineStringMode,
  TerraDrawPointMode,
  type TerraDrawExtend,
} from 'terra-draw';
import type { Peril } from '@/lib/sim/severity';

export type PerilMode = 'polygon' | 'linestring' | 'point';

export const PERIL_MODES: Record<Peril, PerilMode> = {
  tornado: 'linestring',
  flood: 'polygon',
  hail: 'polygon',
  wildfire: 'polygon',
  earthquake: 'point',
  winter: 'polygon',
};

export function modeFactoriesForPeril(peril: Peril): TerraDrawExtend.TerraDrawBaseDrawMode<any>[] {
  const m = PERIL_MODES[peril];
  if (m === 'polygon') return [new TerraDrawPolygonMode()];
  if (m === 'linestring') return [new TerraDrawLineStringMode()];
  if (m === 'point') return [new TerraDrawPointMode()];
  throw new Error(`unsupported peril mode: ${m}`);
}
