'use client';
/**
 * Task 20 — Portfolio Map view.
 *
 * Renders the underwriting book as size-scaled circles over a Mapbox base
 * layer. Each circle represents one ZIP3 of the seeded policy book; its
 * radius scales with log10(total TIV) so a single megapolicy zip doesn't
 * swallow the rest of the map. Clicking a circle opens a side panel listing
 * the cohorts inside that ZIP3.
 *
 * Why centroids rather than choropleth: the prototype operates on the 38
 * ZIP3s seeded by `scripts/seed_policy_book.py`. Shipping a full ZIP3
 * polygon TopoJSON for those would balloon the bundle by ~MB-class assets
 * for a demo that only needs to communicate "this is where your exposure
 * is concentrated". We hand-code centroids derived from the seed
 * distribution and revisit when the book grows past hardcoded scope.
 */
import { useState, useMemo, useCallback } from 'react';
import { MapBase } from './MapBase';
import { PortfolioDrillDown } from './PortfolioDrillDown';
import type { Cohort } from '@/lib/db/cohorts';
import { Source, Layer, type MapMouseEvent } from 'react-map-gl/mapbox';

interface Props {
  cohorts: Cohort[];
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

export function PortfolioMap({ cohorts }: Props) {
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

  /** GeoJSON FeatureCollection feeding the circle layer. */
  const geojson = useMemo(() => {
    const features = Object.entries(zip3Totals).map(([zip3, { tiv, policies }]) => {
      const c = ZIP3_CENTROIDS[zip3] ?? FALLBACK_CENTROID;
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: c },
        properties: { zip3, tiv, policies, log_tiv: Math.log10(tiv + 1) },
      };
    });
    return { type: 'FeatureCollection' as const, features };
  }, [zip3Totals]);

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
              'circle-color': '#2563eb',
              'circle-opacity': 0.6,
              'circle-stroke-width': 1,
              'circle-stroke-color': '#1e40af',
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
          maxWidth: 280,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Book exposure by ZIP3</div>
        <div>
          Total TIV: $
          {aggregateTiv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </div>
        <div>Total policies: {aggregatePolicies.toLocaleString()}</div>
        <div>ZIP3s: {Object.keys(zip3Totals).length}</div>
        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          Click a circle to drill down (TODO when MIP wired).
        </div>
      </div>
      {selectedZip3 && (
        <PortfolioDrillDown
          zip3={selectedZip3}
          cohorts={selectedCohorts}
          onClose={() => setSelectedZip3(null)}
        />
      )}
    </div>
  );
}
