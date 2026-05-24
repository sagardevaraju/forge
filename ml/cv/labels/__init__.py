"""
FORGE — CV head weak-label sources (Phase 2 / Task P2.37).

Each submodule emits per-policy floats in [0, 1] for the three previously
unmodeled CV head dimensions (`imperviousness` idx 1, `roof_complexity`
idx 3, `tree_overhang` idx 6) of the 8-dim feature vector defined in
``ml/cv/inference.py``.

Submodules
----------
esa_worldcover
    ESA WorldCover 2021 (CC-BY-4.0, 10 m raster on MPC). Computes both
    `imperviousness` (class 50 fraction) and `tree_overhang` (class 10
    fraction) from a single STAC fetch aligned to the cached
    Sentinel-2 chip extent.

ms_buildings
    Microsoft US Building Footprints (ODbL-1.0, vector on MPC, Bing
    Maps 2014-2021). Computes `roof_complexity` as ``1 - mean(PP)``
    where PP is the per-building Polsby-Popper compactness over
    buildings whose centroid falls inside the chip bbox.

quadkey
    Bing Maps tile-system quadkey conversion. Used by ``ms_buildings``
    to navigate the partitioned parquet without scanning the entire
    9 GB US footprint dump.

Design spec: ``docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md``
Plan task:   ``docs/superpowers/plans/2026-05-16-forge-redesign.md`` (P2.37)
"""
