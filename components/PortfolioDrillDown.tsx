'use client';
/**
 * Drilldown panel for a single ZIP3 within the Portfolio Map.
 *
 * Shows the cohorts inside the clicked ZIP3 along with the MIP-recommended
 * action mix per cohort. Dominant action is the row badge; minor fractions
 * appear as inline split-bars so the user can see when the optimizer is
 * recommending a blended action (e.g. 70% reprice-up + 30% cede_xs).
 */
import type { Cohort } from '@/lib/db/cohorts';
import {
  type OptimizedAction,
  type ActionName,
  ACTION_LABELS,
  ACTION_COLORS,
} from '@/lib/portfolio-actions';

interface Props {
  zip3: string;
  cohorts: Cohort[];
  actionByCohort: Record<string, OptimizedAction>;
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
  const hasOptimization = Object.keys(actionByCohort).length > 0;
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
            const a = actionByCohort[c.id];
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
      {!hasOptimization && (
        <p style={{ marginTop: 12, fontSize: 11, color: '#6b7280' }}>
          Optimization cache not available — run{' '}
          <code>scripts/precompute_portfolio_optimization.py</code>.
        </p>
      )}
    </div>
  );
}
