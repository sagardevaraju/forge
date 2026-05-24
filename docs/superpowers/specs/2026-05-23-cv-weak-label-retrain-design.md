# Design: P2.37 — CV head weak-label retraining for the 3 unmodeled dims

**Date:** 2026-05-23
**Plan task:** [P2.37 in `docs/superpowers/plans/2026-05-16-forge-redesign.md`](../plans/2026-05-16-forge-redesign.md)
**Branch:** `feat/cv-weak-label-retrain-p2.37`

## Problem

`ml/cv/train.py::_derive_labels` derives all 8 CV-head supervision labels from
`(flood_zone, build_type, elevation_m)` policy *metadata* — no chip dependency.
The optimal MLP under that supervision is a constant function (per-policy
stdev ≈ 0.011 vs raw NDVI 0.10), so the trained head shipped in
`artifacts/cv_head.pt` is bypassed by default. `lib/portfolio/cv-features.ts`
encodes this by dropping 3 dims (`imperviousness` idx 1, `roof_complexity` idx 3,
`tree_overhang` idx 6) as `UNMODELED_CV_DIMS`. Phase 2 P2.37 re-introduces them
with real image-derived weak labels.

## Source audit — plan defaults rejected

The plan named NLCD + OSM + USGS 3DEP DEM. Audit results (2026-05-23):

| Plan source | Verdict | Reason |
|---|---|---|
| NLCD landcover (MRLC.gov) | Reject — replace | Not on MPC; 30m only (3× coarser than chips); separate fetch infra |
| OSM building footprints (Overpass) | Reject — replace | Works (200 with User-Agent), but 10k queries rate-limited; flaky |
| **USGS 3DEP DEM (for tree_overhang)** | **Reject — wrong tool** | DEM = bare-earth terrain, not canopy. `3dep-lidar-hag` (the canopy-like product) is `proprietary` on MPC and has no coverage in FL Hernando 346. |

## Approved sources

| Dim | Source | License | Resolution | MPC collection |
|---|---|---|---|---|
| `imperviousness` (idx 1) | ESA WorldCover class 50 (Built-up) | CC-BY-4.0 | **10m — perfect S2 alignment** | `esa-worldcover` |
| `tree_overhang` (idx 6) | ESA WorldCover class 10 (Tree cover) | CC-BY-4.0 | **10m** | `esa-worldcover` (same fetch) |
| `roof_complexity` (idx 3) | Microsoft US Building Footprints (Bing 2014-2021, 999M polygons) | ODbL-1.0 | Vector (per-building) | `ms-buildings` |

Why this beats the plan default: (a) two STAC collections instead of three, both on the same MPC auth path as the existing chip cache; (b) ESA WorldCover at 10m gives one-to-one pixel alignment with the cached chips — no resampling artifacts; (c) one ESA WC fetch produces both idx 1 and idx 6; (d) MS Buildings gives a richer roof-complexity signal (perimeter²/area shape jaggedness) than rooftop reflectance.

ODbL on MS Buildings requires attribution — surfaced in the drill-down panel and `research.md` §12.

## Architecture

```
ml/cv/labels/
├── __init__.py
├── esa_worldcover.py   # class-50 (built-up) + class-10 (tree) fractions per chip
└── ms_buildings.py     # mean Polsby-Popper shape complexity per chip
```

Each module exports `compute_<source>_label(policy_id, lat, lon, chip)` returning a `float` (or `dict[str, float]` for ESA WC's two outputs) in `[0, 1]`. Each module's docstring cites: source URL, license, spatial resolution, fetch date, attribution string.

**Bulk label cache.** Computing labels per-policy live during the training loop is wasteful (10k × ESA WC fetch = ~30 min × N epochs). Solution: a one-time precompute that writes `artifacts/cv_weak_labels.parquet` keyed by `policy_id` with columns `[imperviousness, roof_complexity, tree_overhang]`. The training loader joins on `policy_id`.

```
scripts/precompute_cv_weak_labels.py
  → artifacts/cv_weak_labels.parquet (tracked, like the calibration/treaty artifacts)
```

**Training scheme.** `ml/cv/train.py::_derive_labels` is replaced with `_derive_labels_v2(policy_id, chip)`:
- idx 0, 2, 4, 5, 7 (`vegetation_density`, `fuel_proximity`, `water_proximity`, `elevation_bucket`, `structure_density`): `predict_chip_mock(chip)` at train time (current band-math kept as the supervision target).
- idx 1, 3, 6 (`imperviousness`, `roof_complexity`, `tree_overhang`): looked up from `cv_weak_labels.parquet`.

The legacy heuristic stays as `_derive_labels_legacy(flood_zone, build_type, elevation_m)` for regression comparison.

## Data flow

1. **Precompute** (offline, one-time, ~15 min):
   - For each `policy_id` with a cached chip:
     - Fetch ESA WC chip via MPC STAC (auto-aligned to S2 grid).
     - Compute `imperviousness = mean(esa_wc == 50)` and `tree_overhang = mean(esa_wc == 10)`.
     - Query MS Buildings parquet by chip bbox; per building compute Polsby-Popper compactness `PP = 4π · area / perimeter²` (range `[0, 1]`, 1 = perfect circle). `roof_complexity = 1 - mean(PP)` across buildings in chip — higher value = more jagged footprints. Empty bbox (no buildings) → `roof_complexity = 0` (rural, no roofs to be complex).
   - Write `artifacts/cv_weak_labels.parquet`.

2. **Retrain** (Apple Silicon MPS, ~10-20 min):
   - `python ml/cv/train.py --epochs 20 --batch-size 32`
   - Backup old head: `cp artifacts/cv_head.pt artifacts/cv_head.metadata-trained.pt`
   - Save new head to `artifacts/cv_head.pt`.

3. **Validate**:
   - For each retrained dim (idx 1, 3, 6): standard deviation of the head's output computed across all ~10k policies must be **> 0.05** (band-math NDVI achieves 0.10 across the book — we need to be in that ballpark, not collapsed to a constant like the metadata-trained head).
   - Per-ZIP3 averages for FL Hernando 346 (coastal/built-up) vs NC mountain 286 (forested) must differ meaningfully on `imperviousness` and `tree_overhang` (target: |Δ| > 0.15 on both).
   - If validation passes → flip `populate_cv_features.py` default to `bypass_head=False` and document in `research.md` §8e.
   - If validation fails → keep `bypass_head=True` default, leave head as fallback, document why.

4. **UI surface**:
   - Extend `CvFeatures` interface to all 8 dims (no longer dropping idx 1, 3, 6).
   - Extend `MODELED_DIM_INDEX` in `lib/db/cohorts.ts` with the 3 newly-modeled positions.
   - Remove `UNMODELED_CV_DIMS` constant (or keep empty array for compatibility).
   - Drill-down panel renders all 8 bars with per-dim citation footer pointing at the source.

## Acceptance criteria

- [ ] `artifacts/cv_weak_labels.parquet` exists and contains a `[imperviousness, roof_complexity, tree_overhang]` row for every `policy_id` whose chip has signal (`max(chip) > 0`).
- [ ] Per-source weak labels for FL Hernando 346 and NC mountain 286 differ by `|Δ| > 0.15` on imperviousness AND tree_overhang.
- [ ] Retrained head per-policy stdev > 0.05 on all 3 retrained dims (or doc explains why band-math bypass stays).
- [ ] All 8 dims surface in `/portfolio` drill-down for two distinct ZIPs (Playwright screenshot).
- [ ] `research.md` §12 cites every source: URL, license, dictionary, fetch date, attribution string.
- [ ] `npm test` + `pytest tests/ml/cv/ tests/components/` pass.

## Testing

- `tests/ml/cv/test_esa_worldcover.py`: synthetic 256×256 ESA WC chip with known class-50/class-10 fractions → assert label matches.
- `tests/ml/cv/test_ms_buildings.py`: synthetic GeoParquet with 3 known-shape buildings → assert Polsby-Popper aggregate.
- `tests/ml/cv/test_weak_label_cache.py`: precompute script writes valid parquet with expected columns.
- Mock external HTTP/parquet reads via `monkeypatch` — never hit MPC during pytest.
- `tests/components/PortfolioMap.test.tsx` fixture updates for 8-dim `CvFeatures`.

## Out of scope

- Retraining the **backbone** (still frozen ViT-B/16 — only the MLP head learns).
- Multi-year temporal labels (ESA WC has 2020 + 2021; we use 2021 only).
- Real-time label refresh on book upload — labels are precomputed against the static chip cache.

## Citations to be recorded in research.md §12

- ESA WorldCover: https://esa-worldcover.org/en, CC-BY-4.0, 10 m, 2021 product, fetched 2026-05-23 via Microsoft Planetary Computer (`esa-worldcover` STAC collection).
- Microsoft US Building Footprints: https://github.com/microsoft/USBuildingFootprints, ODbL-1.0, vector (Bing Maps 2014-2021), fetched 2026-05-23 via Microsoft Planetary Computer (`ms-buildings` STAC collection). Attribution: "© Microsoft, OpenStreetMap contributors (ODbL)".
- Polsby-Popper compactness: Polsby DD, Popper RD. *The Third Criterion: Compactness as a Procedural Safeguard Against Partisan Gerrymandering.* Yale Law & Policy Review, 1991.
