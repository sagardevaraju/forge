/**
 * Task 15 — Cohort aggregation. (Task 13 — typed CvFeatures.)
 *
 * Groups the ~10k policies in the local book into cohorts defined by
 * (zip3, build_type, TIV quintile). Each cohort carries the aggregates the
 * Portfolio MIP (Task 16) needs to make a portfolio-level decision without
 * having to solve over 10k decision variables.
 *
 * Implementation notes
 * --------------------
 * - TIV quintile buckets are computed once across the entire book (not per
 *   zip3 or per build_type), so a "quintile 4" cohort always means "top
 *   ~20% of TIV in the book", regardless of which zip3 it sits in.
 * - We use 5 TIV buckets (quintiles, labeled 0..4) rather than 10 (deciles
 *   labeled 0..9). With 38 zip3s × 3 build_types × 10 deciles the cohort
 *   count balloons past 1000, which blows the spec-stated 60s Vercel MIP
 *   budget. Quintiles land us in the 200-500 range called for in Task 15.
 *   See `docs/cohort-card.md` for the cohort-id contract that downstream
 *   consumers (Portfolio MIP, Decision Reconciler, eval pipeline) join on.
 * - SQLite (libsql) doesn't ship NTILE on older builds we may target, and
 *   the book is small (~2MB), so we pull all rows into memory and compute
 *   bucket cutpoints + groupings in JS. This keeps the code portable and is
 *   measurably faster than firing 10k single-row queries.
 * - `cv_features` on the row is a JSON string of 8 floats emitted by the
 *   CV head (see `ml/cv/inference.py`). We average element-wise but ONLY
 *   surface the 5 modeled dims (indices 0, 2, 4, 5, 7). Phase 1 ships with
 *   3 dims (`imperviousness` @ idx 1, `roof_complexity` @ idx 3,
 *   `tree_overhang` @ idx 6) that have no real label signal — they are
 *   dropped here and re-introduced under Phase 2 / Task P2.37 once NLCD +
 *   OSM weak labels are wired in. `CvFeatures` is a typed object (not a
 *   raw `number[]`) so consumers can't accidentally render an unmodeled
 *   dim as if it were real.
 * - `flood_zone` is aggregated as the mode (most frequent value in the
 *   cohort). Ties are broken by lexical order, which is deterministic.
 */
import { db } from './client';
import {
  type CvFeatureValue,
  type CvFeatures,
  UNMODELED_CV_DIMS,
} from '../portfolio/cv-features';

// Re-export the typed CV feature shapes for backwards compatibility with
// existing server-side imports (`@/lib/db/cohorts`). Client components should
// import them directly from `@/lib/portfolio/cv-features` so Turbopack can
// tree-shake the libSQL DB client out of the client bundle.
export type { CvFeatureValue, CvFeatures };
export { UNMODELED_CV_DIMS };

/**
 * Position of each modeled dim inside the raw 8-float `cv_features` JSON
 * vector emitted by the CV head. Single source of truth — keep in sync with
 * `ml/cv/inference.py::predict_chip_mock`.
 */
const MODELED_DIM_INDEX = {
  vegetation_density: 0,
  fuel_proximity: 2,
  water_proximity: 4,
  elevation_bucket: 5,
  structure_density: 7,
} as const;

export interface Cohort {
  id: string; // e.g., "330_wood_frame_q3"
  zip3: string;
  build_type: string;
  tiv_quintile: number; // 0..4 (TIV quintile bucket)
  policy_count: number;
  total_tiv: number;
  total_premium: number;
  avg_cv_features: CvFeatures; // 5 modeled dims; 3 unmodeled dropped (Task 13)
  modal_flood_zone: string;
  avg_elevation_m: number;
}

interface PolicyRow {
  zip3: string;
  build_type: string;
  tiv: number;
  premium_annual: number | null;
  cv_features: string | null;
  flood_zone: string | null;
  elevation_m: number | null;
}

/** Number of TIV buckets per the implementation note above. */
const TIV_BUCKETS = 5;

/**
 * Compute (TIV_BUCKETS - 1) cut-points splitting a sorted ascending numeric
 * array into TIV_BUCKETS equally-sized buckets using linear interpolation
 * between the two nearest ranks. With TIV_BUCKETS = 5 these are the
 * 20th, 40th, 60th and 80th percentiles (quintile cuts).
 */
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

/** Bin a value into 0..(TIV_BUCKETS - 1) using strict-less comparison. */
function tivBin(tiv: number, cuts: number[]): number {
  for (let i = 0; i < cuts.length; i++) {
    if (tiv < cuts[i]) return i;
  }
  return TIV_BUCKETS - 1;
}

export async function aggregateCohorts(): Promise<Cohort[]> {
  const res = await db.execute(
    `SELECT zip3, build_type, tiv, premium_annual, cv_features,
            flood_zone, elevation_m
       FROM policies`
  );

  const rows: PolicyRow[] = res.rows.map((r) => ({
    zip3: String(r.zip3),
    build_type: String(r.build_type),
    tiv: Number(r.tiv),
    premium_annual: r.premium_annual == null ? null : Number(r.premium_annual),
    cv_features: r.cv_features == null ? null : String(r.cv_features),
    flood_zone: r.flood_zone == null ? null : String(r.flood_zone),
    elevation_m: r.elevation_m == null ? null : Number(r.elevation_m),
  }));

  if (rows.length === 0) return [];

  // 1. TIV bucket cut-points over the full book.
  const tivsSorted = rows.map((r) => r.tiv).sort((a, b) => a - b);
  const cuts = tivCutpoints(tivsSorted);

  // 2. Accumulators per cohort key.
  interface Bucket {
    zip3: string;
    build_type: string;
    tiv_quintile: number;
    policy_count: number;
    total_tiv: number;
    total_premium: number;
    cv_sum: number[]; // length 8 running sum
    cv_n: number; // count of policies with valid cv_features
    flood_zone_counts: Map<string, number>;
    elevation_sum: number;
    elevation_n: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const quintile = tivBin(row.tiv, cuts);
    const key = `${row.zip3}_${row.build_type}_q${quintile}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        zip3: row.zip3,
        build_type: row.build_type,
        tiv_quintile: quintile,
        policy_count: 0,
        total_tiv: 0,
        total_premium: 0,
        cv_sum: new Array(8).fill(0),
        cv_n: 0,
        flood_zone_counts: new Map(),
        elevation_sum: 0,
        elevation_n: 0,
      };
      buckets.set(key, b);
    }
    b.policy_count += 1;
    b.total_tiv += row.tiv;
    b.total_premium += row.premium_annual ?? 0;

    if (row.cv_features) {
      try {
        const v = JSON.parse(row.cv_features) as unknown;
        if (Array.isArray(v) && v.length === 8) {
          for (let i = 0; i < 8; i++) {
            const x = Number(v[i]);
            if (Number.isFinite(x)) b.cv_sum[i] += x;
          }
          b.cv_n += 1;
        }
      } catch {
        // ignore malformed JSON; cohort cv_features will average over the rest
      }
    }

    if (row.flood_zone) {
      b.flood_zone_counts.set(
        row.flood_zone,
        (b.flood_zone_counts.get(row.flood_zone) ?? 0) + 1
      );
    }
    if (row.elevation_m != null && Number.isFinite(row.elevation_m)) {
      b.elevation_sum += row.elevation_m;
      b.elevation_n += 1;
    }
  }

  // 3. Materialize Cohort objects.
  const out: Cohort[] = [];
  for (const [key, b] of buckets) {
    // Average the raw 8-float vector element-wise, then project only the
    // modeled positions into the typed CvFeatures object. The three
    // unmodeled positions (1, 3, 6) are intentionally dropped — they
    // carry no real label signal until Phase 2 / Task P2.37.
    const avgRaw =
      b.cv_n > 0
        ? b.cv_sum.map((s) => s / b.cv_n)
        : new Array<number>(8).fill(0);
    const avg_cv_features: CvFeatures = {
      vegetation_density: {
        value: avgRaw[MODELED_DIM_INDEX.vegetation_density],
        modeled: true,
      },
      fuel_proximity: {
        value: avgRaw[MODELED_DIM_INDEX.fuel_proximity],
        modeled: true,
      },
      water_proximity: {
        value: avgRaw[MODELED_DIM_INDEX.water_proximity],
        modeled: true,
      },
      elevation_bucket: {
        value: avgRaw[MODELED_DIM_INDEX.elevation_bucket],
        modeled: true,
      },
      structure_density: {
        value: avgRaw[MODELED_DIM_INDEX.structure_density],
        modeled: true,
      },
    };

    let modal_flood_zone = '';
    let bestCount = -1;
    // Iterate in sorted-key order so ties are deterministic.
    const sortedZones = [...b.flood_zone_counts.keys()].sort();
    for (const z of sortedZones) {
      const c = b.flood_zone_counts.get(z) ?? 0;
      if (c > bestCount) {
        bestCount = c;
        modal_flood_zone = z;
      }
    }

    const avg_elevation_m = b.elevation_n > 0 ? b.elevation_sum / b.elevation_n : 0;

    out.push({
      id: key,
      zip3: b.zip3,
      build_type: b.build_type,
      tiv_quintile: b.tiv_quintile,
      policy_count: b.policy_count,
      total_tiv: b.total_tiv,
      total_premium: b.total_premium,
      avg_cv_features,
      modal_flood_zone,
      avg_elevation_m,
    });
  }

  // Stable, debuggable ordering.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
