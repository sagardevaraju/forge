/**
 * Landing dashboard — the operations console index.
 *
 * Three bands, top to bottom:
 *   1. A heading + the LiveEventStrip (reused from /portfolio) so the
 *      operator sees "is something happening right now" before anything
 *      else. The strip stays honest about provenance: the demo cone is
 *      `source === 'mock'`, so it renders the amber "Demo scenario" / "Mock"
 *      treatment rather than a live-feed pill (CLAUDE.md "no fictional
 *      data": a LIVE_FEED badge over mock data is a bug).
 *   2. The four-card executive snapshot, whose trust tiers honestly reflect
 *      provenance:
 *        - Book TIV / Policies     → SYNTHETIC_SCAFFOLD (seeded book)
 *        - Projected cession spend → MODEL_OUTPUT       (Portfolio MIP artifact)
 *        - Open advisories         → LIVE_FEED only when the NHC cone tool
 *                                    actually returned live data; mock
 *                                    fallback downgrades to SYNTHETIC_SCAFFOLD.
 *   3. Entry tiles into the eight views — the wayfinding the bare card grid
 *      used to lack.
 *
 * Colours/surfaces use the semantic design tokens wired into Tailwind
 * (`text-ink-muted`, `bg-surface`, `ring-accent`) rather than raw `zinc-*`.
 *
 * `force-dynamic` is preserved so Vercel does not ISR-cache stale book stats.
 */
import Link from 'next/link';
import { ExecCard } from '@/components/grammar/ExecCard';
import { LiveEventStrip } from '@/components/grammar/LiveEventStrip';
import { computeBookTotals } from '@/lib/db/book_totals';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { computeProjectedCessionSpend } from '@/lib/portfolio-actions';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';

export const dynamic = 'force-dynamic';

// The single demo storm the agent tools key off. Production wiring would
// poll NHC for the actual active-storm list; here we resolve the same id
// the /events and /portfolio pages use so the home count never diverges
// from what an operator sees one click in.
const DEMO_STORM_ID = 'AL092024';

// Entry tiles → the eight console views. Mirrors the route list in
// LayoutSubBanner; duplicated here (8 short labels) rather than imported so
// this server component doesn't pull in the client-only nav.
const VIEWS: { href: string; label: string; blurb: string }[] = [
  { href: '/portfolio', label: 'Portfolio', blurb: 'MIP-optimized reprice / cede / non-renew actions by cohort' },
  { href: '/events', label: 'Events', blurb: 'Live NHC cone + NWS alerts over the book footprint' },
  { href: '/simulate', label: 'Simulate', blurb: 'Draw a peril footprint and score modeled gross loss' },
  { href: '/claims', label: 'Claims', blurb: 'Pre-flagged claims and adjuster load rollup' },
  { href: '/calibration', label: 'Calibration', blurb: 'Modeled vs. observed severity calibration' },
  { href: '/treaty', label: 'Treaty', blurb: 'Reinsurance ladder and rate-on-line by layer' },
  { href: '/load', label: 'Load', blurb: 'Upload or replace the policy book' },
  { href: '/methodology', label: 'Methodology', blurb: 'How every number is computed and sourced' },
];

export default async function Landing() {
  const [totals, optimization, cone] = await Promise.all([
    computeBookTotals(),
    loadPortfolioOptimization(),
    // Best-effort cone fetch — failure degrades to null and the strip shows
    // an honest "no active named storm" line. Never blocks the render.
    fetchNhcCone.handler({ storm_id: DEMO_STORM_ID }).catch(() => null),
  ]);

  const projectedCessionSpend = optimization
    ? computeProjectedCessionSpend(optimization)
    : 0;
  const coneSource = cone?.source ?? 'mock';
  const advisoryCount = cone ? 1 : 0;

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-6 flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink leading-none">
            Operations console
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            Forecast-driven Operational Risk Governance Engine — one scenario
            set, three optimization layers.
          </p>
        </div>
        <LiveEventStrip
          stormId={cone ? DEMO_STORM_ID : null}
          advisoryNumber={cone?.advisory_number}
          peakWindMph={cone?.peak_wind}
          source={coneSource}
          refreshedAt={new Date()}
        />
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
          value={`${advisoryCount}`}
          tier={coneSource === 'live' ? 'LIVE_FEED' : 'SYNTHETIC_SCAFFOLD'}
        />
      </div>

      <section aria-labelledby="views-heading">
        <h2
          id="views-heading"
          className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-faint mb-2"
        >
          Views
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {VIEWS.map((v) => (
            <Link
              key={v.href}
              href={v.href}
              className="group bg-surface rounded-md ring-1 ring-zinc-200/70 shadow-[0_1px_0_rgba(24,24,27,0.03)] p-4 flex flex-col gap-1 hover:ring-accent transition-shadow"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-ink">{v.label}</span>
                <span
                  aria-hidden="true"
                  className="text-ink-faint group-hover:text-accent transition-colors"
                >
                  →
                </span>
              </div>
              <span className="text-[11.5px] text-ink-muted leading-snug">
                {v.blurb}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
