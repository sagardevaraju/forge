/**
 * Task 20 — Portfolio Map route.
 *
 * Server component: aggregates the policy book into cohorts then hands the
 * list to the client `PortfolioMap`. `force-dynamic` ensures the visualization
 * reflects the latest book state (e.g. after the seed or reconciliation jobs)
 * without per-deploy caching getting in the way during the prototype phase.
 *
 * The autonomous build deliberately skips the live MIP call here. Once the
 * `/api/optimize_portfolio` endpoint lands (planned alongside Task 23's cron),
 * this component will await its result and pass the recommendations into the
 * map for the drill-down panel to display.
 */
import { aggregateCohorts } from '@/lib/db/cohorts';
import { PortfolioMap } from '@/components/PortfolioMap';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const cohorts = await aggregateCohorts();
  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-bold mb-4">Portfolio Map</h1>
      <p className="text-sm text-zinc-600 mb-4">{cohorts.length} cohorts loaded from book</p>
      <div className="h-[60vh] border rounded">
        <PortfolioMap cohorts={cohorts} />
      </div>
    </main>
  );
}
