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
 * Refresh the optimization with `python -m scripts.precompute_portfolio_optimization`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { aggregateCohorts } from '@/lib/db/cohorts';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { PortfolioMap } from '@/components/PortfolioMap';
import { PortfolioPersonaScope } from '@/components/PortfolioPersonaScope';
import { PortfolioPareto } from '@/components/PortfolioPareto';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import type { TreatyStack, TreatyLayer } from '@/lib/treaty/types';

export const dynamic = 'force-dynamic';

const TREATY_ARTIFACT_PATH = path.join(process.cwd(), 'artifacts', 'treaty.json');

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

export default async function PortfolioPage() {
  const [cohorts, optimizationRaw, treaty] = await Promise.all([
    aggregateCohorts(),
    loadPortfolioOptimization(),
    loadTreatyArtifact(),
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
  const rolLayers = summarizeRolLayers(treaty);
  // Task P2.18: SAA gap card surfaces `optimization.gap` when P2.9 ships
  // the field; until then the card stays SYNTHETIC_SCAFFOLD inside the
  // header. Reading defensively against legacy artifacts via `unknown` so
  // the cast doesn't trip the strict-type check.
  const optWithGap = optimization as unknown as { gap?: number } | null;
  const saaGap =
    optWithGap && typeof optWithGap.gap === 'number' ? optWithGap.gap : undefined;
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Portfolio Map</h1>
      {optimization ? (
        <PortfolioPersonaScope
          initialOptimization={optimization}
          totalTiv={totalTiv}
          rolLayers={rolLayers}
          saaGap={saaGap}
        />
      ) : (
        <p className="text-sm text-zinc-600 mb-4">
          Portfolio optimization artifact missing — run{' '}
          <code>python -m scripts.precompute_portfolio_optimization</code>.
        </p>
      )}
      <div className="h-[60vh] border rounded">
        <PortfolioMap cohorts={cohorts} optimization={optimization} />
      </div>
      {optimization && (
        <div className="mt-4">
          <PortfolioPareto
            baselineOptimization={optimization}
            totalTiv={totalTiv}
          />
        </div>
      )}
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
