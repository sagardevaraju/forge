'use client';
/**
 * Task P2.20 — one map pane of the Portfolio Map view.
 *
 * Renders a single MapLibre `<Map>` of size-scaled circles plus the
 * visually-hidden keyboard list that mirrors the circle layer for screen
 * readers and pointer hover. Stateless — color and hover state come in via
 * props so the parent (`PortfolioMap`) can synchronize two panes side-by-side.
 *
 * The pane has two color modes:
 *   - `'current'` paints every ZIP3 with the neutral retain swatch so a
 *     reviewer sees the book *as it is today*.
 *   - `'recommended'` paints each ZIP3 by its MIP `dominantActionByTiv`.
 *
 * Shared hover identity (`hoveredZip3`) is the React state mechanism for
 * cross-pane sync. MapLibre per-map feature-state can't reach across
 * `<Map>` instances, but a state variable in the parent can. Both the
 * MapLibre paint expression and the keyboard list mirror the hovered state
 * so jsdom-only tests can verify sync without touching the WebGL canvas.
 */
import { useCallback, useMemo } from 'react';
import { Source, Layer, type MapMouseEvent } from 'react-map-gl/maplibre';
import { MapBase } from './MapBase';
import {
  type ActionName,
  ACTION_COLORS,
  ACTION_LABELS,
} from '@/lib/portfolio-actions';
import { zip3ToCounty } from '@/lib/regulatory/zip3_to_county';

/**
 * Pane mode flags which color encoding the pane applies. In `'current'` mode
 * every ZIP3 is painted with the neutral retain color so reviewers see the
 * book as-is; in `'recommended'` mode each ZIP3 is painted with the MIP's
 * dominant action color.
 */
export type PaneMode = 'current' | 'recommended';

/** Color the "current" pane uses for every ZIP3 — the retain swatch. */
const CURRENT_COLOR = ACTION_COLORS.retain;

/**
 * Centroids for the 38 ZIP3s seeded by scripts/seed_policy_book.py.
 * Values are approximate centers of each ZIP3 in [lon, lat] order.
 * If a cohort references a ZIP3 not in this map we fall back to a Gulf
 * centroid so it still renders on-screen rather than dropping silently.
 */
const ZIP3_CENTROIDS: Record<string, [number, number]> = {
  // FL
  '320': [-82.0, 29.5],
  '330': [-80.2, 26.0],
  '331': [-80.3, 25.8],
  '332': [-80.5, 26.1],
  '334': [-81.8, 27.5],
  '335': [-82.5, 28.0],
  '337': [-82.7, 27.4],
  '338': [-81.9, 28.0],
  '339': [-81.9, 26.5],
  '341': [-81.7, 26.7],
  '342': [-81.7, 26.6],
  '346': [-82.5, 28.7],
  '349': [-80.8, 27.0],
  // TX
  '770': [-95.4, 29.7],
  '774': [-94.9, 29.4],
  '775': [-94.8, 29.6],
  '776': [-94.5, 30.0],
  '777': [-94.0, 30.2],
  '778': [-95.5, 28.9],
  '783': [-97.4, 27.7],
  '784': [-97.5, 27.5],
  // LA
  '703': [-90.0, 30.0],
  '704': [-90.5, 30.1],
  '705': [-90.8, 30.2],
  '707': [-91.1, 30.4],
  '708': [-91.3, 30.5],
  '706': [-93.2, 30.2],
  '714': [-93.8, 30.3],
  // NC
  '275': [-78.5, 35.6],
  '280': [-80.8, 35.2],
  '281': [-80.9, 35.3],
  '282': [-80.5, 35.4],
  '283': [-79.0, 35.0],
  '284': [-80.0, 35.3],
  '285': [-77.8, 35.0],
  '286': [-78.0, 35.2],
  '287': [-82.5, 35.6],
  '289': [-77.0, 34.5],
};

const FALLBACK_CENTROID: [number, number] = [-82, 28];

export interface ZipRow {
  zip3: string;
  tiv: number;
  policies: number;
  action: ActionName | null;
}

interface PortfolioMapPaneProps {
  /** Which encoding to render — see `PaneMode`. */
  mode: PaneMode;
  /** Pre-aggregated per-ZIP3 rows shared with the sibling pane. */
  zipRows: ZipRow[];
  /** Currently-hovered ZIP3, shared between panes via parent state. */
  hoveredZip3: string | null;
  /** Lift hover changes back to the parent. */
  onHoverChange: (zip3: string | null) => void;
  /** Click invokes the drilldown — same callback the keyboard list fires. */
  onSelectZip3: (zip3: string) => void;
  /** A11y label for the pane wrapper. */
  ariaLabel: string;
  /** Stable test handle so the test suite can scope queries per-pane. */
  testId: string;
}

export function PortfolioMapPane({
  mode,
  zipRows,
  hoveredZip3,
  onHoverChange,
  onSelectZip3,
  ariaLabel,
  testId,
}: PortfolioMapPaneProps) {
  const geojson = useMemo(() => {
    const features = zipRows.map((row) => {
      const centroid = ZIP3_CENTROIDS[row.zip3] ?? FALLBACK_CENTROID;
      const color =
        mode === 'current'
          ? CURRENT_COLOR
          : row.action
            ? ACTION_COLORS[row.action]
            : '#9ca3af';
      const paneAction: ActionName =
        mode === 'current' ? 'retain' : (row.action ?? 'retain');
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: centroid },
        properties: {
          zip3: row.zip3,
          tiv: row.tiv,
          policies: row.policies,
          log_tiv: Math.log10(row.tiv + 1),
          color,
          action: paneAction,
        },
      };
    });
    return { type: 'FeatureCollection' as const, features };
  }, [zipRows, mode]);

  const handleMapClick = useCallback(
    (e: MapMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const zip3 = feature.properties?.zip3;
      if (typeof zip3 === 'string') onSelectZip3(zip3);
    },
    [onSelectZip3],
  );

  const handleMapMove = useCallback(
    (e: MapMouseEvent) => {
      const feature = e.features?.[0];
      const zip3 = feature?.properties?.zip3;
      onHoverChange(typeof zip3 === 'string' ? zip3 : null);
    },
    [onHoverChange],
  );

  /**
   * `hoverMatch` feeds the MapLibre paint case-expression below. Using `''`
   * as the empty-state sentinel keeps the expression statically typed; ZIP3
   * codes are 3-digit strings, so no real feature can ever equal `''`.
   */
  const hoverMatch = hoveredZip3 ?? '';

  return (
    <div
      data-testid={testId}
      data-pane-mode={mode}
      aria-label={ariaLabel}
      role="region"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <MapBase
        interactiveLayerIds={['zip3-circles']}
        onClick={handleMapClick}
        onMouseMove={handleMapMove}
      >
        <Source id="zip3-points" type="geojson" data={geojson}>
          <Layer
            id="zip3-circles"
            type="circle"
            paint={{
              'circle-radius': [
                'interpolate',
                ['linear'],
                ['get', 'log_tiv'],
                6,
                4,
                9,
                30,
              ],
              'circle-color': ['get', 'color'],
              'circle-opacity': [
                'case',
                ['==', ['get', 'zip3'], hoverMatch],
                0.95,
                0.75,
              ],
              'circle-stroke-width': [
                'case',
                ['==', ['get', 'zip3'], hoverMatch],
                3.5,
                1.5,
              ],
              'circle-stroke-color': '#1f2937',
            }}
          />
        </Source>
      </MapBase>
      {/*
        Task 26 — sr-only keyboard parallel for the MapLibre circles. MapLibre
        canvas circles aren't DOM nodes, so screen-reader + keyboard users
        get this list as their entry point into the drilldown. Activating a
        button fires the same `onSelectZip3` that map clicks trigger.

        Task P2.20 — hover events on these buttons drive the shared hover
        state so a keyboard / pointer user moving across the list highlights
        the matching ZIP3 in both panes. The `data-*` attributes expose the
        pane's color encoding to the test suite without depending on the
        WebGL canvas (which jsdom cannot render).
      */}
      <ul
        data-testid={`${testId}-keyboard-list`}
        aria-label={`ZIP3 cohorts in the ${mode} portfolio`}
        className="sr-only"
      >
        {zipRows.map((row) => {
          const color =
            mode === 'current'
              ? CURRENT_COLOR
              : row.action
                ? ACTION_COLORS[row.action]
                : '#9ca3af';
          const action: ActionName =
            mode === 'current' ? 'retain' : (row.action ?? 'retain');
          const actionLabel = ACTION_LABELS[action];
          const isHovered = hoveredZip3 === row.zip3;
          return (
            <li key={row.zip3}>
              <button
                type="button"
                data-zip3={row.zip3}
                data-pane-mode={mode}
                data-action={action}
                data-color={color}
                data-hovered={isHovered ? 'true' : 'false'}
                onMouseEnter={() => onHoverChange(row.zip3)}
                onMouseLeave={() => onHoverChange(null)}
                onFocus={() => onHoverChange(row.zip3)}
                onBlur={() => onHoverChange(null)}
                onClick={() => onSelectZip3(row.zip3)}
                aria-label={`Inspect cohorts in ZIP3 ${row.zip3}, ${zip3ToCounty(row.zip3)} — ${row.policies.toLocaleString()} policies, recommended action: ${actionLabel}`}
              >
                ZIP3 {row.zip3} — {zip3ToCounty(row.zip3)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
