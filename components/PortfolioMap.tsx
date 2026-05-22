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
 * is concentrated and what we're doing about it." Centroids arrive via the
 * `zip3Centroids` prop — the live mean(lat, lon) per ZIP3 from the policy
 * book (`lib/db/zip3_centroids.ts`), so a bubble sits where its policies
 * actually are and the map agrees with the /simulate policy overlay.
 *
 * Task 26 — accessibility pass. MapLibre circles aren't keyboard-focusable
 * features, so we render a visually-hidden `<ul>` of one `<button>` per
 * ZIP3 adjacent to the map. Keyboard + screen-reader users can tab to a
 * ZIP3 and press Enter to invoke the same drilldown that map clicks fire.
 *
 * Task P2.20 — side-by-side current vs MIP-recommended portfolio. A toggle
 * above the map flips the view between single-pane (default — the long-standing
 * behavior the rest of the app expects) and a dual-pane mode. In dual-pane
 * mode the left pane paints every cohort with the neutral "current" (retain)
 * color so reviewers see the book *as it is today*, and the right pane paints
 * each ZIP3 by its MIP `dominantActionByTiv`. Hover is synchronized through a
 * single React state (`hoveredZip3`); both panes apply an emphasized stroke
 * and the keyboard-accessibility list mirrors the hover so jsdom tests + screen
 * readers + sighted users all share the same affordance. MapLibre's per-map
 * feature-state is deliberately not used here — it can't sync across two
 * `<Map>` instances, and the React state is testable in jsdom. The single-pane
 * map rendering itself lives in `./PortfolioMapPane.tsx` so this file stays
 * focused on aggregation, state wiring, and the legend.
 */
import { useState, useMemo } from 'react';
import { PortfolioDrillDown } from './PortfolioDrillDown';
import { PortfolioMapPane, type ZipRow } from './PortfolioMapPane';
import { LiveEventStrip } from './grammar/LiveEventStrip';
import type { Cohort } from '@/lib/db/cohorts';
import {
  type PortfolioOptimization,
  type ActionName,
  indexByZip3,
  ACTION_COLORS,
  ACTION_LABELS,
} from '@/lib/portfolio-actions';
import { pointInPolygon, type PolygonLike } from '@/lib/geo/point_in_polygon';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import type {
  NwsAlert,
  NwsAlertCounts,
} from '@/app/api/agent/tools/fetch_nws_alerts';

interface Props {
  cohorts: Cohort[];
  /**
   * MIP solve to colour the recommended pane. Optional — every consumer of
   * the component already null-checks it, and a bare `cohorts`-only render
   * (used by the test suite) degrades to the neutral "current" view.
   */
  optimization?: PortfolioOptimization | null;
  /**
   * Task P2.20+ — active NHC cone for the demo storm. Drives the live event
   * strip above the map and overlays the cone polygon onto both panes.
   * `null` collapses the strip to its quiet "no active named storms" state
   * and the map renders unchanged.
   */
  cone?: FetchNhcConeResult | null;
  /** When the cone was fetched server-side. Drives the freshness chip. */
  coneRefreshedAt?: Date;
  /**
   * Live NWS active alerts (tornado / flood / severe thunderstorm / etc.)
   * scoped to the book's state footprint. Optional — when omitted or
   * empty the maps render without an alerts layer and the strip just
   * skips the chips.
   */
  alerts?: NwsAlert[];
  /**
   * Pre-computed per-category counts. Surfaced as chips on the
   * LiveEventStrip independent of whether a cone is active.
   */
  alertCounts?: NwsAlertCounts;
  /**
   * Per-ZIP3 `[lon, lat]` map centroids derived from the live policy book
   * (`lib/db/zip3_centroids.ts`). Both panes plot bubbles here and the
   * cone-classification math tests these positions. Defaults to `{}` so
   * the existing test renders still mount; the portfolio page always
   * passes the real centroids.
   */
  zip3Centroids?: Record<string, [number, number]>;
}

export function PortfolioMap({
  cohorts,
  optimization,
  cone = null,
  coneRefreshedAt,
  alerts,
  alertCounts,
  zip3Centroids = {},
}: Props) {
  const [selectedZip3, setSelectedZip3] = useState<string | null>(null);
  /**
   * Task P2.20 — `compareMode` flips the layout between a single map (default)
   * and a side-by-side current vs recommended view. The state lives at the
   * parent level so the toggle button can sit above both panes and the hover
   * sync state can span them.
   */
  const [compareMode, setCompareMode] = useState(false);
  /**
   * Task P2.20 — shared hover identity. `null` means nothing is hovered;
   * a string is the ZIP3 of the currently-hovered cohort. Both panes read
   * this and apply an emphasized stroke / opacity.
   */
  const [hoveredZip3, setHoveredZip3] = useState<string | null>(null);

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

  /** Shared row shape that both panes consume. */
  const zipRows = useMemo<ZipRow[]>(
    () =>
      Object.entries(zip3Totals).map(([zip3, { tiv, policies }]) => ({
        zip3,
        tiv,
        policies,
        action: zip3Actions[zip3]?.dominantActionByTiv ?? null,
      })),
    [zip3Totals, zip3Actions],
  );

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

  /**
   * Cone-classification: which ZIP3 centroids fall inside the active cone
   * polygon? Used by (a) the LiveEventStrip to surface book TIV under cone
   * and (b) each pane to paint a danger ring around at-risk circles. The
   * NHC cone is 100+ km wide and the centroid is accurate to ~10-20 km, so
   * the binary inside/outside classification is operationally sufficient.
   */
  const zip3sUnderCone = useMemo<Set<string>>(() => {
    if (!cone?.cone) return new Set();
    const polygon = cone.cone as PolygonLike;
    const hits = new Set<string>();
    for (const zip3 of Object.keys(zip3Totals)) {
      const centroid = zip3Centroids[zip3];
      if (!centroid) continue;
      if (pointInPolygon(centroid, polygon)) hits.add(zip3);
    }
    return hits;
  }, [cone, zip3Totals, zip3Centroids]);

  const exposureUnderConeTiv = useMemo(() => {
    let s = 0;
    for (const z of zip3sUnderCone) s += zip3Totals[z]?.tiv ?? 0;
    return s;
  }, [zip3sUnderCone, zip3Totals]);

  return (
    <div className="relative w-full h-full flex flex-col">
      {/*
        Task P2.20+ — live event strip above the map. Always renders so the eye
        learns where to look; collapses to a calm "Atlantic basin quiet" line
        when no cone is active. Sits in normal flow above the map (not absolute)
        so it owns its own vertical band rather than competing with overlays.
      */}
      <div className="px-3 pt-3 pb-2">
        <LiveEventStrip
          stormId={
            cone
              ? typeof (cone.cone as { properties?: { storm_id?: string } })?.properties
                  ?.storm_id === 'string'
                ? (cone.cone as { properties: { storm_id: string } }).properties.storm_id
                : 'Active storm'
              : null
          }
          advisoryNumber={cone?.advisory_number}
          peakWindMph={cone?.peak_wind}
          exposureUnderConeTiv={cone ? exposureUnderConeTiv : undefined}
          zip3sUnderCone={cone ? zip3sUnderCone.size : undefined}
          refreshedAt={coneRefreshedAt ?? new Date(0)}
          source={cone?.source}
          alertCounts={alertCounts}
        />
      </div>
      <div className="relative flex-1 min-h-0">
      {/*
        Task P2.20 — compare toggle. Keyboard accessible (native <button>),
        labelled so screen readers announce its purpose, and `aria-pressed`
        flips so AT users hear the current state. Disabled when there is no
        optimization to compare against (still visible so the affordance is
        discoverable, just inert).
      */}
      <div className="absolute top-3 right-3 z-[2]">
        <button
          type="button"
          onClick={() => setCompareMode((v) => !v)}
          aria-pressed={compareMode}
          aria-label="Compare current vs recommended portfolio"
          disabled={!optimization}
          className={[
            'rounded-md px-2.5 py-1.5 text-[11.5px] font-medium transition-colors',
            'bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75',
            'ring-1 shadow-[0_1px_2px_rgba(24,24,27,0.06)]',
            optimization ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
            compareMode
              ? 'text-emerald-800 ring-emerald-500/60 ring-2'
              : 'text-zinc-800 ring-zinc-200 hover:bg-white hover:text-zinc-900',
          ].join(' ')}
        >
          {compareMode ? 'Single view' : 'Compare current vs recommended'}
        </button>
      </div>

      {compareMode ? (
        <div
          data-testid="portfolio-compare-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            width: '100%',
            height: '100%',
          }}
        >
          <PortfolioMapPane
            mode="current"
            zipRows={zipRows}
            zip3Centroids={zip3Centroids}
            hoveredZip3={hoveredZip3}
            onHoverChange={setHoveredZip3}
            onSelectZip3={setSelectedZip3}
            ariaLabel="Current portfolio, every cohort is retained as-is today"
            testId="portfolio-pane-current"
            paneTitle="Current"
            paneSubtitle="Book as-is, every cohort retained"
            conePolygon={cone?.cone as PolygonLike | undefined}
            zip3sUnderCone={zip3sUnderCone}
            alerts={alerts}
          />
          <PortfolioMapPane
            mode="recommended"
            zipRows={zipRows}
            zip3Centroids={zip3Centroids}
            hoveredZip3={hoveredZip3}
            onHoverChange={setHoveredZip3}
            onSelectZip3={setSelectedZip3}
            ariaLabel="MIP-recommended portfolio, each ZIP3 colored by its dominant action"
            testId="portfolio-pane-recommended"
            paneTitle="MIP recommended"
            paneSubtitle="Color = dominant action by TIV share"
            conePolygon={cone?.cone as PolygonLike | undefined}
            zip3sUnderCone={zip3sUnderCone}
            alerts={alerts}
          />
        </div>
      ) : (
        <PortfolioMapPane
          mode={optimization ? 'recommended' : 'current'}
          zipRows={zipRows}
          zip3Centroids={zip3Centroids}
          hoveredZip3={hoveredZip3}
          onHoverChange={setHoveredZip3}
          onSelectZip3={setSelectedZip3}
          ariaLabel="Portfolio map"
          testId="portfolio-pane-single"
          conePolygon={cone?.cone as PolygonLike | undefined}
          zip3sUnderCone={zip3sUnderCone}
          alerts={alerts}
        />
      )}
      <div
        data-testid="portfolio-legend"
        className={[
          'absolute z-[2] max-w-[300px] rounded-lg p-3.5 text-[12px] text-zinc-800',
          'bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75',
          'ring-1 ring-zinc-200/70 shadow-[0_1px_2px_rgba(24,24,27,0.06)]',
          // In compare mode, the pane title chips own the top of each pane,
          // so we drop the legend to the bottom-left of the left (current)
          // pane. In single-pane mode it stays top-left as before.
          compareMode ? 'bottom-3 left-3' : 'top-3 left-3',
        ].join(' ')}
      >
        <div className="text-[10.5px] uppercase tracking-[0.12em] font-medium text-zinc-500 mb-1.5">
          Book exposure by ZIP3
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
          <dt className="text-zinc-500">Total TIV</dt>
          <dd className="text-right font-medium">
            ${aggregateTiv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </dd>
          <dt className="text-zinc-500">Policies</dt>
          <dd className="text-right font-medium">{aggregatePolicies.toLocaleString()}</dd>
          <dt className="text-zinc-500">ZIP3s</dt>
          <dd className="text-right font-medium">{Object.keys(zip3Totals).length}</dd>
        </dl>
        {optimization && (
          <div className="mt-3 pt-3 border-t hairline">
            <div className="text-[10.5px] uppercase tracking-[0.12em] font-medium text-zinc-500 mb-1.5">
              MIP recommendation
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
              <dt className="text-zinc-500">Expected margin</dt>
              <dd className="text-right font-medium">
                ${(optimization.objective / 1e6).toFixed(1)}M
              </dd>
              <dt className="text-zinc-500">Annual loss (p50/p99)</dt>
              <dd className="text-right font-medium">
                ${(optimization.book_totals.loss_p50 / 1e6).toFixed(1)}M ·{' '}
                ${(optimization.book_totals.loss_p99 / 1e6).toFixed(1)}M
              </dd>
            </dl>
            <div className="mt-2.5 grid grid-cols-[10px_1fr_auto] gap-x-2 gap-y-1 text-[11px] tabular-nums">
              {(Object.entries(optimization.action_summary) as [
                ActionName,
                { count: number; tiv: number },
              ][])
                .filter(([, v]) => v.tiv > 0)
                .sort((a, b) => b[1].tiv - a[1].tiv)
                .map(([action, v]) => (
                  <div key={action} className="contents">
                    <span
                      role="img"
                      aria-label={ACTION_LABELS[action]}
                      className="h-2.5 w-2.5 rounded-full self-center"
                      style={{ background: ACTION_COLORS[action] }}
                    />
                    <span className="text-zinc-700">{ACTION_LABELS[action]}</span>
                    <span className="text-zinc-500 text-right">
                      {((v.tiv / aggregateTiv) * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
            </div>
            <p className="mt-2 text-[10px] text-zinc-500 leading-snug">
              Color = MIP&apos;s dominant recommendation by TIV-weighted share.
            </p>
          </div>
        )}
        <p className="mt-2.5 text-[10.5px] text-zinc-500 leading-snug">
          Click a circle to inspect its cohorts and recommended actions.
        </p>
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
    </div>
  );
}
