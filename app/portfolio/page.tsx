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
 * Refresh the optimization with `python -m scripts.precompute_portfolio_optimization`.
 */
import { aggregateCohorts } from '@/lib/db/cohorts';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { PortfolioMap } from '@/components/PortfolioMap';
import { PortfolioHeader } from '@/components/PortfolioHeader';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const [cohorts, optimization] = await Promise.all([
    aggregateCohorts(),
    loadPortfolioOptimization(),
  ]);
  const totalTiv = cohorts.reduce((s, c) => s + c.total_tiv, 0);
  const nonrenewUsedTiv = optimization?.action_summary?.non_renew?.tiv ?? 0;
  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-bold mb-4">Portfolio Map</h1>
      <PortfolioHeader
        totalTiv={totalTiv}
        objective={optimization?.objective ?? 0}
        capitalUsed={optimization?.book_totals.loss_p99 ?? 0}
        capitalBudget={optimization?.budgets.capital_budget ?? 1e8}
        nonrenewUsedTiv={nonrenewUsedTiv}
        nonrenewCapTiv={totalTiv * (optimization?.budgets.max_nonrenew_pct ?? 0.1)}
        cessionSpend={0}
        cessionBudget={optimization?.budgets.cession_budget ?? 5e6}
      />
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
    </main>
  );
}
