'use client';
/**
 * Task 22 — Claims Pre-Brief table.
 * Task 19 — Group rows by ZIP3 → county header rows.
 *
 * Renders pre-flagged policies returned by the server component, with a
 * severity tier filter and a one-click CSV export. The export builds the
 * blob in-memory and uses `URL.createObjectURL` so we don't need a
 * server-side download endpoint for the demo.
 *
 * Rows are grouped by ZIP3. Each group is preceded by a header row that
 * shows the county label (from `lib/regulatory/zip3_to_county.ts`), the
 * ZIP3, a policy count, and a TIV rollup. Severity filtering hides
 * individual policies; when a group has zero visible policies after the
 * filter is applied, the header is omitted as well so the table doesn't
 * render empty section banners.
 */
import { useState, useMemo, Fragment } from 'react';
import { zip3ToCounty } from '@/lib/regulatory/zip3_to_county';

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

interface Zip3Group {
  zip3: string;
  county: string;
  policies: PreflagPolicy[];
  tivRollup: number;
}

/**
 * Group the filtered policy list by ZIP3, preserving the first-seen order
 * so the table doesn't reshuffle when the severity filter changes. Returns
 * one entry per ZIP3 with the resolved county label, the policies in that
 * ZIP3, and a TIV rollup for the header row.
 */
function groupByZip3(policies: PreflagPolicy[]): Zip3Group[] {
  const order: string[] = [];
  const groups: Record<string, Zip3Group> = {};
  for (const p of policies) {
    if (!groups[p.zip3]) {
      order.push(p.zip3);
      groups[p.zip3] = {
        zip3: p.zip3,
        county: zip3ToCounty(p.zip3),
        policies: [],
        tivRollup: 0,
      };
    }
    groups[p.zip3].policies.push(p);
    groups[p.zip3].tivRollup += p.tiv;
  }
  return order.map((z) => groups[z]);
}

export function ClaimsTable({ policies }: Props) {
  const [filter, setFilter] = useState<SeverityFilter>('all');

  const filtered = useMemo(
    () => (filter === 'all' ? policies : policies.filter((p) => p.severity === filter)),
    [filter, policies],
  );

  const groups = useMemo(() => groupByZip3(filtered), [filtered]);

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
          {groups.map((g) => (
            <Fragment key={g.zip3}>
              <tr
                className="bg-zinc-100 border-b border-zinc-300"
                data-testid={`zip3-group-${g.zip3}`}
              >
                <td
                  colSpan={7}
                  className="p-2 font-semibold text-zinc-800 text-xs uppercase tracking-wide"
                >
                  {g.county} · ZIP3 {g.zip3} · {g.policies.length}{' '}
                  {g.policies.length === 1 ? 'policy' : 'policies'} · $
                  {(g.tivRollup / 1e6).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                    minimumFractionDigits: 1,
                  })}
                  M TIV
                </td>
              </tr>
              {g.policies.map((p) => (
                <tr key={p.policy_id} className="border-b hover:bg-zinc-50">
                  <td className="p-2 font-mono text-xs">{p.policy_id}</td>
                  <td className="p-2">{p.zip3}</td>
                  <td className="p-2 text-right">${p.tiv.toLocaleString()}</td>
                  <td className="p-2">{p.build_type}</td>
                  <td className="p-2">{p.flood_zone}</td>
                  <td
                    className={`p-2 font-medium ${
                      p.severity === 'high'
                        ? 'text-red-700'
                        : p.severity === 'medium'
                          ? 'text-orange-700'
                          : 'text-zinc-700'
                    }`}
                  >
                    {p.severity}
                  </td>
                  <td className="p-2 text-right">
                    ${p.expected_loss.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
