"""
Microsoft US Building Footprints weak-label source.

Data source
-----------
Microsoft. *US Building Footprints* (Bing Maps imagery, 2014-2021).
129+ M polygons across the contiguous US, classified by an internal
deep-learning pipeline against Maxar / Airbus / Bing imagery.

- Catalog:   https://github.com/microsoft/USBuildingFootprints
- License:   ODbL-1.0 (Open Database License)
- Attribution: "© Microsoft, OpenStreetMap contributors (ODbL)"
- Distribution: Microsoft Planetary Computer STAC collection
                ``ms-buildings`` (https://planetarycomputer.microsoft.com/
                dataset/ms-buildings)
- Schema:    One column ``geometry`` (binary, WKB-encoded polygons in EPSG:4326)
- Partition: ``RegionName=United States/quadkey=<9-digit Bing tile>``
             — 2,413 parquet shards, each covering one zoom-9 tile
             (~78 km × 78 km at the equator)
- Fetch date: 2026-05-23 (shards read on demand; no full-product download)

Output
------
For each policy this module emits ``roof_complexity`` ∈ ``[0, 1]``,
computed as ``1 − mean(PP)`` where ``PP`` is the Polsby-Popper
compactness ``4π · area / perimeter²`` (1 = circle, → 0 = jagged)
over every building whose centroid falls inside the policy's chip
bbox. Empty bbox (no buildings) → ``roof_complexity = 0`` (rural
parcel, no rooftops to be complex).

Why Polsby-Popper for "roof complexity"
---------------------------------------
The CV head dim was originally a band-math heuristic (B04 mean as a
"roof brightness" proxy). The dim's real-world meaning is *complex
roof geometry* (multiple gables, dormers, additions) which raises
claim cost for hail / wind perils relative to a simple gable roof of
the same square footage. From a building footprint, the cleanest
proxy is the perimeter-to-area ratio: a footprint with many
re-entrant corners has a high perimeter² / area, and footprints with
complex roofs tend to follow complex perimeters (the roof's ridge
lines map onto the polygon's edges).

The Polsby-Popper compactness ``PP = 4π A / P²`` normalizes that
ratio to ``[0, 1]`` (circle = 1, square ≈ 0.785, narrow L-shape
≈ 0.4, complex H ≈ 0.2). We average PP across buildings in the chip
and invert so higher means more jagged — matching the existing
``CvFeatures`` convention that all dims are "higher = more risk".

References
----------
Polsby DD, Popper RD. *The Third Criterion: Compactness as a Procedural
Safeguard Against Partisan Gerrymandering.* Yale Law & Policy Review,
1991, 9(2):301-353.

Why the plan's OSM Overpass default was rejected
------------------------------------------------
Overpass works (verified 2026-05-23 with proper User-Agent header)
but each query is 1-2 s and the 10k-policy precompute would push
into the 10k-queries-per-day soft cap of overpass-api.de. MS
Building Footprints' partitioned parquet on MPC is offline-friendly,
sharded by quadkey for efficient spatial access, and ships under the
same ODbL license as OSM — strictly more usable for our scale.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable, Sequence

import numpy as np

#: Cap on per-policy bbox geometry decodes — defends against pathological
#: shards (e.g. an urban core with 500k buildings inside one chip bbox).
#: 5000 is well above the densest US chip extent (~2000 buildings in a
#: 2.5 km Manhattan window).
MAX_BUILDINGS_PER_CHIP = 5000

#: Cap on shard cache size. Each shard decodes to ~200k geometries; holding
#: 16 in memory uses ~1-2 GB but lets the precompute reuse shards across
#: many policies in the same metro area.
_SHARD_CACHE_SIZE = 16


@dataclass(frozen=True)
class RoofComplexity:
    """Per-policy roof_complexity reduction with provenance counts."""

    value: float                # 1 − mean(PP); 0 when no buildings in bbox
    n_buildings: int            # count of buildings whose centroid is in bbox
    n_geometries_scanned: int   # total geometries decoded from the shard

    def as_dict(self) -> dict[str, float | int]:
        return {
            "roof_complexity": self.value,
            "n_buildings_in_chip": self.n_buildings,
            "n_geometries_scanned": self.n_geometries_scanned,
        }


def polsby_popper(area: float, perimeter: float) -> float:
    """Return ``4π · area / perimeter²``; ``0`` for degenerate inputs.

    Used to normalize building shape compactness to ``[0, 1]`` (circle = 1,
    increasingly jagged shapes → 0). Lifted out so tests can verify it
    independently of the parquet plumbing.
    """
    if perimeter <= 0.0 or area < 0.0:
        return 0.0
    pp = 4.0 * math.pi * area / (perimeter * perimeter)
    # Numerical guard: a digitized polygon can clip very slightly above 1.0;
    # the math says PP ≤ 1 with equality only for the circle, so cap.
    return max(0.0, min(1.0, pp))


def reduce_geometries(
    geometries: Iterable["shapely.geometry.base.BaseGeometry"],  # noqa: F821
    chip_bbox: tuple[float, float, float, float],
) -> RoofComplexity:
    """Average Polsby-Popper across buildings whose centroid is in ``chip_bbox``.

    ``geometries`` is any iterable yielding shapely polygons (typically
    coming from ``shapely.wkb.loads`` over a parquet shard). Filtering
    is centroid-in-bbox so a building straddling the chip edge counts
    if and only if its centre of mass is inside.

    Returns
    -------
    RoofComplexity
        ``value`` is ``1 − mean(PP)``; ``n_buildings`` is the count of
        polygons that passed the bbox test. Empty bbox → value = 0.
    """
    lon_min, lat_min, lon_max, lat_max = chip_bbox

    pp_sum = 0.0
    pp_count = 0
    scanned = 0
    for g in geometries:
        scanned += 1
        # Cheap reject via centroid first; shapely's centroid is O(1) for
        # small polygons and far cheaper than .intersects(box).
        c = g.centroid
        cx, cy = c.x, c.y
        if not (lon_min <= cx <= lon_max and lat_min <= cy <= lat_max):
            continue
        pp_sum += polsby_popper(g.area, g.length)
        pp_count += 1
        if pp_count >= MAX_BUILDINGS_PER_CHIP:
            break  # defensive cap; see MAX_BUILDINGS_PER_CHIP docstring

    if pp_count == 0:
        return RoofComplexity(value=0.0, n_buildings=0, n_geometries_scanned=scanned)
    mean_pp = pp_sum / pp_count
    return RoofComplexity(
        value=1.0 - mean_pp,
        n_buildings=pp_count,
        n_geometries_scanned=scanned,
    )


# ---------------------------------------------------------------------------
# Shard reader — sharded by Bing Maps quadkey at zoom 9
# ---------------------------------------------------------------------------


def _signed_collection():
    """Return a planetary_computer-signed STAC catalog (lazily imported)."""
    import planetary_computer  # noqa: PLC0415
    import pystac_client  # noqa: PLC0415

    return pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )


@lru_cache(maxsize=1)
def _us_item() -> "pystac.Item":  # noqa: F821
    """Resolve the most recent ``ms-buildings`` item for ``RegionName=United States``.

    Cached because the STAC search itself takes ~1 s and the item URL is
    valid for the lifetime of the signed credential (about 24 h on MPC).
    """
    catalog = _signed_collection()
    items = list(catalog.search(
        collections=["ms-buildings"],
        bbox=[-125.0, 24.0, -66.0, 50.0],   # CONUS bbox
        max_items=10,
    ).items())
    us_items = [it for it in items if "United States" in it.id]
    if not us_items:
        raise RuntimeError(
            "No ms-buildings item found for the US region. The collection "
            "may have moved; rerun the source audit in "
            "docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md"
        )
    # Items are stamped with a snapshot date; pick the most recent one
    # deterministically by id so reruns are reproducible.
    us_items.sort(key=lambda it: it.id, reverse=True)
    return us_items[0]


def _open_blob_filesystem():
    """Return an ``adlfs.AzureBlobFileSystem`` keyed to the signed MS Buildings URL."""
    import adlfs  # noqa: PLC0415

    item = _us_item()
    storage_options = item.assets["data"].extra_fields["table:storage_options"]
    return adlfs.AzureBlobFileSystem(**storage_options)


def _shard_path(quadkey: str) -> str:
    """Return the absolute partition path for ``quadkey`` inside the asset."""
    item = _us_item()
    base = item.assets["data"].href.replace("abfs://", "")
    return f"{base}/quadkey={quadkey}"


@lru_cache(maxsize=_SHARD_CACHE_SIZE)
def load_shard_geometries(quadkey: str) -> tuple["shapely.geometry.base.BaseGeometry", ...]:  # noqa: F821
    """Read all building geometries from one quadkey shard.

    Returns
    -------
    tuple
        Tuple of shapely polygons (immutable for ``lru_cache`` safety).

    Notes
    -----
    The shard is ~30-200 MB on the wire. Reading + decoding takes 3-6 s on
    a residential connection; cached lookups are <1 ms. With 2,413 US
    shards and most chip queries landing in the same ~200 shards as the
    synthetic policy book, the cache hit-rate during precompute is high.
    """
    import pyarrow.dataset as ds  # noqa: PLC0415
    import shapely.wkb  # noqa: PLC0415

    fs = _open_blob_filesystem()
    dataset = ds.dataset(_shard_path(quadkey), filesystem=fs, format="parquet")
    table = dataset.to_table(columns=["geometry"])
    return tuple(
        shapely.wkb.loads(b.as_py())
        for b in table["geometry"]
        if b.is_valid
    )


def label_for_policy(
    lat: float,
    lon: float,
    chip_bbox: tuple[float, float, float, float] | None = None,
) -> RoofComplexity:
    """Compute ``roof_complexity`` for one policy.

    Parameters
    ----------
    lat, lon:
        Policy centroid (WGS-84).
    chip_bbox:
        Optional override; defaults to the result of
        :func:`ml.cv.labels.quadkey.chip_bbox` for a standard 256 × 10 m
        cached chip extent.

    Returns
    -------
    RoofComplexity
    """
    from ml.cv.labels.quadkey import chip_bbox as default_chip_bbox  # noqa: PLC0415
    from ml.cv.labels.quadkey import latlon_to_quadkey  # noqa: PLC0415

    qk = latlon_to_quadkey(lat, lon, zoom=9)
    geometries = load_shard_geometries(qk)
    bbox = chip_bbox if chip_bbox is not None else default_chip_bbox(lat, lon)
    return reduce_geometries(geometries, bbox)
