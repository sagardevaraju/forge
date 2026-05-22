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
import { zip3CountyLabel } from '@/lib/regulatory/zip3_geo';
import type { PolygonLike } from '@/lib/geo/point_in_polygon';
import type { NwsAlert } from '@/app/api/agent/tools/fetch_nws_alerts';
import {
  ALERT_FILL_COLOR,
  ALERT_LINE_COLOR,
  alertColorMatchExpression,
} from '@/lib/grammar/alert-colors';

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
 * ZIP3 bubble centroids arrive via the `zip3Centroids` prop — the live
 * mean(lat, lon) per ZIP3 computed from the policy book by
 * `lib/db/zip3_centroids.ts`. This replaced a hand-coded table that had
 * drifted ~100-460 km from where the seed actually places policies (the
 * seed samples each state from one Gaussian blob and assigns `zip3` as an
 * unrelated label). `FALLBACK_CENTROID` is a Gulf point used only if a
 * cohort references a ZIP3 with no policy coordinates, so the circle still
 * renders on-screen rather than dropping silently.
 */
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
  /**
   * Per-ZIP3 `[lon, lat]` map centroids derived from the live policy book
   * (`lib/db/zip3_centroids.ts`). A ZIP3 absent from this map falls back to
   * `FALLBACK_CENTROID` so its circle still renders.
   */
  zip3Centroids: Record<string, [number, number]>;
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
  /**
   * Optional in-pane heading chip. Rendered top-left so the user can tell
   * which pane is the "current" view vs the MIP-recommended one in compare
   * mode. Omit on the single-pane view where the global legend already
   * carries the orientation.
   */
  paneTitle?: string;
  /** Optional sub-line under the title chip — e.g. "Snapshot · MIP solve". */
  paneSubtitle?: string;
  /**
   * Task P2.20+ — active NHC cone polygon to overlay on the map. Renders as a
   * subtle rose-toned fill with a stronger stroke so it reads as "active
   * threat envelope" without overwhelming the per-ZIP3 circles. Pass through
   * the raw GeoJSON Feature; the pane wraps it in a MapLibre Source.
   */
  conePolygon?: PolygonLike;
  /**
   * Task P2.20+ — which ZIP3s' centroids fall inside `conePolygon`. Circles
   * for these ZIP3s get a danger-tinted stroke so the eye lands on at-risk
   * exposure immediately. Computed once by the parent and shared with both
   * panes so the highlight stays consistent in compare mode.
   */
  zip3sUnderCone?: Set<string>;
  /**
   * Live NWS active alerts (tornado / flood / severe thunderstorm /
   * tropical / storm surge / hurricane) scoped to the book's footprint.
   * Each alert with non-null geometry renders as a category-coloured
   * polygon beneath the cone and zip3 circles. County-coded alerts
   * (null geometry) are silently skipped — the LiveEventStrip still
   * counts them via `alertCounts`.
   */
  alerts?: NwsAlert[];
}

export function PortfolioMapPane({
  mode,
  zipRows,
  zip3Centroids,
  hoveredZip3,
  onHoverChange,
  onSelectZip3,
  ariaLabel,
  testId,
  paneTitle,
  paneSubtitle,
  conePolygon,
  zip3sUnderCone,
  alerts,
}: PortfolioMapPaneProps) {
  const geojson = useMemo(() => {
    const features = zipRows.map((row) => {
      const centroid = zip3Centroids[row.zip3] ?? FALLBACK_CENTROID;
      const color =
        mode === 'current'
          ? CURRENT_COLOR
          : row.action
            ? ACTION_COLORS[row.action]
            : '#9ca3af';
      const paneAction: ActionName =
        mode === 'current' ? 'retain' : (row.action ?? 'retain');
      const underCone = zip3sUnderCone?.has(row.zip3) ?? false;
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
          under_cone: underCone,
        },
      };
    });
    return { type: 'FeatureCollection' as const, features };
  }, [zipRows, zip3Centroids, mode, zip3sUnderCone]);

  /**
   * Build a single GeoJSON FeatureCollection from the NWS alerts that
   * carry polygon geometry. Each feature gets a `category` property so
   * MapLibre's data-driven `match` expression can pick the right colour
   * per peril. County-coded alerts (null geometry) are skipped — the
   * LiveEventStrip still counts them via `alertCounts`.
   */
  const alertsGeoJson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!alerts || alerts.length === 0) return null;
    const features: GeoJSON.Feature[] = alerts
      .filter((a): a is NwsAlert & { geometry: NonNullable<NwsAlert['geometry']> } =>
        a.geometry !== null,
      )
      .map((a) => ({
        type: 'Feature',
        geometry: a.geometry,
        properties: {
          id: a.id,
          event: a.event,
          category: a.category,
          severity: a.severity,
          expires: a.expires,
        },
      }));
    if (features.length === 0) return null;
    return { type: 'FeatureCollection', features };
  }, [alerts]);
  const alertFillExpr = useMemo(
    () => alertColorMatchExpression(ALERT_FILL_COLOR),
    [],
  );
  const alertLineExpr = useMemo(
    () => alertColorMatchExpression(ALERT_LINE_COLOR),
    [],
  );

  /**
   * Wrap the cone GeoJSON Feature in a FeatureCollection so the MapLibre
   * Source accepts it directly. The cone tool returns a Feature already; we
   * just package it. Returns null when no cone is active so the Source
   * collapses to nothing and the rose layers don't render at all.
   */
  const coneGeojson = useMemo(() => {
    if (!conePolygon) return null;
    if (
      (conePolygon as { type?: string }).type === 'Feature' &&
      (conePolygon as { geometry?: unknown }).geometry
    ) {
      return {
        type: 'FeatureCollection' as const,
        features: [conePolygon as unknown as GeoJSON.Feature],
      };
    }
    // Raw geometry: synthesise a Feature wrapper.
    return {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: {},
          geometry: conePolygon as unknown as GeoJSON.Geometry,
        },
      ],
    };
  }, [conePolygon]);

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
      {paneTitle && (
        <div
          data-testid={`${testId}-title`}
          className="absolute top-3 left-1/2 -translate-x-1/2 z-[3] pointer-events-none rounded-md bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 ring-1 ring-zinc-200/70 shadow-[0_1px_2px_rgba(24,24,27,0.06)] px-3 py-1.5 text-center whitespace-nowrap"
        >
          <div className="flex items-center justify-center gap-1.5">
            <span
              aria-hidden="true"
              className={[
                'inline-block h-1.5 w-1.5 rounded-full',
                mode === 'current' ? 'bg-zinc-400' : 'bg-emerald-500',
              ].join(' ')}
            />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-zinc-800">
              {paneTitle}
            </span>
          </div>
          {paneSubtitle && (
            <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">
              {paneSubtitle}
            </div>
          )}
        </div>
      )}
      <MapBase
        interactiveLayerIds={['zip3-circles']}
        onClick={handleMapClick}
        onMouseMove={handleMapMove}
      >
        {/* NWS active alerts — tornado / flood / severe thunderstorm / etc.
            Painted BEFORE the hurricane cone so the cone stays the visually
            dominant element when both are present. Within the layer the fill
            opacity stays low so overlapping warning polygons remain legible
            and the zip3 exposure circles read on top. */}
        {alertsGeoJson && (
          <Source id="portfolio-nws-alerts" type="geojson" data={alertsGeoJson}>
            <Layer
              id="portfolio-nws-alerts-fill"
              type="fill"
              paint={{
                'fill-color': alertFillExpr,
                'fill-opacity': 0.28,
                'fill-outline-color': 'transparent',
              }}
            />
            <Layer
              id="portfolio-nws-alerts-line"
              type="line"
              paint={{
                'line-color': alertLineExpr,
                'line-width': 1.25,
                'line-opacity': 0.85,
              }}
            />
          </Source>
        )}
        {coneGeojson && (
          <Source id="cone-polygon" type="geojson" data={coneGeojson}>
            <Layer
              id="cone-fill"
              type="fill"
              paint={{
                'fill-color': '#f43f5e', // rose-500 — read as "threat envelope"
                'fill-opacity': 0.08,
              }}
            />
            <Layer
              id="cone-outline"
              type="line"
              paint={{
                'line-color': '#e11d48', // rose-600
                'line-width': 1.5,
                'line-opacity': 0.55,
                'line-dasharray': [2, 2],
              }}
            />
          </Source>
        )}
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
                ['==', ['get', 'under_cone'], true],
                2.5,
                1.5,
              ],
              'circle-stroke-color': [
                'case',
                ['==', ['get', 'under_cone'], true],
                '#e11d48', // rose-600 — at-risk ring
                '#1f2937',
              ],
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
                aria-label={`Inspect cohorts in ZIP3 ${row.zip3}, ${zip3CountyLabel(row.zip3)}, ${row.policies.toLocaleString()} policies, recommended action: ${actionLabel}`}
              >
                ZIP3 {row.zip3}, {zip3CountyLabel(row.zip3)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
