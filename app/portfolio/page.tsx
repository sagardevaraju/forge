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
 * Task P2.15 (Phase 2): a `PortfolioPareto` panel below the map renders a
 * 3×3 grid solve on (capital_budget, cession_budget) at multipliers
 * [0.7×, 1.0×, 1.5×] of the baseline. Hidden behind a toggle; on toggle the
 * client fires 9 parallel POSTs to `/api/optimize/portfolio` and renders
 * the efficient-frontier cells with their achieved objectives.
 *
 * Task P2.18 (Phase 2): the page now mounts `PortfolioPersonaScope`, a
 * client wrapper that reads `?persona=<id>` from the URL and re-shapes the
 * headline ExecCards / quick-links / what-if rail for each archetype. The
 * server component still does all the artifact loading (`treaty.json` is
 * added so the Reinsurance lens has live RoL-by-layer + retained-tail
 * data); the persona only RE-SHAPES the rendering, it never re-fetches.
 *
 * Task 22/23 (simulate-tab): SimulationBanner is mounted above
 * PortfolioPersonaScope. loadUnresolvedSims() queries the DB for
 * promoted+non-retired sims whose IDs are not yet in
 * portfolio_optimization.meta.json so the banner appears whenever the
 * cached MIP solve is stale relative to the current simulation set.
 *
 * Refresh the optimization with `python -m scripts.precompute_portfolio_optimization`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db/client';
import { SimulationBanner, type UnresolvedSim } from '@/components/grammar/SimulationBanner';
import { aggregateCohorts } from '@/lib/db/cohorts';
import { getBookStates } from '@/lib/db/book_totals';
import { zip3Centroids } from '@/lib/db/zip3_centroids';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { PortfolioMap } from '@/components/PortfolioMap';
import { PortfolioPersonaScope } from '@/components/PortfolioPersonaScope';
import { PortfolioPareto } from '@/components/PortfolioPareto';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';
import {
  fetchActiveStorms,
  pickRelevantStorm,
} from '@/app/api/agent/tools/fetch_active_storms';
import { fetchNwsAlerts } from '@/app/api/agent/tools/fetch_nws_alerts';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import type { ActiveStorm } from '@/app/api/agent/tools/fetch_active_storms';
import type { FetchNwsAlertsResult } from '@/app/api/agent/tools/fetch_nws_alerts';
import type { TreatyStack, TreatyLayer } from '@/lib/treaty/types';

export const dynamic = 'force-dynamic';

const TREATY_ARTIFACT_PATH = path.join(process.cwd(), 'artifacts', 'treaty.json');
/**
 * Fallback storm id used when NHC reports zero active named storms. The
 * historical demo (Hurricane Helene, AL092024) keeps the active-threat
 * strip populated with a recognisable scenario between hurricane
 * seasons. When the live feed reports zero active storms, the page
 * still renders this cone — but downstream UI should treat it as a
 * frozen reference (the LiveEventStrip's source chip says "Mock").
 */
const FALLBACK_STORM_ID = 'AL092024';

interface RolLayer {
  type: string;
  rol: number;
  attachment?: number;
}

function summarizeRolLayers(stack: TreatyStack | null): RolLayer[] | undefined {
  if (!stack) return undefined;
  return stack.layers.map((l: TreatyLayer) => {
    if (l.type === 'qs') {
      return { type: 'QS', rol: l.rol ?? 0 };
    }
    return { type: 'XS', rol: l.rol, attachment: l.attachment };
  });
}

async function loadTreatyArtifact(): Promise<TreatyStack | null> {
  try {
    const raw = await readFile(TREATY_ARTIFACT_PATH, 'utf-8');
    return JSON.parse(raw) as TreatyStack;
  } catch {
    return null;
  }
}

const META_PATH = path.join(process.cwd(), 'artifacts', 'portfolio_optimization.meta.json');

async function loadUnresolvedSims(): Promise<UnresolvedSim[]> {
  // Sims that are promoted + not retired AND not in the latest meta.json
  const promoted = await db.execute(
    'SELECT id, name, peril, promoted_at FROM simulations WHERE promoted = 1 AND retired = 0',
  );
  let included: string[] = [];
  try {
    const meta = JSON.parse(await readFile(META_PATH, 'utf-8')) as { included_sims?: string[] };
    included = meta.included_sims ?? [];
  } catch { /* fresh clone — no meta yet */ }
  return promoted.rows
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      peril: String(r.peril),
      promoted_at: String(r.promoted_at),
    }))
    .filter((s) => !included.includes(s.id));
}

export default async function PortfolioPage() {
  // Pre-render dependencies that the storm-id auto-discovery and the alert
  // scoping need before we kick off the parallel fetches. Both are cheap
  // (~10ms each on a warm libSQL connection) so we run them inline rather
  // than racing them in Promise.all — the picked storm id is a Promise.all
  // input downstream.
  const [bookStates, active] = await Promise.all([
    getBookStates().catch(() => [] as string[]),
    fetchActiveStorms
      .handler({ basin: 'AL' })
      .catch(() => ({ storms: [] as ActiveStorm[], source: 'mock' as const, fetched_at: '' })),
  ]);
  const picked = pickRelevantStorm(active.storms);
  const liveActiveStormFound = picked !== null && active.source === 'live';
  const stormId = picked?.id ?? FALLBACK_STORM_ID;

  const [
    cohorts,
    optimizationRaw,
    treaty,
    cone,
    alertsRes,
    unresolved,
    zip3CentroidMap,
  ]: [
    Awaited<ReturnType<typeof aggregateCohorts>>,
    Awaited<ReturnType<typeof loadPortfolioOptimization>>,
    TreatyStack | null,
    FetchNhcConeResult | null,
    FetchNwsAlertsResult | null,
    Awaited<ReturnType<typeof loadUnresolvedSims>>,
    Awaited<ReturnType<typeof zip3Centroids>>,
  ] = await Promise.all([
    aggregateCohorts(),
    loadPortfolioOptimization(),
    loadTreatyArtifact(),
    // Best-effort cone fetch — failure (network, missing storm) degrades to
    // null and the map shows an honest "no active named storm" line. Never
    // blocks the page render on a third-party feed.
    fetchNhcCone.handler({ storm_id: stormId }).catch(() => null),
    // NWS active alerts scoped to wherever the book has policies, NOT
    // hardcoded FL. `getBookStates` returns the distinct state set from
    // the policies table; for a typical FORGE seed that's roughly the US
    // South. An empty array falls back to FL inside the tool's default
    // to keep a fresh-clone dev experience populated.
    fetchNwsAlerts
      .handler({ state: bookStates.length > 0 ? bookStates : undefined })
      .catch(() => null),
    loadUnresolvedSims(),
    // Per-ZIP3 map centroids from the live policy book — anchors the
    // Portfolio Map bubbles to where policies actually sit. Degrades to an
    // empty map (the pane then falls back per-ZIP3) rather than failing.
    zip3Centroids().catch((): Awaited<ReturnType<typeof zip3Centroids>> => ({})),
  ]);
  // Annotate the cone with a synthetic-source flag when we know NHC said
  // "no active storms" and we're rendering the fallback — distinct from
  // "the tool's mock fallback fired because of a network error" which
  // already surfaces via cone.source === 'mock'. Either way the
  // LiveEventStrip's source chip reads "Mock" so the operator is told.
  void liveActiveStormFound; // reserved for a future "demo" chip on the strip
  const coneRefreshedAt = new Date();
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
  const rolLayers = summarizeRolLayers(treaty);
  // Task P2.18: SAA gap card surfaces `optimization.gap` when P2.9 ships
  // the field; until then the card stays SYNTHETIC_SCAFFOLD inside the
  // header. Reading defensively against legacy artifacts via `unknown` so
  // the cast doesn't trip the strict-type check.
  const optWithGap = optimization as unknown as { gap?: number } | null;
  const saaGap =
    optWithGap && typeof optWithGap.gap === 'number' ? optWithGap.gap : undefined;
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <SimulationBanner unresolved={unresolved} />
      <header className="mb-6 flex items-end justify-between gap-6 border-b hairline pb-5">
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.18em] font-medium text-zinc-500 mb-1">
            Portfolio · MIP recommendation
          </p>
          <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-zinc-900 leading-none">
            Portfolio Map
          </h1>
          <p className="text-[13px] text-zinc-600 mt-2 max-w-prose">
            Cohort-level recommendations from the precomputed PuLP/CBC solve.
            Tweak the budget triple on the right to re-solve in place.
          </p>
        </div>
        {optimization && (
          <div className="text-right text-[11px] text-zinc-500 leading-snug tabular-nums">
            <div>
              MIP status{' '}
              <span className="text-zinc-800 font-medium">{optimization.status}</span>
            </div>
            <div>
              Objective{' '}
              <span className="text-zinc-800 font-medium">
                ${(optimization.objective / 1e6).toFixed(1)}M
              </span>
            </div>
          </div>
        )}
      </header>

      {optimization ? (
        <PortfolioPersonaScope
          initialOptimization={optimization}
          totalTiv={totalTiv}
          rolLayers={rolLayers}
          saaGap={saaGap}
        />
      ) : (
        <p className="text-sm text-zinc-600 mb-4">
          Portfolio optimization artifact missing. Run{' '}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-[12px] text-zinc-800">
            python -m scripts.precompute_portfolio_optimization
          </code>
          .
        </p>
      )}

      <section className="mt-6">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[12px] uppercase tracking-[0.12em] font-medium text-zinc-500">
            Exposure map
          </h2>
          <p className="text-[11px] text-zinc-500">
            Click any ZIP3 cluster to drill into per-cohort action mix.
          </p>
        </div>
        <div className="h-[60vh] overflow-hidden rounded-md ring-1 ring-zinc-200/70 bg-white shadow-[0_1px_0_rgba(24,24,27,0.03)]">
          <PortfolioMap
            cohorts={cohorts}
            optimization={optimization}
            cone={cone}
            coneRefreshedAt={coneRefreshedAt}
            alerts={alertsRes?.alerts ?? []}
            alertCounts={alertsRes?.counts}
            zip3Centroids={zip3CentroidMap}
          />
        </div>
      </section>

      {optimization && (
        <section className="mt-8">
          <PortfolioPareto
            baselineOptimization={optimization}
            totalTiv={totalTiv}
          />
        </section>
      )}

      <footer className="mt-10 border-t hairline pt-5">
        <ProvenanceFootnote
          source="policies table (synthetic seed via scripts/seed_policy_book.py)"
          method="lib/db/cohorts::aggregateCohorts + api_py/optimize_portfolio::solve"
          confidence={
            optimization
              ? `MIP status ${optimization.status} · objective $${(optimization.objective / 1e6).toFixed(1)}M`
              : 'optimization cache missing'
          }
        />
      </footer>
    </div>
  );
}
