/**
 * Portfolio Map route.
 *
 * Server component: aggregates the policy book into cohorts and loads the
 * cached Portfolio MIP optimization, then hands both into the client map.
 * `force-dynamic` so the page reflects the latest book state after any
 * upload / seed / reconciliation pass without per-deploy caching getting
 * in the way.
 *
 * Task 9 (Redesign Phase 1): a five-ExecCard `PortfolioHeader` strip is
 * mounted above the map and a `ProvenanceFootnote` underneath, so the page
 * advertises both its book-level scalars and the source/method/confidence
 * provenance the redesign brief demands.
 *
 * Task P2.13 (Phase 2): the header is now wrapped by `PortfolioWhatIfShell`,
 * which adds a sticky right-rail of three `WhatIfControl` sliders bound to
 * the three MIP budgets. Commits POST to `/api/optimize/portfolio` and the
 * ExecCard strip re-renders with the new objective + capital usage plus a
 * delta vs the original solve. The server component still loads the initial
 * artifact; the shell owns the interactive state.
 *
 * Refresh the optimization with `python -m scripts.precompute_portfolio_optimization`.
 */
import { aggregateCohorts } from '@/lib/db/cohorts';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { PortfolioMap } from '@/components/PortfolioMap';
import { PortfolioWhatIfShell } from '@/components/PortfolioWhatIfShell';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const [cohorts, optimizationRaw] = await Promise.all([
    aggregateCohorts(),
    loadPortfolioOptimization(),
  ]);
  // Task P2.0: schema_version 3 ships per-cohort `loss_scenarios` arrays
  // (K=1000 lognormal draws) for downstream P2.6 / P2.7 / P2.8 use. Those
  // arrays are server-side only — at ~1000 floats × ~570 cohorts they
  // weigh ~4.5 MB which we refuse to push down the wire. Strip them here
  // before the client component touches the optimization object. Summary
  // statistics (p50 / p99) stay on the cohort and continue to flow to the
  // browser as before.
  const optimization = optimizationRaw
    ? {
        ...optimizationRaw,
        cohorts: optimizationRaw.cohorts.map((c) => {
          const { loss_scenarios: _stripped, ...rest } = c;
          return rest;
        }),
      }
    : null;
  const totalTiv = cohorts.reduce((s, c) => s + c.total_tiv, 0);
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Portfolio Map</h1>
      {optimization ? (
        <PortfolioWhatIfShell initialOptimization={optimization} totalTiv={totalTiv} />
      ) : (
        <p className="text-sm text-zinc-600 mb-4">
          Portfolio optimization artifact missing — run{' '}
          <code>python -m scripts.precompute_portfolio_optimization</code>.
        </p>
      )}
      <div className="h-[60vh] border rounded">
        <PortfolioMap cohorts={cohorts} optimization={optimization} />
      </div>
      <ProvenanceFootnote
        source="policies table (synthetic seed via scripts/seed_policy_book.py)"
        method="lib/db/cohorts::aggregateCohorts + api_py/optimize_portfolio::solve"
        confidence={
          optimization
            ? `MIP status ${optimization.status} · objective $${(optimization.objective / 1e6).toFixed(1)}M`
            : 'optimization cache missing'
        }
      />
    </div>
  );
}
