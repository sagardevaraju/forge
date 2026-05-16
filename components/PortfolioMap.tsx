'use client';
/**
 * Portfolio Map view.
 *
 * Renders the underwriting book as size-scaled circles over a MapLibre /
 * OpenFreeMap base layer. Each circle represents one ZIP3 of the policy
 * book; its radius scales with log10(total TIV) so a single megapolicy
 * zip doesn't swallow the rest of the map. Color encodes the MIP-recommended
 * dominant action for that ZIP3 (retain / reprice / non-renew / cede).
 * Clicking a circle opens a drilldown panel showing per-cohort action
 * fractions inside that ZIP3.
 *
 * Why centroids rather than choropleth: the FL/TX/LA/NC seed book covers
 * ~38 ZIP3s. Shipping a full ZIP3 polygon TopoJSON would balloon the bundle
 * for a demo that only needs to communicate "this is where your exposure
 * is concentrated and what we're doing about it." Hand-coded centroids
 * derived from the seed distribution; revisit when the book widens.
 */
import { useState, useMemo, useCallback } from 'react';
import { MapBase } from './MapBase';
import { PortfolioDrillDown } from './PortfolioDrillDown';
import type { Cohort } from '@/lib/db/cohorts';
import {
  type PortfolioOptimization,
  type ActionName,
  indexByZip3,
  ACTION_COLORS,
  ACTION_LABELS,
} from '@/lib/portfolio-actions';
import { Source, Layer, type MapMouseEvent } from 'react-map-gl/maplibre';

interface Props {
  cohorts: Cohort[];
  optimization: PortfolioOptimization | null;
}

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

export function PortfolioMap({ cohorts, optimization }: Props) {
  const [selectedZip3, setSelectedZip3] = useState<string | null>(null);

  /** Aggregate per-ZIP3 totals over the cohort list. */
  const zip3Totals = useMemo(() => {
    const m: Record<string, { tiv: number; policies: number }> = {};
    for (const c of cohorts) {
      if (!m[c.zip3]) m[c.zip3] = { tiv: 0, policies: 0 };
      m[c.zip3].tiv += c.total_tiv;
      m[c.zip3].policies += c.policy_count;
    }
    return m;
  }, [cohorts]);

  /** Per-zip3 dominant action recommendation (by TIV-weighted share). */
  const zip3Actions = useMemo(
    () => (optimization ? indexByZip3(optimization) : {}),
    [optimization],
  );

  /**
   * Per-cohort action lookup for the drilldown. Keyed by `cohort.id`.
   */
  const actionByCohort = useMemo(() => {
    if (!optimization) return {};
    const m: Record<string, (typeof optimization.actions)[number]> = {};
    for (const a of optimization.actions) m[a.cohort_id] = a;
    return m;
  }, [optimization]);

  /** GeoJSON FeatureCollection feeding the circle layer. */
  const geojson = useMemo(() => {
    const features = Object.entries(zip3Totals).map(([zip3, { tiv, policies }]) => {
      const c = ZIP3_CENTROIDS[zip3] ?? FALLBACK_CENTROID;
      const action = zip3Actions[zip3]?.dominantActionByTiv ?? null;
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: c },
        properties: {
          zip3,
          tiv,
          policies,
          log_tiv: Math.log10(tiv + 1),
          color: action ? ACTION_COLORS[action] : '#9ca3af',
          action: action ?? 'unknown',
        },
      };
    });
    return { type: 'FeatureCollection' as const, features };
  }, [zip3Totals, zip3Actions]);

  const handleMapClick = useCallback((e: MapMouseEvent) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const zip3 = feature.properties?.zip3;
    if (typeof zip3 === 'string') setSelectedZip3(zip3);
  }, []);

  const selectedCohorts = useMemo(
    () => (selectedZip3 ? cohorts.filter((c) => c.zip3 === selectedZip3) : []),
    [selectedZip3, cohorts]
  );

  const aggregateTiv = useMemo(
    () => Object.values(zip3Totals).reduce((s, x) => s + x.tiv, 0),
    [zip3Totals]
  );
  const aggregatePolicies = useMemo(
    () => Object.values(zip3Totals).reduce((s, x) => s + x.policies, 0),
    [zip3Totals]
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <MapBase interactiveLayerIds={['zip3-circles']} onClick={handleMapClick}>
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
              'circle-opacity': 0.75,
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#1f2937',
            }}
          />
        </Source>
      </MapBase>
      <div
        data-testid="portfolio-legend"
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          background: 'white',
          padding: 12,
          border: '1px solid #e5e7eb',
          borderRadius: 4,
          fontSize: 12,
          maxWidth: 320,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Book exposure by ZIP3</div>
        <div>
          Total TIV: $
          {aggregateTiv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </div>
        <div>Total policies: {aggregatePolicies.toLocaleString()}</div>
        <div>ZIP3s: {Object.keys(zip3Totals).length}</div>
        {optimization && (
          <div
            style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e5e7eb' }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              MIP recommendation
            </div>
            <div>
              Expected margin: $
              {(optimization.objective / 1e6).toFixed(1)}M
            </div>
            <div>
              Annual loss (p50): $
              {(optimization.book_totals.loss_p50 / 1e6).toFixed(1)}M · p99 $
              {(optimization.book_totals.loss_p99 / 1e6).toFixed(1)}M
            </div>
            <div
              style={{
                marginTop: 8,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto',
                gap: '2px 8px',
                fontSize: 11,
              }}
            >
              {(Object.entries(optimization.action_summary) as [
                ActionName,
                { count: number; tiv: number },
              ][])
                .filter(([, v]) => v.tiv > 0)
                .sort((a, b) => b[1].tiv - a[1].tiv)
                .map(([action, v]) => (
                  <div key={action} style={{ display: 'contents' }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        background: ACTION_COLORS[action],
                        borderRadius: '50%',
                        alignSelf: 'center',
                      }}
                    />
                    <span>{ACTION_LABELS[action]}</span>
                    <span style={{ color: '#6b7280' }}>
                      {((v.tiv / aggregateTiv) * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280' }}>
          Click a circle to inspect its cohorts and recommended actions.
        </div>
      </div>
      {selectedZip3 && (
        <PortfolioDrillDown
          zip3={selectedZip3}
          cohorts={selectedCohorts}
          actionByCohort={actionByCohort}
          onClose={() => setSelectedZip3(null)}
        />
      )}
    </div>
  );
}
