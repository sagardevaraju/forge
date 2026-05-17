/**
 * Task 22 — Claims Pre-Brief route.
 * Task P2.27 — Loss column now reads cohort `loss_p50` from the Portfolio
 *               MIP artifact (`artifacts/portfolio_optimization.json`)
 *               instead of the old `LOSS_FACTOR[severity] × tiv` heuristic.
 * Task P2.28 — Expected adjuster-load rollup rendered above the table.
 *               Derived from the pre-flag set's cohort `loss_p50` via a
 *               documented adjusters-per-claim-$ ratio
 *               (`lib/reconciler/adjuster_load.ts`). Surfaced under its own
 *               `MODEL_OUTPUT` trust-tier badge because the Operational LP
 *               does not yet expose a per-ZIP3 `demand_adjustments` field
 *               for the claims pre-brief — the rollup currently derives
 *               on-the-fly and is documented as such on the page footnote.
 * Task P2.29 — Each render loads the prior severity snapshot from the
 *               `claims_history` table (`lib/db/claims_history.ts`), passes
 *               it down to `ClaimsTable` so the Δ column can render ↑/↓/=,
 *               and then upserts the current snapshot back into history so
 *               the *next* render can diff against today's numbers. The
 *               diff column inherits the table's trust tier (no new badge).
 *
 * Server component: derives a pre-flag list directly from the policy book
 * (still synthetic seed) — FL coastal ZIP3s × {AE, VE} flood zone — but the
 * *loss* number on each row now comes from the Portfolio MIP cohort prior:
 *
 *   per_policy_loss = cohort.loss_p50 × (policy.tiv / cohort.total_tiv)
 *
 * The cohort is resolved from the policy's `(zip3, build_type, tiv_quintile)`
 * tuple. Quintile cut-points are computed over the entire book (matching
 * `lib/db/cohorts.ts::aggregateCohorts`) so the cohort_id the page builds
 * agrees with the MIP-side ids in the artifact. Policies whose cohort isn't
 * in the artifact get `expected_loss = null` — the table renders "—" rather
 * than zero so a missing prior never reads as "zero loss".
 *
 * Trust-tier provenance:
 *   - The page-level badge stays `SYNTHETIC_SCAFFOLD` because the underlying
 *     seed policies are still synthetic (no live policy book yet).
 *   - The loss column carries its own `MODEL_OUTPUT` badge (in
 *     `components/ClaimsTable.tsx`) because the numbers in that column now
 *     come from the MIP cohort prior.
 *   - The P2.28 adjuster-load rollup carries its own `MODEL_OUTPUT` badge
 *     for the same reason (load is derived from the cohort prior; baseline
 *     is a documented heuristic).
 *
 * Top 200 policies (by expected_loss, with nulls last) are surfaced so the
 * table stays readable on a single screen during a demo.
 */
import { db } from '@/lib/db/client';
import { ClaimsTable, type PreflagPolicy } from '@/components/ClaimsTable';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { AdjusterLoadRollup } from '@/components/AdjusterLoadRollup';
import { computeAdjusterLoad } from '@/lib/reconciler/adjuster_load';
import { loadPrevSeverities, upsertSnapshot } from '@/lib/db/claims_history';

export const dynamic = 'force-dynamic';

/**
 * FL coastal ZIP3s overlapping the demo storm cone (AL092024, Gulf landfall).
 * Sourced from the seed distribution in scripts/seed_policy_book.py.
 */
const FL_CONE_ZIPS = ['332', '334', '335', '337', '338', '339', '341', '342', '346'];

function severityFor(build: string, flood: string): 'low' | 'medium' | 'high' {
  if (build === 'manufactured' || flood === 'VE') return 'high';
  if (flood === 'AE') return 'medium';
  return 'low';
}

/** Number of TIV buckets — must match `lib/db/cohorts.ts` (TIV_BUCKETS = 5). */
const TIV_BUCKETS = 5;

/**
 * Compute (TIV_BUCKETS - 1) cut-points splitting a sorted ascending numeric
 * array into TIV_BUCKETS equally-sized buckets using linear interpolation
 * between the two nearest ranks. Identical algorithm to
 * `lib/db/cohorts.ts::tivCutpoints`; duplicated locally so this page doesn't
 * pull the full aggregation pipeline just to bin policies.
 */
function tivCutpoints(sortedAsc: number[]): number[] {
  const cuts: number[] = [];
  const n = sortedAsc.length;
  if (n === 0) return cuts;
  for (let q = 1; q < TIV_BUCKETS; q++) {
    const rank = (q / TIV_BUCKETS) * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) {
      cuts.push(sortedAsc[lo]);
    } else {
      const w = rank - lo;
      cuts.push(sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w);
    }
  }
  return cuts;
}

/** Bin a TIV value into 0..(TIV_BUCKETS - 1) using strict-less comparison. */
function tivBin(tiv: number, cuts: number[]): number {
  for (let i = 0; i < cuts.length; i++) {
    if (tiv < cuts[i]) return i;
  }
  return TIV_BUCKETS - 1;
}

export default async function ClaimsPage() {
  // 1. Pull TIVs for the whole book to compute the quintile cut-points.
  //    These must be computed over the full book (not the FL subset) so the
  //    `q{N}` digit in our `cohort_id` matches the MIP-side artifact.
  const tivsRes = await db.execute(`SELECT tiv FROM policies`);
  const allTivs = tivsRes.rows.map((r) => Number(r.tiv));
  const sortedTivs = [...allTivs].sort((a, b) => a - b);
  const cuts = tivCutpoints(sortedTivs);

  // 2. Pull the FL coastal subset of policies that the pre-brief surfaces.
  const placeholders = FL_CONE_ZIPS.map(() => '?').join(',');
  const r = await db.execute({
    sql:
      `SELECT id, zip3, tiv, build_type, flood_zone ` +
      `FROM policies ` +
      `WHERE zip3 IN (${placeholders}) AND flood_zone IN ('AE', 'VE') ` +
      `ORDER BY tiv DESC LIMIT 500`,
    args: FL_CONE_ZIPS,
  });

  // 3. Load the cached Portfolio MIP artifact and index its cohorts by id so
  //    we can look up `loss_p50` + `total_tiv` for each FL coastal policy.
  const optimization = await loadPortfolioOptimization();
  const cohortById = new Map<string, { loss_p50: number; total_tiv: number }>();
  if (optimization) {
    for (const c of optimization.cohorts) {
      cohortById.set(c.id, { loss_p50: c.loss_p50, total_tiv: c.total_tiv });
    }
  }

  // 4. Build per-policy rows. Loss = proportional split of the cohort's
  //    `loss_p50`; null when no cohort match (table renders "—").
  const policies: PreflagPolicy[] = r.rows.map((row) => {
    const flood = String(row.flood_zone);
    const build = String(row.build_type);
    const tiv = Number(row.tiv);
    const zip3 = String(row.zip3);
    const severity = severityFor(build, flood);
    const quintile = tivBin(tiv, cuts);
    const cohortId = `${zip3}_${build}_q${quintile}`;
    const cohort = cohortById.get(cohortId);
    let expected_loss: number | null = null;
    if (cohort && cohort.total_tiv > 0) {
      expected_loss = cohort.loss_p50 * (tiv / cohort.total_tiv);
    }
    return {
      policy_id: Number(row.id),
      zip3,
      tiv,
      build_type: build,
      flood_zone: flood,
      severity,
      expected_loss,
    };
  });

  // 5. Sort by expected_loss descending, putting nulls last so the demo
  //    surfaces the policies the model actually thinks are dangerous.
  policies.sort((a, b) => {
    if (a.expected_loss == null && b.expected_loss == null) return 0;
    if (a.expected_loss == null) return 1;
    if (b.expected_loss == null) return -1;
    return b.expected_loss - a.expected_loss;
  });
  const top = policies.slice(0, 200);

  const haveArtifact = optimization != null;
  const noticeCohortHits = top.filter((p) => p.expected_loss != null).length;

  // Task P2.28 — roll the pre-flag set up to a per-ZIP3 adjuster-load delta.
  // Pure helper, no I/O. Policies with null expected_loss are skipped inside
  // the helper, so the rollup is naturally empty when the MIP artifact is
  // missing or no cohort matches were found.
  const adjusterLoad = computeAdjusterLoad(top);

  // Task P2.29 — load the prior severity snapshot, then persist the current
  // one. The load runs before the persist so the diff is against *yesterday*,
  // not today. Policies whose expected_loss is null are not persisted (no
  // signal to compare next time).
  const priorSeverities = await loadPrevSeverities();
  const snapshotRows = top
    .filter((p): p is typeof p & { expected_loss: number } => p.expected_loss != null)
    .map((p) => ({ policy_id: p.policy_id, severity: p.expected_loss }));
  await upsertSnapshot(snapshotRows);

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-2xl font-bold">Claims Pre-Brief</h1>
        <TrustTierBadge tier="SYNTHETIC_SCAFFOLD" />
      </div>
      <p className="text-sm text-zinc-600 mb-2">
        {top.length} policies pre-flagged inside the demo storm cone.{' '}
        {haveArtifact ? (
          <>
            Loss column reads each cohort&apos;s <code>loss_p50</code> from the
            Portfolio MIP artifact and splits it proportionally to policy TIV
            ({noticeCohortHits}/{top.length} policies matched a cohort; the rest
            display &quot;—&quot;).
          </>
        ) : (
          <>
            Portfolio MIP artifact is missing — run{' '}
            <code>python -m scripts.precompute_portfolio_optimization</code> to
            populate the loss column.
          </>
        )}
      </p>
      <AdjusterLoadRollup rollup={adjusterLoad} />
      <ClaimsTable policies={top} priorSeverities={priorSeverities} />
      <ProvenanceFootnote
        source="policies table (synthetic seed) filtered by FL coastal ZIP3 × {AE, VE}; loss column from artifacts/portfolio_optimization.json"
        method="Portfolio MIP cohort prior (HAZUS-derived loss_p50, proportional TIV split per policy); adjuster-load rollup derived via lib/reconciler/adjuster_load.ts (ceil(sum cohort loss / $250K)); see docs/methodology.md"
        confidence={
          haveArtifact
            ? `MIP status ${optimization!.status} · ${noticeCohortHits}/${top.length} policies matched a cohort · adjuster-load: ${adjusterLoad.total_needed} needed across ${adjusterLoad.rows.length} ZIP3(s)`
            : 'optimization cache missing — loss column unavailable'
        }
      />
    </div>
  );
}
