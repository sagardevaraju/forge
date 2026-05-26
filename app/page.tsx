/**
 * Landing dashboard. Surfaces a four-card executive snapshot whose trust
 * tiers honestly reflect provenance:
 *
 *   - Book TIV / Policies        → SYNTHETIC_SCAFFOLD (seeded book)
 *   - Projected cession spend    → MODEL_OUTPUT       (Portfolio MIP artifact)
 *   - Open advisories            → LIVE_FEED only when the NHC cone tool
 *                                  actually returned live data; when the
 *                                  tool falls back to its mock cone the
 *                                  card downgrades to SYNTHETIC_SCAFFOLD so
 *                                  the badge never claims a live feed over
 *                                  mock data.
 *
 * The previous version hardcoded the latter two to 0 while tagging them
 * Live/Model. They now read from the cached MIP artifact and the NHC cone
 * tool respectively, and the tier reflects the cone's actual `source`.
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

/**
 * Count open advisories AND report whether the cone came from the live NHC
 * feed or the tool's mock fallback — the caller uses `source` to pick an
 * honest trust tier (a `LIVE_FEED` badge over mock data is a lie).
 */
async function countOpenAdvisories(): Promise<{
  count: number;
  source: 'live' | 'mock';
}> {
  try {
    const cone = await fetchNhcCone.handler({ storm_id: DEMO_STORM_ID });
    return { count: cone ? 1 : 0, source: cone?.source ?? 'mock' };
  } catch {
    return { count: 0, source: 'mock' };
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
      <ExecCard label="Book TIV" term="book-tiv" value={`$${(totals.tiv / 1e9).toFixed(2)}B`} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard label="Policies" term="policies" value={totals.policies.toLocaleString()} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard
        label="Projected cession spend"
        term="projected-cession-spend"
        value={`$${(projectedCessionSpend / 1e6).toFixed(1)}M`}
        tier={optimization ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD'}
      />
      <ExecCard
        label="Open advisories"
        term="advisory"
        value={`${openAdvisories.count}`}
        tier={openAdvisories.source === 'live' ? 'LIVE_FEED' : 'SYNTHETIC_SCAFFOLD'}
      />
    </div>
  );
}
