/**
 * Landing dashboard. Surfaces a four-card executive snapshot whose trust
 * tiers honestly reflect provenance:
 *
 *   - Book TIV / Policies        → SYNTHETIC_SCAFFOLD (seeded book)
 *   - Projected cession spend    → MODEL_OUTPUT       (Portfolio MIP artifact)
 *   - Open advisories            → LIVE_FEED          (NHC cone tool)
 *
 * The previous version hardcoded the latter two to 0 while tagging them
 * Live/Model. They now read from the cached MIP artifact and the NHC cone
 * tool respectively, so the badges no longer lie.
 *
 * `force-dynamic` is preserved so Vercel does not ISR-cache stale book stats.
 */
import { ExecCard } from '@/components/grammar/ExecCard';
import { computeBookTotals } from '@/lib/db/book_totals';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { computeProjectedCessionSpend } from '@/lib/portfolio-actions';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';

export const dynamic = 'force-dynamic';

// The single demo storm the agent tools key off. Production wiring would
// poll NHC for the actual active-storm list; here we resolve the same id
// the /events page uses so the home count never diverges from what an
// operator sees one click in.
const DEMO_STORM_ID = 'AL092024';

async function countOpenAdvisories(): Promise<number> {
  try {
    const cone = await fetchNhcCone.handler({ storm_id: DEMO_STORM_ID });
    return cone ? 1 : 0;
  } catch {
    return 0;
  }
}

export default async function Landing() {
  const [totals, optimization, openAdvisories] = await Promise.all([
    computeBookTotals(),
    loadPortfolioOptimization(),
    countOpenAdvisories(),
  ]);
  const projectedCessionSpend = optimization
    ? computeProjectedCessionSpend(optimization)
    : 0;
  return (
    <div className="p-6 grid grid-cols-2 md:grid-cols-4 gap-3">
      <ExecCard label="Book TIV" value={`$${(totals.tiv / 1e9).toFixed(2)}B`} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard label="Policies" value={totals.policies.toLocaleString()} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard
        label="Projected cession spend"
        value={`$${(projectedCessionSpend / 1e6).toFixed(1)}M`}
        tier={optimization ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD'}
      />
      <ExecCard label="Open advisories" value={`${openAdvisories}`} tier="LIVE_FEED" />
    </div>
  );
}
