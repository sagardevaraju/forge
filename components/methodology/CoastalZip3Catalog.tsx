/**
 * AUDIT.3 Phase 4 follow-up — renders the 38-ZIP3 coastal catalog on
 * `/methodology`. Pure client component: takes a typed
 * `CoastalZip3Catalog` payload (loaded server-side from
 * `artifacts/coastal_zip3s.json`) and lays it out as a sortable-looking
 * compact table plus a small provenance footer.
 *
 * Trust tier badge per [[forge-phase-roadmap]] AUDIT.3 Phase 4 follow-up
 * brief: the *underlying* source — USGS National Elevation Dataset via
 * the Elevation Point Query Service — is a live external feed in the
 * sense of the grammar contract; the artifact file is just the cached
 * snapshot from the most recent regeneration. The footer makes the
 * "cached + regenerable" nature explicit so the LIVE_FEED badge reads
 * honestly against `CLAUDE.md` Data-integrity §3.
 */
'use client';

import type { CoastalZip3Catalog } from '@/lib/methodology/coastal_zip3s';

interface CoastalZip3CatalogProps {
  payload: CoastalZip3Catalog;
}

function formatElev(elev: number): string {
  // Sub-meter precision matches the EPQS response and lines up the
  // negative coastal-FL ZIP3s (Naples 341 = -1.25 m) with the
  // mountain inland ones (Asheville 287 = 631.48 m) in the same column.
  return `${elev.toFixed(1)} m`;
}

function formatCoord(value: number): string {
  // 4 dp ≈ 11 m of horizontal resolution — enough for the ZIP3
  // centroid; finer precision would imply we trust the synthetic
  // lat/lon below the policy-sampling Gaussian width.
  return value.toFixed(4);
}

export function CoastalZip3Catalog({ payload }: CoastalZip3CatalogProps) {
  // Sort by elevation descending so the inland-mountain → coastal-flat
  // gradient is visible at a glance — Asheville 287 at the top,
  // Naples 341 at the bottom.
  const rows = Object.entries(payload.catalog)
    .map(([zip3, entry]) => ({ zip3, ...entry }))
    .sort((a, b) => b.elev_m - a.elev_m);

  return (
    <div className="rounded-md ring-1 ring-zinc-200/70 bg-white">
      <div className="px-4 py-2 border-b border-zinc-100 flex items-baseline justify-between gap-3">
        <div className="text-[12px] font-mono text-zinc-700">
          {payload.n_zip3s} ZIP3s · {payload.source.coastal_states.join(' · ')}
        </div>
        <div className="text-[10.5px] text-zinc-500">
          min {payload.source.min_policies_per_zip3} policies / ZIP3
        </div>
      </div>
      <div className="overflow-x-auto">
        <table
          className="w-full text-[12px] font-mono"
          aria-label="Coastal ZIP3 catalog"
          data-testid="coastal-zip3-table"
        >
          <thead className="text-zinc-500 text-[10.5px] uppercase tracking-[0.06em]">
            <tr className="border-b border-zinc-100">
              <th className="text-left px-4 py-1.5 font-medium">ZIP3</th>
              <th className="text-right px-4 py-1.5 font-medium">Policies</th>
              <th className="text-right px-4 py-1.5 font-medium">Latitude</th>
              <th className="text-right px-4 py-1.5 font-medium">Longitude</th>
              <th className="text-right px-4 py-1.5 font-medium">Elevation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.zip3}
                className="border-b border-zinc-50 last:border-0 hover:bg-zinc-50/60"
              >
                <td className="px-4 py-1.5 text-zinc-900">{r.zip3}</td>
                <td className="px-4 py-1.5 text-right text-zinc-700">
                  {r.n_policies.toLocaleString()}
                </td>
                <td className="px-4 py-1.5 text-right text-zinc-600">
                  {formatCoord(r.lat)}
                </td>
                <td className="px-4 py-1.5 text-right text-zinc-600">
                  {formatCoord(r.lon)}
                </td>
                <td className="px-4 py-1.5 text-right text-zinc-900">
                  {formatElev(r.elev_m)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-zinc-100 text-[11px] text-zinc-500 leading-relaxed">
        Centroids: {payload.source.centroid}. Elevations:{' '}
        {payload.source.elevation} (
        <a
          href={payload.source.epqs_url}
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
          target="_blank"
          rel="noreferrer"
        >
          {payload.source.epqs_url}
        </a>
        ). Cached in <code className="font-mono">artifacts/coastal_zip3s.json</code>; regenerate
        with <code className="font-mono">python -m scripts.precompute_coastal_zip3s</code>.
      </div>
    </div>
  );
}
