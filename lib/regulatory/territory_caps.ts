/**
 * Task P2.32 — Per-(state, territory) regulatory non-renew caps.
 *
 * Each state's insurance regulator constrains how aggressively a homeowners
 * carrier may shrink its book in a single year, and several regulators slice
 * that cap by *territory* — Florida's coastal counties get a tighter cap than
 * its inland counties, Texas Tier 1 (windstorm) is tighter than Tier 2, etc.
 *
 * This module:
 *
 *   1. Classifies a policy (by ZIP3) into a ``(state, territory)`` bucket.
 *   2. Exposes a ``TERRITORY_CAPS`` lookup with the maximum annual non-renewal
 *      fraction permitted in each bucket.
 *   3. Provides ``applyTerritoryCaps`` — a pure function the reconciler calls
 *      AFTER the P2.31 notice-period filter — that downgrades the smallest
 *      cohorts in any over-cap bucket until the bucket fits, emitting a
 *      ``non_renew_capped`` stamp per downgraded cohort.
 *
 * Precedence vs P2.31 (notice-period filter):
 *
 *   * P2.31 runs first. A cohort that fails the statutory notice clock is
 *     already deferred to next year's renewal cycle, so it does NOT consume
 *     any of this year's bucket capacity. The caller passes the set of
 *     already-deferred cohort IDs in ``already_deferred_cohort_ids``.
 *   * A cohort that survives both filters keeps its original ``non_renew``
 *     action. A cohort the territory cap downgrades gets a SEPARATE stamp;
 *     stamps are additive (a single cohort can carry both stamps).
 *
 * Cap calibration — THESE ARE MODEL ASSUMPTIONS, NOT REGULATORY LIMITS.
 *
 * The cap fractions in ``TERRITORY_CAPS`` are tunable model parameters,
 * hand-picked to be directionally plausible (coastal tighter than inland) so
 * the reconciler has a concrete book-shrink ceiling to enforce in the demo.
 * They are NOT drawn from statute, regulator guidance, or counsel, and must
 * never be presented to a user as regulatory limits or legal advice. An
 * earlier version of this file carried a specific statute citation per row
 * (§627.4133, 28 TAC §5.4801, LDI Bulletin 2020-08, §58-41-15, …); those
 * were removed because they lent invented numbers false authority.
 *
 * A production deployment must replace every value in ``TERRITORY_CAPS``
 * with figures produced by counsel / compliance for each jurisdiction, and
 * replace the coastal/inland (and TX tier_1/tier_2) classification below —
 * itself a modeling simplification — with real territory definitions.
 */

import { zip3State } from '@/lib/regulatory/zip3_geo';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A bucket key takes the form ``"<STATE>:<territory>"`` (e.g. ``"FL:coastal"``)
 * or the literal sentinel ``"__default__"`` for ZIP3s that do not classify.
 */
export type TerritoryBucket = string;

export interface TerritoryCohortInput {
  cohort_id: string;
  /** ZIP3 prefix of the cohort (e.g. ``"330"``). */
  zip3: string;
  /** Total TIV represented by this cohort. */
  total_tiv: number;
  /**
   * Continuous share the MIP voted to non-renew. The reconciler typically
   * filters to ``non_renew > 0.5`` before passing into ``applyTerritoryCaps``;
   * the field is preserved here so the downgrade is recorded against the
   * MIP's intent.
   */
  non_renew_share: number;
}

export interface TerritoryCapsInput {
  /** Cohorts the MIP voted to non-renew (already filtered, see above). */
  non_renew_cohorts: TerritoryCohortInput[];
  /**
   * Total book TIV per bucket. Keys are ``TerritoryBucket`` values; missing
   * keys are treated as the cohort's own non_renew TIV (so the bucket can
   * never be "under-cap" by sheer book size when the denominator is missing).
   */
  bucket_total_tiv: Record<TerritoryBucket, number>;
  /**
   * Cohort IDs already deferred by the P2.31 notice-period filter. These
   * cohorts do NOT contribute to the bucket's observed non-renew share —
   * they roll over to next year's cycle. See module docstring.
   */
  already_deferred_cohort_ids: Set<string>;
}

export interface TerritoryCapStamp {
  cohort_id: string;
  action: 'non_renew_capped';
  original_action: 'non_renew';
  downgrade_reason: 'territory_cap_exceeded';
  /** Bucket key that drove the downgrade. */
  bucket: TerritoryBucket;
  /** Cap fraction for the bucket (e.g. ``0.03`` for FL:coastal). */
  cap_fraction: number;
  /**
   * Observed pre-downgrade non-renew fraction for the bucket
   * (= ``sum(non_renew_tiv) / bucket_total_tiv``). Useful for traceability
   * on why this cohort was downgraded.
   */
  observed_fraction: number;
}

export interface TerritoryCapsOutput {
  downgraded: TerritoryCapStamp[];
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * Maximum annual non-renewal TIV share per ``(state, territory)`` bucket.
 * MODEL ASSUMPTIONS, not regulatory limits — see the module docstring.
 */
export const TERRITORY_CAPS: Record<TerritoryBucket, number> = {
  'FL:coastal': 0.03, // assumption — coastal tighter than inland
  'FL:inland': 0.05, // assumption
  'TX:tier_1': 0.04, // assumption — windstorm-exposed coast tighter
  'TX:tier_2': 0.07, // assumption — inland
  'LA:coastal': 0.04, // assumption — coastal tighter than inland
  'LA:inland': 0.06, // assumption
  'NC:coastal': 0.05, // assumption — coastal tighter than inland
  'NC:inland': 0.08, // assumption — inland
  __default__: 0.05, // assumption — fallback for unclassified ZIP3s
};

// ---------------------------------------------------------------------------
// Territory classification
// ---------------------------------------------------------------------------

/**
 * Florida ZIP3s placed in the tighter (coastal) cap bucket — directly
 * Atlantic/Gulf-exposed metros. A modeling simplification, not a statutory
 * territory. The demo book's inland FL ZIP3s (334, 338, 346) sit outside it.
 */
const FL_COASTAL_ZIP3S = new Set<string>([
  '320', // Duval (Atlantic — Jacksonville)
  '330', // Miami-Dade
  '331', // Miami-Dade
  '332', // Miami-Dade
  '335', // Hillsborough (Tampa Bay)
  '337', // Pinellas (Gulf — St. Petersburg)
  '339', // Lee (Gulf — Cape Coral)
  '341', // Sarasota (Gulf)
  '342', // Sarasota (Gulf)
  '349', // St. Lucie (Atlantic)
]);

/**
 * Texas ZIP3s placed in the tighter (windstorm-exposed coast) cap bucket.
 * Texas has a real Tier 1 / TWIA coastal designation, but the ZIP3-level set
 * below is our own modeling approximation of it, not the statutory territory.
 * The demo book's coastal TX ZIP3s are 774–778 and 783–784; Houston (770) is
 * treated as inland.
 */
const TX_TIER1_ZIP3S = new Set<string>([
  '774', // Galveston
  '775', // Galveston
  '776', // Jefferson
  '777', // Jefferson
  '778', // Brazoria
  '783', // Nueces
  '784', // Nueces
]);

/**
 * Louisiana ZIP3s placed in the tighter (coastal) cap bucket — a modeling
 * simplification, not a statutory parish list. The demo book's coastal LA
 * ZIP3s are 703, 704, 706; the remaining LA ZIP3s (705, 707, 708, 714) are
 * treated as inland.
 */
const LA_COASTAL_ZIP3S = new Set<string>([
  '703', // Orleans
  '704', // Jefferson
  '706', // Calcasieu
]);

/**
 * North Carolina ZIP3s placed in the tighter (coastal) cap bucket — a
 * modeling simplification, not the statutory Beach Plan / NCIUA territory.
 * The demo book's coastal NC ZIP3 is 289; the remaining NC ZIP3s
 * (275, 280–287) are treated as inland.
 */
const NC_COASTAL_ZIP3S = new Set<string>(['289']);

/**
 * Classify a ZIP3 prefix into a ``(state, territory)`` bucket. Returns the
 * literal ``"__default__"`` sentinel for ZIP3s that do not classify (so the
 * caller can still look up a conservative cap). State comes from the
 * verified `zip3_geo` reference.
 */
export function classifyTerritory(zip3: string): TerritoryBucket {
  const state = zip3State(zip3);
  if (!state) return '__default__';
  switch (state) {
    case 'FL':
      return FL_COASTAL_ZIP3S.has(zip3) ? 'FL:coastal' : 'FL:inland';
    case 'TX':
      return TX_TIER1_ZIP3S.has(zip3) ? 'TX:tier_1' : 'TX:tier_2';
    case 'LA':
      return LA_COASTAL_ZIP3S.has(zip3) ? 'LA:coastal' : 'LA:inland';
    case 'NC':
      return NC_COASTAL_ZIP3S.has(zip3) ? 'NC:coastal' : 'NC:inland';
    default:
      return '__default__';
  }
}

/** Look up the cap fraction for a bucket, falling back to ``__default__``. */
export function capForBucket(bucket: TerritoryBucket): number {
  return TERRITORY_CAPS[bucket] ?? TERRITORY_CAPS.__default__;
}

// ---------------------------------------------------------------------------
// Cap-application pass
// ---------------------------------------------------------------------------

/**
 * Apply the per-bucket cap. For each bucket, sum the non-renew TIV of all
 * non-deferred cohorts; if that share exceeds the bucket's cap, sort the
 * cohorts by ``total_tiv`` ascending (smallest first — minimizes customer
 * disruption per downgrade) and stamp them as ``non_renew_capped`` one by
 * one until the bucket fits.
 *
 * The function is pure: same input → same output, no I/O, no mutation of
 * the input arrays.
 */
export function applyTerritoryCaps(
  input: TerritoryCapsInput,
): TerritoryCapsOutput {
  const { non_renew_cohorts, bucket_total_tiv, already_deferred_cohort_ids } =
    input;

  // ── 1. Group cohorts by bucket (skipping anything P2.31 already deferred).
  const cohortsByBucket = new Map<TerritoryBucket, TerritoryCohortInput[]>();
  for (const c of non_renew_cohorts) {
    if (already_deferred_cohort_ids.has(c.cohort_id)) continue;
    const bucket = classifyTerritory(c.zip3);
    const arr = cohortsByBucket.get(bucket) ?? [];
    arr.push(c);
    cohortsByBucket.set(bucket, arr);
  }

  const downgraded: TerritoryCapStamp[] = [];

  // ── 2. For each bucket, check the cap and downgrade smallest-first.
  for (const [bucket, cohorts] of cohortsByBucket.entries()) {
    const cap = capForBucket(bucket);
    // Denominator: bucket book TIV. Fall back to the bucket's own non-renew
    // TIV so a missing denominator never produces a divide-by-zero or a
    // misleading "no cap exceeded" result.
    const totalTivSum = cohorts.reduce((s, c) => s + c.total_tiv, 0);
    const denom = bucket_total_tiv[bucket] ?? totalTivSum;
    if (denom <= 0) continue;
    const observed = totalTivSum / denom;
    if (observed <= cap) continue;

    // Sort smallest-first; ties broken lexically by cohort_id for determinism.
    const sorted = [...cohorts].sort((a, b) => {
      if (a.total_tiv !== b.total_tiv) return a.total_tiv - b.total_tiv;
      return a.cohort_id.localeCompare(b.cohort_id);
    });

    let runningTiv = totalTivSum;
    const capTiv = cap * denom;
    for (const c of sorted) {
      if (runningTiv <= capTiv) break;
      downgraded.push({
        cohort_id: c.cohort_id,
        action: 'non_renew_capped',
        original_action: 'non_renew',
        downgrade_reason: 'territory_cap_exceeded',
        bucket,
        cap_fraction: cap,
        observed_fraction: observed,
      });
      runningTiv -= c.total_tiv;
    }
  }

  return { downgraded };
}
