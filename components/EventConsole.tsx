'use client';
/**
 * Task 21 — Event Console UI.
 * Task P2.21 — Cone-vs-outside book exposure mini-map.
 * Task P2.22 — Multi-advisory ribbon on the event console map.
 * Task P2.23 — Cone uncertainty band from GEFS perturbation.
 *
 * Two-column layout for the active-event view:
 *   - Left: Mapbox base layer with the NHC cone polygon and FIRMS active-fire
 *     point markers overlaid as separate GeoJSON sources. A small floating
 *     summary card shows the advisory number, peak wind, and fire count so
 *     operators get the headline numbers without scanning the map. A second
 *     floating panel (Task P2.21) ranks book exposure that falls inside the
 *     cone vs outside, computed via point-in-polygon against ZIP3 cohort
 *     centroids. The prior 4 advisories (Task P2.22) render as faint line
 *     outlines UNDER the current cone — the operator can see how the
 *     forecast has shifted over the last ~24h without needing a separate
 *     timeline UI. A small legend strip labels each prior by advisory #.
 *     The GEFS uncertainty envelope (Task P2.23) renders as three
 *     concentric heat-tinted fills (t72h faintest, t24h densest)
 *     UNDERNEATH both the prior ribbon and the current cone — visualising
 *     ensemble spread without competing with the headline forecast.
 *   - Right: a chat panel against `/api/agent/chat` plus a SITREP panel that
 *     drafts a memo via the same endpoint (the LLM picks `draft_sitrep`).
 *
 * The cone is rendered as both a filled polygon and a stroked outline so the
 * advisory boundary remains visible against the dimmed fill. Prior advisory
 * cones are outline-only at reduced stroke opacity so they read as ghosts
 * and never compete with the headline cone visually. The envelope fills
 * scale fill-opacity by horizon (t72h = 0.08, t48h = 0.12, t24h = 0.18) so
 * "closer in time = more certain = denser hue" matches operator intuition.
 *
 * Layer-stack bottom-to-top:
 *   envelope (t72h → t48h → t24h) → prior cones → current cone → fires
 */
import { useState } from 'react';
import { MapBase } from './MapBase';
import { Source, Layer } from 'react-map-gl/maplibre';
import { AgentChat } from './AgentChat';
import {
  SitrepPanel,
  type StructuredSitrep,
  type SitrepDataSource,
} from './SitrepPanel';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ConeExposureBars, type ConeExposureCohort } from './ConeExposureBars';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import type { FireDetection } from '@/app/api/agent/tools/fetch_firms_fires';
import type { NwsAlert, NwsAlertCategory } from '@/app/api/agent/tools/fetch_nws_alerts';
import type { PolygonLike } from '@/lib/geo/point_in_polygon';
import {
  ALERT_FILL_COLOR,
  ALERT_LINE_COLOR,
  alertColorMatchExpression,
} from '@/lib/grammar/alert-colors';

/**
 * Task P2.23 — The GEFS-perturbation cone envelope can be attached to the
 * `cone` payload as a peer field. The page glue (or the agent route, when
 * driven by `generate_scenarios`) joins the envelope onto the cone result
 * so EventConsole only needs a single prop. Legacy callers omit the field
 * entirely, in which case nothing extra renders.
 */
type ConeWithEnvelope = FetchNhcConeResult & {
  cone_envelope?: {
    t24h: GeoJSON.Polygon;
    t48h: GeoJSON.Polygon;
    t72h: GeoJSON.Polygon;
  } | null;
};

interface Props {
  cone: ConeWithEnvelope | null;
  fires: FireDetection[];
  /**
   * Cohort-level exposure rows for the P2.21 mini-map. Optional so existing
   * callers / tests don't need to wire it up — when omitted the mini-map
   * falls back to its "no book loaded" placeholder.
   */
  cohorts?: ConeExposureCohort[];
  /**
   * Live NWS active alerts (tornado / flood / severe thunderstorm / etc.).
   * Rendered as a colour-encoded polygon layer underneath the hurricane
   * cone so the cone stays the dominant visual element. Optional — when
   * omitted or empty, nothing extra renders.
   */
  alerts?: NwsAlert[];
  /**
   * Per-ZIP3 `[lon, lat]` centroids from the live policy book
   * (`lib/db/zip3_centroids.ts`), used by the cone-exposure mini-map to
   * classify cohorts inside/outside the cone. Optional so existing callers
   * / tests can omit it — the mini-map then counts cohorts as unmapped.
   */
  zip3Centroids?: Record<string, [number, number]>;
}

export function EventConsole({
  cone,
  fires,
  cohorts,
  alerts,
  zip3Centroids,
}: Props) {
  const [sitrep, setSitrep] = useState<StructuredSitrep | null>(null);
  const [sitrepDataSource, setSitrepDataSource] = useState<SitrepDataSource | null>(null);

  const sitrepCtx = cone
    ? {
        storm_id: 'AL092024',
        advisory_number: cone.advisory_number ?? null,
        peak_wind: cone.peak_wind ?? null,
        fire_count: (fires ?? []).length,
        source: cone.source,
      }
    : null;

  const firesGeoJson = {
    type: 'FeatureCollection' as const,
    features: (fires ?? []).map((f) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [f.lon, f.lat] },
      properties: { brightness: f.brightness, confidence: f.confidence },
    })),
  };

  // Task P2.22 — multi-advisory ribbon. The tool returns up to 4 prior
  // advisories' cones; legacy callers / tests may omit the field entirely,
  // so coerce to [] up front. Rendering as separate Sources before the
  // current-cone Source means MapLibre paints them first → the current cone
  // stays on top with full fill + stroke, while priors sit beneath as
  // faint outlines only.
  const priorCones = cone?.prior_cones ?? [];

  // NWS active alerts — tornado / flood / severe thunderstorm / etc. The
  // tool returns geometry as either Polygon, MultiPolygon, or null
  // (county-coded alerts don't ship a polygon and are dropped here).
  // We build a single GeoJSON FeatureCollection with `category` on each
  // feature so MapLibre's data-driven `match` expression can pick the
  // right colour per peril without us emitting one Source per category.
  const alertFeatures: GeoJSON.Feature[] = (alerts ?? [])
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
        headline: a.headline,
        area_desc: a.area_desc,
      },
    }));
  const alertsGeoJson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: alertFeatures,
  };
  const fillColorExpr = alertColorMatchExpression(ALERT_FILL_COLOR);
  const lineColorExpr = alertColorMatchExpression(ALERT_LINE_COLOR);

  // Task P2.23 — GEFS perturbation uncertainty envelope. Three concentric
  // hulls (t72h, t48h, t24h) ordered widest → narrowest. Rendered before
  // the prior-cone ribbon AND before the current cone so MapLibre paints
  // them at the bottom of the visual stack. The heat tint goes denser as
  // the horizon shrinks ("closer in time = more certain") because that
  // matches how operators think about ensemble spread.
  const coneEnvelope = cone?.cone_envelope ?? null;
  // Outer-to-inner order is load-bearing for layer painting: t72h (widest,
  // faintest) goes down first, then t48h, then t24h on top of the envelope
  // group but still below all forecast cones.
  const envelopeHorizons = coneEnvelope
    ? ([
        { key: 't72h' as const, polygon: coneEnvelope.t72h, opacity: 0.08 },
        { key: 't48h' as const, polygon: coneEnvelope.t48h, opacity: 0.12 },
        { key: 't24h' as const, polygon: coneEnvelope.t24h, opacity: 0.18 },
      ])
    : [];

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Event Console</h1>
      <div className="grid grid-cols-[1fr_360px] gap-4 h-[80vh]">
        <div className="border rounded relative">
          <MapBase>
            {/* Task P2.23 — GEFS perturbation uncertainty envelope. Three
                heat-tinted polygons (t72h → t48h → t24h) rendered FIRST so
                MapLibre paints them at the bottom of the stack, beneath
                the prior-cone ribbon and the official current cone. The
                outer/inner ordering is intentional: wider t72h sits
                under the narrower t24h so the band reads as concentric
                "uncertainty rings" — densest near the most-certain
                horizon, fading outward. Fill-only (no stroke) so the
                ring boundaries don't compete with the cone outlines. */}
            {envelopeHorizons.map(({ key, polygon, opacity }) => (
              <Source
                key={`cone-envelope-${key}`}
                id={`cone-envelope-${key}`}
                type="geojson"
                data={{
                  type: 'Feature',
                  properties: { horizon: key },
                  geometry: polygon,
                } as GeoJSON.Feature}
              >
                <Layer
                  id={`cone-envelope-${key}-fill`}
                  type="fill"
                  paint={{
                    'fill-color': '#f97316', // orange-500 — warm, distinct from the cone's red
                    'fill-opacity': opacity,
                    'fill-outline-color': 'transparent',
                  }}
                />
              </Source>
            ))}
            {/* Task P2.22 — prior-advisory ribbon. Rendered BEFORE the
                current cone so MapLibre layers paint them underneath. Each
                prior is outline-only at reduced opacity so the headline
                cone stays the dominant visual element. */}
            {priorCones.map((prior) => (
              <Source
                key={`prior-cone-${prior.advisory_number}`}
                id={`prior-cone-${prior.advisory_number}`}
                type="geojson"
                data={prior.cone as GeoJSON.Feature}
              >
                <Layer
                  id={`prior-cone-line-${prior.advisory_number}`}
                  type="line"
                  paint={{
                    'line-color': '#991b1b',
                    'line-width': 1,
                    'line-opacity': 0.3,
                    'line-dasharray': [2, 2],
                  }}
                />
              </Source>
            ))}
            {/* NWS active alerts — tornado / flood / severe thunderstorm /
                etc. Painted BEFORE the hurricane cone so the cone fill +
                outline stay the dominant element. Within the alert layer
                the fill opacity is low (0.35) so overlapping polygons
                remain legible and the basemap shows through; the line
                outline at full opacity gives each alert a clear boundary
                even when the fill blends with another. */}
            {alertFeatures.length > 0 && (
              <Source id="nws-alerts" type="geojson" data={alertsGeoJson}>
                <Layer
                  id="nws-alerts-fill"
                  type="fill"
                  paint={{
                    'fill-color': fillColorExpr,
                    'fill-opacity': 0.35,
                    'fill-outline-color': 'transparent',
                  }}
                />
                <Layer
                  id="nws-alerts-line"
                  type="line"
                  paint={{
                    'line-color': lineColorExpr,
                    'line-width': 1.5,
                    'line-opacity': 0.9,
                  }}
                />
              </Source>
            )}
            {cone?.cone != null && (
              <Source id="cone" type="geojson" data={cone.cone as GeoJSON.Feature}>
                <Layer
                  id="cone-fill"
                  type="fill"
                  paint={{ 'fill-color': '#dc2626', 'fill-opacity': 0.25 }}
                />
                <Layer
                  id="cone-line"
                  type="line"
                  paint={{ 'line-color': '#991b1b', 'line-width': 2 }}
                />
              </Source>
            )}
            {firesGeoJson.features.length > 0 && (
              <Source id="fires" type="geojson" data={firesGeoJson}>
                <Layer
                  id="fire-points"
                  type="circle"
                  paint={{
                    'circle-radius': 4,
                    'circle-color': '#f59e0b',
                    'circle-stroke-color': '#92400e',
                    'circle-stroke-width': 1,
                  }}
                />
              </Source>
            )}
          </MapBase>
          {cone && (
            <div
              data-testid="event-summary"
              className="absolute top-3 left-3 bg-white p-3 border rounded shadow-sm text-xs max-w-xs"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="font-semibold">
                  Storm: {cone.advisory_number || 'N/A'}
                </div>
                <TrustTierBadge
                  tier={cone.source === 'live' ? 'LIVE_FEED' : 'SYNTHETIC_SCAFFOLD'}
                />
              </div>
              <div>Peak wind: {cone.peak_wind ?? 'N/A'} mph</div>
              <div>{(fires ?? []).length} active fires nearby</div>
            </div>
          )}
          {/* Task P2.22 — multi-advisory legend strip. Sits below the summary
              card so the operator can map ribbon outlines to advisory
              numbers at a glance. Each entry shows "Adv #N" plus a
              -6h-style relative label keyed by ribbon order (most recent
              prior is -6h, then -12h, etc.). The dashed swatch matches the
              line style of the prior-cone layers above. */}
          {priorCones.length > 0 && (
            <div
              data-testid="advisory-ribbon-legend"
              className="absolute top-3 right-3 bg-white p-2 border rounded shadow-sm text-[11px] leading-tight"
            >
              <div className="font-semibold mb-1">Prior advisories</div>
              <ul className="space-y-1">
                {priorCones.map((prior, idx) => (
                  <li
                    key={prior.advisory_number}
                    data-testid={`advisory-ribbon-legend-row-${prior.advisory_number}`}
                    className="flex items-center gap-2"
                  >
                    <span
                      aria-hidden
                      className="inline-block w-4 border-t border-dashed border-red-900 opacity-60"
                    />
                    <span className="text-slate-700">
                      Adv #{prior.advisory_number}
                    </span>
                    <span className="text-slate-400">
                      −{(idx + 1) * 6}h
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Task P2.21: cone exposure ratio mini-map (left rail). */}
          <div className="absolute bottom-3 left-3 w-[280px]">
            <ConeExposureBars
              cone={(cone?.cone as PolygonLike | null) ?? null}
              cohorts={cohorts ?? []}
              coneSource={cone?.source}
              zip3Centroids={zip3Centroids ?? {}}
            />
          </div>
          {/* NWS alerts legend — bottom-right corner, mirrors the
              prior-advisories legend pattern. Only renders categories
              that actually have an alert on the map so the operator
              doesn't read decorative swatches for absent perils. */}
          {alertFeatures.length > 0 && (
            <div
              data-testid="nws-alerts-legend"
              className="absolute bottom-3 right-3 bg-white p-2 border rounded shadow-sm text-[11px] leading-tight"
            >
              <div className="font-semibold mb-1 flex items-center gap-2">
                Active alerts
                <span className="text-[10px] text-slate-500 font-normal">
                  NWS · live
                </span>
              </div>
              <ul className="space-y-1">
                {(
                  [
                    ['tornado', 'Tornado'],
                    ['flood', 'Flood'],
                    ['severe_thunderstorm', 'Severe T-storm'],
                    ['hurricane', 'Hurricane'],
                    ['tropical', 'Tropical storm'],
                    ['storm_surge', 'Storm surge'],
                    ['other', 'Other'],
                  ] as Array<[NwsAlertCategory, string]>
                )
                  .map(([cat, label]) => {
                    const n = (alerts ?? []).filter((a) => a.category === cat).length;
                    return { cat, label, n };
                  })
                  .filter(({ n }) => n > 0)
                  .map(({ cat, label, n }) => (
                    <li
                      key={cat}
                      data-testid={`nws-alerts-legend-${cat}`}
                      className="flex items-center gap-2"
                    >
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{
                          backgroundColor: ALERT_FILL_COLOR[cat],
                          outline: `1px solid ${ALERT_LINE_COLOR[cat]}`,
                        }}
                      />
                      <span className="text-slate-700">{label}</span>
                      <span className="text-slate-500 tabular-nums">×{n}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4 overflow-auto">
          <AgentChat />
          <SitrepPanel
            sitrep={sitrep}
            dataSource={sitrepDataSource}
            context={sitrepCtx}
            onGenerate={(nextSitrep, nextDataSource) => {
              setSitrep(nextSitrep);
              setSitrepDataSource(nextDataSource);
            }}
          />
        </div>
      </div>
    </div>
  );
}
