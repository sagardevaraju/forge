'use client';
/**
 * Task 22 — Claims Pre-Brief table.
 *
 * Renders pre-flagged policies returned by the server component, with a
 * severity tier filter and a one-click CSV export. The export builds the
 * blob in-memory and uses `URL.createObjectURL` so we don't need a
 * server-side download endpoint for the demo.
 */
import { useState, useMemo } from 'react';

export interface PreflagPolicy {
  policy_id: number;
  zip3: string;
  tiv: number;
  build_type: string;
  flood_zone: string;
  severity: 'low' | 'medium' | 'high';
  expected_loss: number;
}

interface Props {
  policies: PreflagPolicy[];
}

type SeverityFilter = 'all' | 'low' | 'medium' | 'high';

export function ClaimsTable({ policies }: Props) {
  const [filter, setFilter] = useState<SeverityFilter>('all');

  const filtered = useMemo(
    () => (filter === 'all' ? policies : policies.filter((p) => p.severity === filter)),
    [filter, policies],
  );

  const counts = useMemo(
    () => ({
      high: policies.filter((p) => p.severity === 'high').length,
      medium: policies.filter((p) => p.severity === 'medium').length,
      low: policies.filter((p) => p.severity === 'low').length,
    }),
    [policies],
  );

  function exportCsv() {
    const header = 'policy_id,zip3,tiv,build_type,flood_zone,severity,expected_loss\n';
    const rows = filtered
      .map(
        (p) =>
          `${p.policy_id},${p.zip3},${p.tiv},${p.build_type},${p.flood_zone},${p.severity},${p.expected_loss.toFixed(0)}`,
      )
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preflag.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div data-testid="claims-table">
      <div className="flex gap-2 mb-3 items-center">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as SeverityFilter)}
          className="border rounded px-2 py-1 text-sm"
          aria-label="severity-filter"
        >
          <option value="all">All ({policies.length})</option>
          <option value="high">High ({counts.high})</option>
          <option value="medium">Medium ({counts.medium})</option>
          <option value="low">Low ({counts.low})</option>
        </select>
        <button
          onClick={exportCsv}
          className="bg-zinc-900 text-white px-3 py-1 rounded text-sm"
        >
          Export CSV
        </button>
        <span className="text-xs text-zinc-500" data-testid="filtered-count">
          Showing {filtered.length}
        </span>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th className="text-left p-2">Policy ID</th>
            <th className="text-left p-2">ZIP3</th>
            <th className="text-right p-2">TIV</th>
            <th className="text-left p-2">Build</th>
            <th className="text-left p-2">Flood zone</th>
            <th className="text-left p-2">Severity</th>
            <th className="text-right p-2">Expected loss</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.policy_id} className="border-b hover:bg-zinc-50">
              <td className="p-2 font-mono text-xs">{p.policy_id}</td>
              <td className="p-2">{p.zip3}</td>
              <td className="p-2 text-right">${p.tiv.toLocaleString()}</td>
              <td className="p-2">{p.build_type}</td>
              <td className="p-2">{p.flood_zone}</td>
              <td
                className={`p-2 font-medium ${
                  p.severity === 'high'
                    ? 'text-red-600'
                    : p.severity === 'medium'
                      ? 'text-orange-600'
                      : 'text-zinc-600'
                }`}
              >
                {p.severity}
              </td>
              <td className="p-2 text-right">
                ${p.expected_loss.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
