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
import type { Cohort } from '@/lib/db/cohorts';
import {
  type PortfolioOptimization,
  type ActionName,
  indexByZip3,
  ACTION_COLORS,
  ACTION_LABELS,
} from '@/lib/portfolio-actions';

interface Props {
  cohorts: Cohort[];
  optimization: PortfolioOptimization | null;
}

export function PortfolioMap({ cohorts, optimization }: Props) {
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

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/*
        Task P2.20 — compare toggle. Keyboard accessible (native <button>),
        labelled so screen readers announce its purpose, and `aria-pressed`
        flips so AT users hear the current state. Disabled when there is no
        optimization to compare against (still visible so the affordance is
        discoverable, just inert).
      */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 2,
        }}
      >
        <button
          type="button"
          onClick={() => setCompareMode((v) => !v)}
          aria-pressed={compareMode}
          aria-label="Compare current vs recommended portfolio"
          disabled={!optimization}
          style={{
            background: 'white',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            padding: '6px 10px',
            fontSize: 12,
            fontWeight: 600,
            cursor: optimization ? 'pointer' : 'not-allowed',
            opacity: optimization ? 1 : 0.6,
            boxShadow: compareMode ? 'inset 0 0 0 2px #2563eb' : 'none',
            color: compareMode ? '#1d4ed8' : '#111827',
          }}
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
            hoveredZip3={hoveredZip3}
            onHoverChange={setHoveredZip3}
            onSelectZip3={setSelectedZip3}
            ariaLabel="Current portfolio — every cohort is retained as-is today"
            testId="portfolio-pane-current"
          />
          <PortfolioMapPane
            mode="recommended"
            zipRows={zipRows}
            hoveredZip3={hoveredZip3}
            onHoverChange={setHoveredZip3}
            onSelectZip3={setSelectedZip3}
            ariaLabel="MIP-recommended portfolio — each ZIP3 colored by its dominant action"
            testId="portfolio-pane-recommended"
          />
        </div>
      ) : (
        <PortfolioMapPane
          mode={optimization ? 'recommended' : 'current'}
          zipRows={zipRows}
          hoveredZip3={hoveredZip3}
          onHoverChange={setHoveredZip3}
          onSelectZip3={setSelectedZip3}
          ariaLabel="Portfolio map"
          testId="portfolio-pane-single"
        />
      )}
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
                      role="img"
                      aria-label={ACTION_LABELS[action]}
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
            {/* Task 18 — explain what the swatch colors actually encode. */}
            <p style={{ marginTop: 6, fontSize: 10, color: '#6b7280' }}>
              Color = MIP&apos;s dominant recommendation by TIV-weighted share.
            </p>
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
