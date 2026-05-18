// @vitest-environment node
/**
 * Task P2.32 — Tests for per-(state, territory) regulatory non-renew caps.
 *
 * Six tests:
 *   1. Territory classification: ZIP3 → (state, territory) labels.
 *   2. Single bucket under cap → no downgrade.
 *   3. Single bucket over cap → smallest cohorts downgraded until ≤ cap.
 *   4. Multiple buckets over cap → each downgraded independently.
 *   5. P2.31 interaction: already-deferred cohorts do not count toward the cap.
 *   6. Unknown territory falls back to the `__default__` cap.
 */
import { describe, test, expect } from 'vitest';
import {
  classifyTerritory,
  applyTerritoryCaps,
  TERRITORY_CAPS,
  type TerritoryCohortInput,
} from '@/lib/regulatory/territory_caps';

describe('classifyTerritory', () => {
  test.each([
    // Florida — Miami-Dade coast is coastal
    ['330', 'FL:coastal'],
    ['331', 'FL:coastal'],
    ['332', 'FL:coastal'],
    // Florida — Lee/Sarasota/St. Lucie are first-row coastal
    ['339', 'FL:coastal'],
    ['341', 'FL:coastal'],
    ['349', 'FL:coastal'],
    // Florida — inland Polk/Hernando
    ['334', 'FL:inland'],
    ['338', 'FL:inland'],
    ['346', 'FL:inland'],
    // Texas — Tier 1 coastal counties
    ['774', 'TX:tier_1'], // Galveston
    ['775', 'TX:tier_1'], // Galveston
    ['776', 'TX:tier_1'], // Jefferson
    ['777', 'TX:tier_1'], // Jefferson
    ['778', 'TX:tier_1'], // Brazoria
    ['783', 'TX:tier_1'], // Nueces
    ['784', 'TX:tier_1'], // Nueces
    // Texas — Tier 2 (Harris is inland of the seawall)
    ['770', 'TX:tier_2'],
    // Louisiana — coastal parishes
    ['703', 'LA:coastal'], // Orleans
    ['704', 'LA:coastal'], // Jefferson
    ['706', 'LA:coastal'], // Calcasieu
    // Louisiana — inland
    ['705', 'LA:inland'], // Tangipahoa
    ['707', 'LA:inland'], // Livingston
    ['708', 'LA:inland'], // Ascension
    ['714', 'LA:inland'], // Beauregard
    // North Carolina — coastal counties
    ['289', 'NC:coastal'], // New Hanover
    // North Carolina — inland
    ['275', 'NC:inland'],
    ['280', 'NC:inland'],
    // Unknown ZIP3 → unknown bucket
    ['999', '__default__'],
    ['012', '__default__'],
  ])('zip3 %s → %s', (zip3, expected) => {
    expect(classifyTerritory(zip3)).toBe(expected);
  });
});

describe('applyTerritoryCaps', () => {
  /** Build a synthetic non_renew cohort entry. */
  const nr = (
    cohort_id: string,
    zip3: string,
    total_tiv: number,
  ): TerritoryCohortInput => ({
    cohort_id,
    zip3,
    total_tiv,
    non_renew_share: 1.0, // 100% non-renew for clarity
  });

  test('single bucket under cap — no downgrade emitted', () => {
    // FL:coastal cap is 3%. Two cohorts non-renew 200k of a 10M FL:coastal book = 2%.
    const result = applyTerritoryCaps({
      non_renew_cohorts: [nr('A', '330', 100_000), nr('B', '331', 100_000)],
      bucket_total_tiv: { 'FL:coastal': 10_000_000 },
      already_deferred_cohort_ids: new Set(),
    });
    expect(result.downgraded).toEqual([]);
  });

  test('single bucket over cap — downgrade smallest cohorts until ≤ cap', () => {
    // FL:coastal cap is 3%. Book is 10M.
    // Cohort sizes: 100k, 200k, 250k → total 550k = 5.5% > 3% (300k).
    // Downgrade smallest first: drop 100k (still 450k > 300k), then 200k (still 250k ≤ 300k OK).
    // Final retained non_renew TIV = 250k.
    const result = applyTerritoryCaps({
      non_renew_cohorts: [
        nr('small', '330', 100_000),
        nr('mid', '331', 200_000),
        nr('big', '332', 250_000),
      ],
      bucket_total_tiv: { 'FL:coastal': 10_000_000 },
      already_deferred_cohort_ids: new Set(),
    });
    const downgradedIds = result.downgraded.map((s) => s.cohort_id).sort();
    expect(downgradedIds).toEqual(['mid', 'small']);
    // Each stamp carries the right metadata.
    for (const s of result.downgraded) {
      expect(s.action).toBe('non_renew_capped');
      expect(s.original_action).toBe('non_renew');
      expect(s.downgrade_reason).toBe('territory_cap_exceeded');
      expect(s.bucket).toBe('FL:coastal');
      expect(s.cap_fraction).toBeCloseTo(0.03, 6);
      expect(s.observed_fraction).toBeCloseTo(0.055, 6); // 550k/10M before downgrade
    }
  });

  test('multiple buckets — each over its own cap → independent downgrades', () => {
    // FL:coastal cap=3%, book 10M, non_renew=500k (5%) → cap=300k → downgrade 200k smallest.
    // TX:tier_1 cap=4%, book 5M, non_renew=400k (8%) → cap=200k → downgrade 200k smallest.
    const result = applyTerritoryCaps({
      non_renew_cohorts: [
        nr('fl_small', '330', 200_000),
        nr('fl_big', '331', 300_000),
        nr('tx_small', '774', 150_000),
        nr('tx_mid', '775', 100_000),
        nr('tx_big', '776', 150_000),
      ],
      bucket_total_tiv: {
        'FL:coastal': 10_000_000,
        'TX:tier_1': 5_000_000,
      },
      already_deferred_cohort_ids: new Set(),
    });
    const flDowngraded = result.downgraded.filter((s) => s.bucket === 'FL:coastal');
    const txDowngraded = result.downgraded.filter((s) => s.bucket === 'TX:tier_1');
    expect(flDowngraded.map((s) => s.cohort_id)).toEqual(['fl_small']);
    // TX needs to drop ≥200k from 400k (cap 200k). Smallest-first with lexical
    // tie-break on equal TIV: tx_mid (100k) → 300k still > 200k; next tied at
    // 150k are tx_big < tx_small lexically → drop tx_big → 150k ≤ 200k, stop.
    expect(txDowngraded.map((s) => s.cohort_id).sort()).toEqual(['tx_big', 'tx_mid']);
  });

  test('P2.31 interaction — already-deferred cohorts do not count toward bucket cap', () => {
    // Same total non_renew TIV as the "over cap" test, but cohort `big` is already
    // deferred by the notice-period filter. Effective non_renew this cycle = 300k (3%),
    // which is at the cap → no further downgrade.
    const result = applyTerritoryCaps({
      non_renew_cohorts: [
        nr('small', '330', 100_000),
        nr('mid', '331', 200_000),
        nr('big', '332', 250_000),
      ],
      bucket_total_tiv: { 'FL:coastal': 10_000_000 },
      already_deferred_cohort_ids: new Set(['big']),
    });
    expect(result.downgraded).toEqual([]);
  });

  test('unknown territory uses the __default__ cap', () => {
    // Unknown ZIP3 999 → bucket __default__ → cap 5%. Book 1M, non_renew 80k = 8% > 5%.
    // Need to drop ≥30k. Smallest is 30k → drop it → 50k ≤ 50k.
    const result = applyTerritoryCaps({
      non_renew_cohorts: [nr('u1', '999', 30_000), nr('u2', '999', 50_000)],
      bucket_total_tiv: { __default__: 1_000_000 },
      already_deferred_cohort_ids: new Set(),
    });
    expect(result.downgraded.map((s) => s.cohort_id)).toEqual(['u1']);
    expect(result.downgraded[0].bucket).toBe('__default__');
    expect(result.downgraded[0].cap_fraction).toBe(TERRITORY_CAPS.__default__);
  });
});
