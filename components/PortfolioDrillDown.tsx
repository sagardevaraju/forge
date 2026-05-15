'use client';
/**
 * Task 20 — Drill-down panel for a single ZIP3 within the Portfolio Map.
 *
 * Listed in a fixed right-rail card so the user can see the underlying
 * cohorts behind the aggregate circle they clicked on the map.
 */
import type { Cohort } from '@/lib/db/cohorts';

interface Props {
  zip3: string;
  cohorts: Cohort[];
  onClose: () => void;
}

export function PortfolioDrillDown({ zip3, cohorts, onClose }: Props) {
  const totalTiv = cohorts.reduce((s, c) => s + c.total_tiv, 0);
  const totalPolicies = cohorts.reduce((s, c) => s + c.policy_count, 0);
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 360,
        maxHeight: '90%',
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
        style={{ float: 'right', border: 'none', background: 'transparent', cursor: 'pointer' }}
      >
        ✕
      </button>
      <h3 style={{ fontWeight: 600, marginBottom: 12 }}>ZIP3 {zip3}</h3>
      <div>
        Total TIV: $
        {totalTiv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </div>
      <div>Policies: {totalPolicies.toLocaleString()}</div>
      <h4 style={{ marginTop: 12, marginBottom: 8, fontWeight: 600 }}>Cohorts</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
            <th style={{ textAlign: 'left', padding: 4 }}>Cohort</th>
            <th style={{ textAlign: 'right', padding: 4 }}>Policies</th>
            <th style={{ textAlign: 'right', padding: 4 }}>TIV</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: 4, fontFamily: 'monospace' }}>{c.id}</td>
              <td style={{ padding: 4, textAlign: 'right' }}>{c.policy_count}</td>
              <td style={{ padding: 4, textAlign: 'right' }}>
                ${(c.total_tiv / 1e6).toFixed(1)}M
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: 12, fontSize: 11, color: '#6b7280' }}>
        MIP recommendation column will appear here once the optimize endpoint is wired (Task 23
        cron + future integration).
      </p>
    </div>
  );
}
