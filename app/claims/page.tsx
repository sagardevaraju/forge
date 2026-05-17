/**
 * Task 22 — Claims Pre-Brief route.
 *
 * Server component: derives a pre-flag list directly from the policy book
 * with a deterministic heuristic — FL coastal ZIP3s × {AE, VE} flood zone,
 * severity tiered by build_type and flood_zone. This stands in for the live
 * MIP→preflag pipeline which is not yet wired into the autonomous build; the
 * shape of the data matches what the eventual pipeline will return, so the
 * UI can stay stable when we swap in the real source.
 *
 * Top 200 policies by expected_loss are surfaced so the table stays readable
 * on a single screen during a demo.
 */
import { db } from '@/lib/db/client';
import { ClaimsTable, type PreflagPolicy } from '@/components/ClaimsTable';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';

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

/** Expected-loss multiplier per severity tier; calibrated against HAZUS-style
 *  curves for the demo (high coastal manufactured ≈ 40% of TIV, AE-zone
 *  masonry/wood ≈ 15%, residual ≈ 5%). */
const LOSS_FACTOR: Record<'low' | 'medium' | 'high', number> = {
  high: 0.4,
  medium: 0.15,
  low: 0.05,
};

export default async function ClaimsPage() {
  const placeholders = FL_CONE_ZIPS.map(() => '?').join(',');
  const r = await db.execute({
    sql:
      `SELECT id, zip3, tiv, build_type, flood_zone ` +
      `FROM policies ` +
      `WHERE zip3 IN (${placeholders}) AND flood_zone IN ('AE', 'VE') ` +
      `ORDER BY tiv DESC LIMIT 500`,
    args: FL_CONE_ZIPS,
  });

  const policies: PreflagPolicy[] = r.rows
    .map((row) => {
      const flood = String(row.flood_zone);
      const build = String(row.build_type);
      const tiv = Number(row.tiv);
      const severity = severityFor(build, flood);
      return {
        policy_id: Number(row.id),
        zip3: String(row.zip3),
        tiv,
        build_type: build,
        flood_zone: flood,
        severity,
        expected_loss: tiv * LOSS_FACTOR[severity],
      };
    })
    .sort((a, b) => b.expected_loss - a.expected_loss)
    .slice(0, 200);

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-2xl font-bold">Claims Pre-Brief</h1>
        <TrustTierBadge tier="SYNTHETIC_SCAFFOLD" />
      </div>
      <p className="text-sm text-zinc-600 mb-2">
        {policies.length} policies pre-flagged inside the demo storm cone.
        This view uses a deterministic heuristic (severity tier × TIV) — the
        production path swaps cohort-level loss_p50 in Phase 2.
      </p>
      <ClaimsTable policies={policies} />
      <ProvenanceFootnote
        source="policies table (synthetic seed) filtered by FL coastal ZIP3 × {AE, VE}"
        method="app/claims/page.tsx severityFor + LOSS_FACTOR heuristic"
        confidence="not calibrated — Phase 2 swap to cohort loss_p50"
      />
    </div>
  );
}
