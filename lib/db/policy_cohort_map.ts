/**
 * Task P2.33 — Policy-to-cohort mapping helper.
 *
 * The reconciler operates on cohorts; operator pins are stored per-policy
 * (see ``lib/db/pins.ts``). To bridge the two, callers (the ``/api/pins`` route
 * and the Decision Reconciler integration) need a ``policy_id → cohort_id``
 * lookup. The mapping is derived from the same ``(zip3, build_type,
 * tiv_quintile)`` rules ``aggregateCohorts`` uses — single source of truth.
 *
 * This module re-derives the quintile cut-points over the live book each call.
 * For a 10k-policy seed the work is sub-50ms; production would cache the map
 * alongside the precomputed artifact.
 */
import { db } from './client';

const TIV_BUCKETS = 5;

function tivCutpoints(sortedAsc: number[]): number[] {
  const cuts: number[] = [];
  const n = sortedAsc.length;
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

function tivBin(tiv: number, cuts: number[]): number {
  for (let i = 0; i < cuts.length; i++) {
    if (tiv < cuts[i]) return i;
  }
  return TIV_BUCKETS - 1;
}

/**
 * Load the ``policy_id → cohort_id`` map for the live book. Cohort IDs follow
 * the canonical ``{zip3}_{build_type}_q{N}`` format (see ``lib/db/cohorts.ts``).
 */
export async function loadPolicyToCohortMap(): Promise<Record<number, string>> {
  const res = await db.execute(
    'SELECT id, zip3, build_type, tiv FROM policies',
  );
  if (res.rows.length === 0) return {};

  const rows = res.rows.map((r) => ({
    id: Number(r.id),
    zip3: String(r.zip3),
    build_type: String(r.build_type),
    tiv: Number(r.tiv),
  }));
  const tivsSorted = rows.map((r) => r.tiv).sort((a, b) => a - b);
  const cuts = tivCutpoints(tivsSorted);

  const out: Record<number, string> = {};
  for (const row of rows) {
    const q = tivBin(row.tiv, cuts);
    out[row.id] = `${row.zip3}_${row.build_type}_q${q}`;
  }
  return out;
}
