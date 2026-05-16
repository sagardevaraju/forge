/**
 * Portfolio Map route.
 *
 * Server component: aggregates the policy book into cohorts and loads the
 * cached Portfolio MIP optimization, then hands both into the client map.
 * `force-dynamic` so the page reflects the latest book state after any
 * upload / seed / reconciliation pass without per-deploy caching getting
 * in the way.
 *
 * Refresh the optimization with `python -m scripts.precompute_portfolio_optimization`.
 */
import { aggregateCohorts } from '@/lib/db/cohorts';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { PortfolioMap } from '@/components/PortfolioMap';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const [cohorts, optimization] = await Promise.all([
    aggregateCohorts(),
    loadPortfolioOptimization(),
  ]);
  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-bold mb-2">Portfolio Map</h1>
      <p className="text-sm text-zinc-600 mb-4">
        {cohorts.length} cohorts loaded from book
        {optimization
          ? ` · MIP status: ${optimization.status} · objective $${(optimization.objective / 1e6).toFixed(1)}M`
          : ' · MIP cache missing — run scripts/precompute_portfolio_optimization.py'}
      </p>
      <div className="h-[60vh] border rounded">
        <PortfolioMap cohorts={cohorts} optimization={optimization} />
      </div>
    </main>
  );
}
