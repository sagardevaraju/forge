'use client';
/**
 * Drilldown panel for a single ZIP3 within the Portfolio Map. (Task 13 adds
 * the Property-features sub-section + unmodeled-dim transparency footnote.)
 *
 * Shows the cohorts inside the clicked ZIP3 along with the MIP-recommended
 * action mix per cohort. Dominant action is the row badge; minor fractions
 * appear as inline split-bars so the user can see when the optimizer is
 * recommending a blended action (e.g. 70% reprice-up + 30% cede_xs).
 *
 * Property features (Task 13) renders only the 5 modeled CV-head dims; the
 * 3 unmodeled dims (imperviousness, roof_complexity, tree_overhang) are
 * dropped and called out in a footnote so reviewers don't mistake the
 * absence for a bug.
 */
import { type Cohort, type CvFeatures, UNMODELED_CV_DIMS } from '@/lib/db/cohorts';
import {
  type OptimizedAction,
  type ActionName,
  ACTION_LABELS,
  ACTION_COLORS,
} from '@/lib/portfolio-actions';
import { renderRecommendation } from '@/lib/portfolio/narrative';

interface Props {
  zip3: string;
  cohorts: Cohort[];
  /** Optional — when omitted (or the cache is missing) the action column
   * renders an em-dash and a footnote prompts the user to run the
   * precompute script. */
  actionByCohort?: Record<string, OptimizedAction>;
  onClose: () => void;
}

const ACTIONS: ActionName[] = [
  'retain',
  'reprice_up',
  'reprice_down',
  'non_renew',
  'cede_qs',
  'cede_xs',
];

/** Human-friendly labels for the 5 modeled CV dims rendered in the panel. */
const CV_DIM_LABELS: Record<keyof CvFeatures, string> = {
  vegetation_density: 'Vegetation density',
  fuel_proximity: 'Fuel proximity',
  water_proximity: 'Water proximity',
  elevation_bucket: 'Elevation bucket',
  structure_density: 'Structure density',
};

/**
 * Average a per-dim CvFeatureValue across the cohorts in the drilled ZIP3,
 * weighted by policy count so a big cohort doesn't get drowned out by a
 * 1-policy sliver. Returns the same shape as a single cohort's CvFeatures.
 */
function averageCvFeatures(cohorts: Cohort[]): CvFeatures | null {
  const totalPolicies = cohorts.reduce((s, c) => s + c.policy_count, 0);
  if (totalPolicies === 0) return null;
  const dims = Object.keys(CV_DIM_LABELS) as Array<keyof CvFeatures>;
  const acc = {} as CvFeatures;
  for (const d of dims) {
    let weighted = 0;
    for (const c of cohorts) {
      weighted += c.avg_cv_features[d].value * c.policy_count;
    }
    acc[d] = { value: weighted / totalPolicies, modeled: true };
  }
  return acc;
}

function ActionSplitBar({ action }: { action: OptimizedAction }) {
  const segments = ACTIONS.map((a) => ({ a, frac: action[a] })).filter(
    (s) => s.frac > 0.005,
  );
  if (segments.length === 0) return null;
  return (
    <div
      role="img"
      aria-label={`action mix ${segments.map((s) => `${ACTION_LABELS[s.a]} ${(s.frac * 100).toFixed(0)}%`).join(', ')}`}
      style={{
        display: 'flex',
        width: '100%',
        height: 8,
        borderRadius: 2,
        overflow: 'hidden',
        border: '1px solid #e5e7eb',
      }}
    >
      {segments.map((s) => (
        <div
          key={s.a}
          style={{
            flexGrow: s.frac,
            background: ACTION_COLORS[s.a],
          }}
          title={`${ACTION_LABELS[s.a]}: ${(s.frac * 100).toFixed(0)}%`}
        />
      ))}
    </div>
  );
}

export function PortfolioDrillDown({ zip3, cohorts, actionByCohort, onClose }: Props) {
  const totalTiv = cohorts.reduce((s, c) => s + c.total_tiv, 0);
  const totalPolicies = cohorts.reduce((s, c) => s + c.policy_count, 0);
  const actions = actionByCohort ?? {};
  const hasOptimization = Object.keys(actions).length > 0;
  const propertyFeatures = averageCvFeatures(cohorts);
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 420,
        maxHeight: '92%',
        overflow: 'auto',
        background: 'white',
        padding: 16,
        border: '1px solid #e5e7eb',
        borderRadius: 4,
        fontSize: 13,
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close drill-down"
        style={{
          float: 'right',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 16,
          color: '#52525b',
        }}
      >
        ✕
      </button>
      <h3 style={{ fontWeight: 600, marginBottom: 8 }}>ZIP3 {zip3}</h3>
      <div style={{ color: '#3f3f46' }}>
        Total TIV: $
        {totalTiv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </div>
      <div style={{ color: '#3f3f46' }}>Policies: {totalPolicies.toLocaleString()}</div>
      {hasOptimization && (
        <p style={{ color: '#18181b', marginTop: 8 }}>
          {renderRecommendation(cohorts.map((c) => actions[c.id]).filter(Boolean))}
        </p>
      )}
      <h4 style={{ marginTop: 14, marginBottom: 6, fontWeight: 600 }}>
        Cohorts {hasOptimization ? '· recommended actions' : ''}
      </h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb', color: '#52525b' }}>
            <th style={{ textAlign: 'left', padding: '4px 6px 4px 0' }}>Cohort</th>
            <th style={{ textAlign: 'right', padding: 4 }}>TIV</th>
            <th style={{ textAlign: 'left', padding: 4 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => {
            const a = actions[c.id];
            return (
              <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '4px 6px 4px 0', fontFamily: 'monospace' }}>
                  {c.id}
                </td>
                <td style={{ padding: 4, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  ${(c.total_tiv / 1e6).toFixed(1)}M
                </td>
                <td style={{ padding: 4, minWidth: 150 }}>
                  {a ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          aria-hidden
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: ACTION_COLORS[a.dominant_action],
                            display: 'inline-block',
                          }}
                        />
                        <span style={{ color: '#18181b' }}>
                          {ACTION_LABELS[a.dominant_action]}
                          {a.dominant_share < 0.99 && (
                            <span style={{ color: '#6b7280' }}>
                              {' '}
                              · {(a.dominant_share * 100).toFixed(0)}%
                            </span>
                          )}
                        </span>
                      </div>
                      <ActionSplitBar action={a} />
                    </div>
                  ) : (
                    <span style={{ color: '#9ca3af' }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {propertyFeatures && (
        <section
          aria-label="Property features"
          data-testid="property-features"
          style={{ marginTop: 18 }}
        >
          <h4 style={{ marginBottom: 6, fontWeight: 600 }}>Property features</h4>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
              tableLayout: 'fixed',
            }}
          >
            <tbody>
              {(Object.keys(CV_DIM_LABELS) as Array<keyof CvFeatures>).map((d) => {
                const f = propertyFeatures[d];
                const pct = Math.round(f.value * 100);
                return (
                  <tr key={d} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td
                      style={{
                        padding: '4px 6px 4px 0',
                        color: '#3f3f46',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {CV_DIM_LABELS[d]}
                    </td>
                    <td style={{ padding: 4, width: '100%' }}>
                      <div
                        role="img"
                        aria-label={`${CV_DIM_LABELS[d]} ${pct} percent`}
                        style={{
                          height: 6,
                          background: '#f3f4f6',
                          borderRadius: 2,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${pct}%`,
                            height: '100%',
                            background: '#3f3f46',
                          }}
                        />
                      </div>
                    </td>
                    <td
                      style={{
                        padding: 4,
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        color: '#52525b',
                        width: 44,
                      }}
                    >
                      {f.value.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
            Three CV dims ({UNMODELED_CV_DIMS.join(', ')}) are unmodeled in
            this build; Phase 2 swaps in NLCD + OSM weak labels.
          </p>
        </section>
      )}
      {!hasOptimization && (
        <p style={{ marginTop: 12, fontSize: 11, color: '#6b7280' }}>
          Optimization cache not available — run{' '}
          <code>scripts/precompute_portfolio_optimization.py</code>.
        </p>
      )}
    </div>
  );
}
