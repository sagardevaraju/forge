/**
 * Shared MapLibre fill / line colour tables for NWS active-alert
 * polygons. Used by both `EventConsole` (full-screen events map) and
 * `PortfolioMapPane` (portfolio exposure map) so the same tornado /
 * flood / severe-thunderstorm visual language reads identically across
 * surfaces. Lifting them out of either component also prevents drift —
 * tweak the tornado red once, both maps update.
 *
 * Colour rationale:
 *   - tornado = red-600 — most acute peril, claims the warmest tone
 *   - flood = blue-600 — water-coded, contrasts with tornado red
 *   - severe_thunderstorm = amber-500 — energetic but not as severe as tornado
 *   - hurricane = dark red-900 — pairs with the NHC cone's existing red palette
 *   - tropical = red-500 — lighter than hurricane to read as "watch level"
 *   - storm_surge = teal-600 — coastal/water-coded, distinct from inland flood
 *   - other = slate-500 — neutral fallback for unrecognised events
 *
 * Line colours are uniformly the darker shade of the fill so each polygon
 * gets a readable border without the line stealing attention from the fill.
 */

export type AlertCategoryKey =
  | 'tornado'
  | 'flood'
  | 'severe_thunderstorm'
  | 'hurricane'
  | 'tropical'
  | 'storm_surge'
  | 'other';

export const ALERT_FILL_COLOR: Record<AlertCategoryKey, string> = {
  tornado: '#dc2626',
  flood: '#2563eb',
  severe_thunderstorm: '#f59e0b',
  hurricane: '#7f1d1d',
  tropical: '#ef4444',
  storm_surge: '#0d9488',
  other: '#64748b',
};

export const ALERT_LINE_COLOR: Record<AlertCategoryKey, string> = {
  tornado: '#7f1d1d',
  flood: '#1e3a8a',
  severe_thunderstorm: '#92400e',
  hurricane: '#450a0a',
  tropical: '#991b1b',
  storm_surge: '#134e4a',
  other: '#334155',
};

/**
 * Build the MapLibre data-driven `match` expression that picks a colour
 * per alert category from a `category` property on each feature.
 * Returns the expression cast to `string` because react-map-gl's paint
 * prop types don't expose MapLibre's expression union — the runtime
 * accepts the raw array fine.
 */
export function alertColorMatchExpression(
  table: Record<AlertCategoryKey, string>,
): string {
  return [
    'match',
    ['get', 'category'],
    'tornado', table.tornado,
    'flood', table.flood,
    'severe_thunderstorm', table.severe_thunderstorm,
    'hurricane', table.hurricane,
    'tropical', table.tropical,
    'storm_surge', table.storm_surge,
    table.other,
  ] as unknown as string;
}
