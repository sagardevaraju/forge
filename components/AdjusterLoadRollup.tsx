/**
 * Task P2.28 — Expected adjuster-load rollup component.
 *
 * Rendered above the ClaimsTable on the `/claims` pre-brief. Each row shows
 * one ZIP3 affected by the pre-flagged policy set with:
 *   - real county label (resolved via `lib/regulatory/zip3_geo.ts`)
 *   - policy_count contributing
 *   - needed = ceil(Σ expected_loss / DOLLARS_PER_ADJUSTER)
 *   - baseline staffing assumption (ADJUSTER_LOAD_BASELINE_PER_ZIP3)
 *   - delta = needed - baseline   (+N short-staffed / -N surplus)
 *
 * Trust tier badge: MODEL_OUTPUT — the load signal derives from the
 * Portfolio MIP cohort prior. The baseline staffing constant is documented
 * inline as a heuristic until a real VRP / staffing feed lands.
 *
 * The component is a pure server-renderable function (no `'use client'`)
 * because the rollup is computed on the server and we want the page to
 * stream the rendered HTML on first paint with no client hydration cost
 * for this section.
 */
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { zip3CountyLabel } from '@/lib/regulatory/zip3_geo';
import type { AdjusterLoadRollup as AdjusterLoadRollupData } from '@/lib/reconciler/adjuster_load';
import {
  ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER,
  ADJUSTER_LOAD_BASELINE_PER_ZIP3,
} from '@/lib/reconciler/adjuster_load';

interface Props {
  rollup: AdjusterLoadRollupData;
}

function formatDelta(d: number): string {
  if (d > 0) return `+${d}`;
  if (d < 0) return `${d}`;
  return '0';
}

function deltaColor(d: number): string {
  if (d > 0) return 'text-red-700';
  if (d < 0) return 'text-emerald-700';
  return 'text-zinc-600';
}

export function AdjusterLoadRollup({ rollup }: Props) {
  const dollarsPerAdjusterK = Math.round(
    ADJUSTER_LOAD_DOLLARS_PER_ADJUSTER / 1_000,
  );

  return (
    <section
      data-testid="adjuster-load-rollup"
      className="mb-4 rounded border border-zinc-200 bg-zinc-50 p-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-zinc-800">
          Expected adjuster-load
        </h2>
        <TrustTierBadge tier="MODEL_OUTPUT" />
        {rollup.rows.length > 0 && (
          <span
            data-testid="rollup-summary"
            className="ml-auto text-xs font-medium text-zinc-700"
          >
            {rollup.total_needed} needed
            {' · '}
            <span className={deltaColor(rollup.total_delta)}>
              {formatDelta(rollup.total_delta)} vs baseline
            </span>
            {' · '}
            {rollup.rows.length} ZIP3{rollup.rows.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {rollup.rows.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No flagged policies have a matching cohort prior. Adjuster-load
          rollup is empty until the Portfolio MIP cache is refreshed.
        </p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-zinc-200 text-zinc-500">
              <th className="text-left p-1.5 font-medium">ZIP3 · County</th>
              <th className="text-right p-1.5 font-medium">Policies</th>
              <th className="text-right p-1.5 font-medium">Σ loss</th>
              <th className="text-right p-1.5 font-medium">Needed</th>
              <th className="text-right p-1.5 font-medium">Baseline</th>
              <th className="text-right p-1.5 font-medium">Delta</th>
            </tr>
          </thead>
          <tbody>
            {rollup.rows.map((r) => (
              <tr
                key={r.zip3}
                data-testid={`rollup-row-${r.zip3}`}
                className="border-b border-zinc-100"
              >
                <td className="p-1.5 font-mono">
                  {r.zip3}{' '}
                  <span className="text-zinc-500">· {zip3CountyLabel(r.zip3)}</span>
                </td>
                <td className="p-1.5 text-right tabular-nums">
                  {r.policy_count}
                </td>
                <td className="p-1.5 text-right tabular-nums">
                  ${(r.total_expected_loss / 1e6).toFixed(2)}M
                </td>
                <td className="p-1.5 text-right tabular-nums font-medium">
                  {r.needed}
                </td>
                <td className="p-1.5 text-right tabular-nums text-zinc-500">
                  {r.baseline}
                </td>
                <td
                  className={`p-1.5 text-right tabular-nums font-semibold ${deltaColor(r.delta)}`}
                >
                  {formatDelta(r.delta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-2 text-[10px] text-zinc-500">
        Formula: <code>needed = ceil(Σ cohort-loss / ${dollarsPerAdjusterK}K)</code>{' '}
        per ZIP3, with a baseline of {ADJUSTER_LOAD_BASELINE_PER_ZIP3}{' '}
        adjusters/ZIP3. Cohort losses come from the Portfolio MIP prior
        (<code>artifacts/portfolio_optimization.json</code>). Baseline is a
        heuristic until the Operational LP exposes{' '}
        <code>demand_adjustments</code> per ZIP3.
      </p>
    </section>
  );
}
