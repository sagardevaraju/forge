/**
 * Typed CV-head feature shapes shared by server and client code.
 *
 * Phase 2 / Task P2.37: the 3 dims that were dropped under Phase 1
 * (`imperviousness` idx 1, `roof_complexity` idx 3, `tree_overhang` idx 6)
 * are now first-class members of the typed shape, supervised by real
 * image-derived weak labels:
 *
 *   - `imperviousness` ← ESA WorldCover 2021 class 50 (Built-up) fraction
 *     over the chip extent. Source: ``ml/cv/labels/esa_worldcover.py``.
 *     License: CC-BY-4.0.
 *   - `tree_overhang`  ← ESA WorldCover 2021 class 10 (Tree cover)
 *     fraction over the chip extent. Same source as imperviousness.
 *   - `roof_complexity` ← ``1 − mean(Polsby-Popper)`` over Microsoft
 *     US Building Footprints inside the chip bbox. License: ODbL-1.0.
 *     Source: ``ml/cv/labels/ms_buildings.py``.
 *
 * `lib/db/cohorts.ts` was originally the home of these definitions; it
 * imports `@libsql/client` at module scope, which Turbopack chokes on in
 * the client bundle for the web variant. Keeping the types in this
 * dedicated module lets client components (PortfolioDrillDown) tree-shake
 * the DB client out.
 */

/**
 * A single CV-head dimension with its cohort-averaged value and a stable
 * citation pointer for the UI to render the source attribution.
 *
 * `modeled: true` is a phantom flag carried from Phase 1 when 3 dims were
 * literally dropped from the object. All 8 dims are now modeled, so the
 * flag is effectively constant — but consumers may still rely on it for
 * type narrowing and the JSON shape stays self-describing.
 */
export interface CvFeatureValue {
  value: number;
  modeled: true;
  /** Short identifier of the data source — UI uses this to look up the
   * citation footer (one citation block per source, not per dim). */
  source: CvFeatureSource;
}

/**
 * Canonical set of data sources that supply at least one CV head dim.
 *
 * `bandmath` — band-math statistics computed on the cached Sentinel-2
 * chip (NDVI mean, NDWI mean, SWIR, edge density). Cited as
 * ``ml/cv/inference.py::predict_chip_mock`` in the UI footer.
 *
 * `esa_worldcover` — ESA WorldCover 2021 v200, CC-BY-4.0, 10 m raster.
 * Supplies `imperviousness` and `tree_overhang`.
 *
 * `ms_buildings` — Microsoft US Building Footprints, ODbL-1.0 (Bing
 * Maps 2014-2021). Supplies `roof_complexity` via
 * ``1 − mean(Polsby-Popper)``.
 */
export type CvFeatureSource = 'bandmath' | 'esa_worldcover' | 'ms_buildings';

/**
 * Cohort-averaged CV features — all 8 dims, modeled.
 *
 * Index → name mapping (matches `ml/cv/inference.py` and
 * `ml/cv/train.py::WEAK_LABEL_INDICES`):
 *
 *   0  vegetation_density   bandmath (NDVI mean)
 *   1  imperviousness       esa_worldcover (class 50 fraction)            ← Phase 2 P2.37
 *   2  fuel_proximity       bandmath (SWIR mean)
 *   3  roof_complexity      ms_buildings (1 − mean Polsby-Popper)          ← Phase 2 P2.37
 *   4  water_proximity      bandmath (NDWI mean)
 *   5  elevation_bucket     bandmath (chip-hash bucket 0..4 / 4)
 *   6  tree_overhang        esa_worldcover (class 10 fraction)             ← Phase 2 P2.37
 *   7  structure_density    bandmath (Sobel edge density on NIR)
 */
export interface CvFeatures {
  vegetation_density: CvFeatureValue;
  imperviousness: CvFeatureValue;
  fuel_proximity: CvFeatureValue;
  roof_complexity: CvFeatureValue;
  water_proximity: CvFeatureValue;
  elevation_bucket: CvFeatureValue;
  tree_overhang: CvFeatureValue;
  structure_density: CvFeatureValue;
}

/**
 * Per-source citation metadata rendered in the drill-down footer.
 *
 * Sourced from ``docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md``
 * and ``research.md`` §12 — keep in sync.
 */
export const CV_FEATURE_SOURCES: Record<
  CvFeatureSource,
  { label: string; license: string; href: string; attribution: string }
> = Object.freeze({
  bandmath: {
    label: 'Sentinel-2 band math',
    license: 'derived',
    href: 'https://github.com/sagardevaraju/FORGE/blob/main/ml/cv/inference.py',
    attribution: 'NDVI / NDWI / SWIR / edge density on cached S2-L2A chips',
  },
  esa_worldcover: {
    label: 'ESA WorldCover 2021',
    license: 'CC-BY-4.0',
    href: 'https://esa-worldcover.org/en',
    attribution: '© ESA WorldCover 2021 — Zanaga et al., doi:10.5281/zenodo.7254221',
  },
  ms_buildings: {
    label: 'Microsoft US Building Footprints',
    license: 'ODbL-1.0',
    href: 'https://github.com/microsoft/USBuildingFootprints',
    attribution: '© Microsoft, OpenStreetMap contributors (ODbL)',
  },
});

/**
 * Phase 1 left this list populated with the 3 unmodeled dim names so the
 * UI could disclose them. After Phase 2 / Task P2.37 every dim is
 * modeled, so the list is empty — kept as a typed export for backwards
 * compatibility with code that iterates it (no consumer should branch on
 * `length > 0` going forward).
 */
export const UNMODELED_CV_DIMS: readonly string[] = Object.freeze([]);
