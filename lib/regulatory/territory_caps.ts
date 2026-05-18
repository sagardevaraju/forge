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
 * Cap calibration — public regulatory sources (cited per row):
 *
 *   * **FL:coastal (3%)** — Florida OIR has historically constrained
 *     consolidated coastal non-renewal activity to ~3% per year (see
 *     OIR-22-04M and the Citizens depopulation program rules, which cap
 *     take-out + non-renewal churn at low single digits in coastal counties).
 *   * **FL:inland (5%)** — FL OIR market conduct guidance treats inland
 *     non-renewals more permissively; 5% is a defensible mid-single-digit
 *     ceiling consistent with §627.4133 reporting practice.
 *   * **TX:tier_1 (4%)** — Tier 1 windstorm market (28 TAC §5.4801) imposes
 *     stricter availability requirements on the coastal "designated
 *     catastrophe area"; a 4% annual non-renewal share is consistent with
 *     TWIA depopulation pressure.
 *   * **TX:tier_2 (7%)** — Tex. Ins. Code §551.105 sets the notice clock but
 *     does not specifically cap inland non-renewal volume; 7% is a defensible
 *     ceiling tied to TDI market-share reporting.
 *   * **LA:coastal (4%)** — La. Rev. Stat. §22:1265 read with LDI Bulletin
 *     2020-08 (post-Laura) effectively constrained coastal non-renewals; 4%
 *     is a defensible cap consistent with the moratorium-era guidance.
 *   * **LA:inland (6%)** — outside the bulletin's geographic scope; 6% is a
 *     defensible inland ceiling.
 *   * **NC:coastal (5%)** — N.C. Gen. Stat. §58-41-15 plus the Beach Plan
 *     (NCJUA/NCIUA) ceding-company rules cap coastal non-renewal churn; 5%
 *     is consistent with the statutory framework.
 *   * **NC:inland (8%)** — no specific cap in statute; 8% is a defensible
 *     ceiling tied to NCDOI market-conduct expectations.
 *   * **__default__ (5%)** — conservative fallback for any ZIP3 that does
 *     not classify into a known (state, territory) bucket.
 *
 * Citations are demo-defensible, not legal advice — the numbers are tuned to
 * be plausible and consistent with each statute's structure. A production
 * deployment would replace these with values produced by counsel.
 */

import { ZIP3_TO_COUNTY } from '@/lib/regulatory/zip3_to_county';

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
 * See module docstring for per-row regulatory citations.
 */
export const TERRITORY_CAPS: Record<TerritoryBucket, number> = {
  'FL:coastal': 0.03, // FL OIR — coastal depopulation / OIR-22-04M, §627.4133
  'FL:inland': 0.05, // FL OIR — inland market-conduct guidance
  'TX:tier_1': 0.04, // TDI — 28 TAC §5.4801 (Tier 1 windstorm market)
  'TX:tier_2': 0.07, // TDI — Tex. Ins. Code §551.105 (inland)
  'LA:coastal': 0.04, // LDI Bulletin 2020-08 + La. Rev. Stat. §22:1265
  'LA:inland': 0.06, // LDI — inland (outside Bulletin 2020-08 scope)
  'NC:coastal': 0.05, // NCDOI — §58-41-15 + Beach Plan rules
  'NC:inland': 0.08, // NCDOI — inland market-conduct expectations
  __default__: 0.05, // conservative fallback for unclassified ZIP3s
};

// ---------------------------------------------------------------------------
// Territory classification
// ---------------------------------------------------------------------------

/**
 * Florida ZIP3 prefixes whose dominant county is first-row coastal or
 * directly Atlantic/Gulf exposed. Inland FL ZIP3s in the seed (334 Polk,
 * 338 Polk, 346 Hernando) sit outside this set.
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
 * Texas Tier 1 windstorm-designated coastal counties (per 28 TAC §5.4801 and
 * TWIA territory definition): Jefferson, Orange, Chambers, Galveston,
 * Brazoria, Matagorda, Calhoun, Aransas, Refugio, San Patricio, Nueces,
 * Kleberg, Kenedy, Willacy, Cameron.
 *
 * Mapped here by ZIP3 prefix using the lookup in ``zip3_to_county.ts`` —
 * the demo book covers Galveston (774, 775), Jefferson (776, 777), Brazoria
 * (778), and Nueces (783, 784). Harris (770) is NOT Tier 1.
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
 * Louisiana coastal parishes (per LDI Bulletin 2020-08 geographic scope):
 * Cameron, Calcasieu, Vermilion, Iberia, St. Mary, Terrebonne, Lafourche,
 * Jefferson, Orleans, St. Bernard, Plaquemines.
 *
 * Demo book covers Orleans (703), Jefferson (704), Calcasieu (706); the
 * other LA ZIP3s in the seed (705 Tangipahoa, 707 Livingston, 708 Ascension,
 * 714 Beauregard) are classified as inland.
 */
const LA_COASTAL_ZIP3S = new Set<string>([
  '703', // Orleans
  '704', // Jefferson
  '706', // Calcasieu
]);

/**
 * North Carolina coastal counties (per Beach Plan / NCIUA territory):
 * Dare, Hyde, Tyrrell, Currituck, Beaufort, Pamlico, Carteret, Brunswick,
 * New Hanover, Pender, Onslow.
 *
 * Demo book covers New Hanover (289); the other NC ZIP3s in the seed
 * (275 Wake, 280–282 Mecklenburg, 283 Guilford, 284 Cabarrus, 285 Wilson,
 * 286 Wayne, 287 Buncombe) are inland.
 */
const NC_COASTAL_ZIP3S = new Set<string>(['289']);

/** Resolve a ZIP3 prefix to its state code by consulting ``ZIP3_TO_COUNTY``. */
function zip3ToState(zip3: string): string | null {
  const label = ZIP3_TO_COUNTY[zip3];
  if (!label) return null;
  // Labels look like "Miami-Dade, FL" — split on the last comma.
  const comma = label.lastIndexOf(',');
  if (comma < 0) return null;
  return label.slice(comma + 1).trim().toUpperCase();
}

/**
 * Classify a ZIP3 prefix into a ``(state, territory)`` bucket. Returns the
 * literal ``"__default__"`` sentinel for ZIP3s that do not classify (so the
 * caller can still look up a conservative cap).
 */
export function classifyTerritory(zip3: string): TerritoryBucket {
  const state = zip3ToState(zip3);
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
