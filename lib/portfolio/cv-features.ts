/**
 * Typed CV-head feature shapes shared by server and client code. (Task 13.)
 *
 * Fix for Task 28 e2e: extracted from `lib/db/cohorts.ts` so client components
 * don't pull `@libsql/client` into the bundle. `lib/db/cohorts.ts` imports
 * `./client` at module scope, which calls `createClient({ url: 'file:...' })`
 * — the web variant of `@libsql/client` rejects `file:` URLs and throws on
 * module load. `PortfolioDrillDown` only needs `CvFeatures` and
 * `UNMODELED_CV_DIMS`; pulling those values out of the DB module lets
 * Turbopack tree-shake the libSQL client out of the client chunk.
 *
 * Keep these definitions canonical here; `lib/db/cohorts.ts` re-exports them
 * for backwards compatibility with server-side imports.
 */

/**
 * A single modeled CV-head dimension with its cohort-averaged value.
 *
 * `modeled: true` is a phantom flag: consumers must not pattern-match on
 * `modeled === false`, since unmodeled dims are dropped entirely from the
 * object rather than being carried as null. The flag exists so the JSON
 * shape stays self-describing for the agent tools + drill-down UI.
 */
export interface CvFeatureValue {
  value: number;
  modeled: true;
}

/**
 * Cohort-averaged CV features, restricted to the 5 dims with real label
 * signal in Phase 1.
 *
 * Index → name mapping (matches `ml/cv/inference.py`):
 *
 *   0  vegetation_density   modeled    (NDVI mean)
 *   1  imperviousness       UNMODELED  — dropped in Phase 1
 *   2  fuel_proximity       modeled    (SWIR mean)
 *   3  roof_complexity      UNMODELED  — dropped in Phase 1
 *   4  water_proximity      modeled    (NDWI mean)
 *   5  elevation_bucket     modeled    (chip-hash bucket 0..4 / 4)
 *   6  tree_overhang        UNMODELED  — dropped in Phase 1
 *   7  structure_density    modeled    (Sobel edge density on NIR)
 *
 * The three unmodeled dims (idx 1, 3, 6) are re-introduced in Phase 2 via
 * Task P2.37 (NLCD + OSM weak-label retraining).
 */
export interface CvFeatures {
  vegetation_density: CvFeatureValue;
  fuel_proximity: CvFeatureValue;
  water_proximity: CvFeatureValue;
  elevation_bucket: CvFeatureValue;
  structure_density: CvFeatureValue;
}

/** Names of the unmodeled dims (idx 1, 3, 6) for UI/agent transparency. */
export const UNMODELED_CV_DIMS: readonly string[] = Object.freeze([
  'imperviousness',
  'roof_complexity',
  'tree_overhang',
]);
