"""
ESA WorldCover 2021 weak-label source.

Data source
-----------
European Space Agency (ESA) WorldCover v200 (2021). Global 10 m land-cover
map produced from Sentinel-1 + Sentinel-2 observations, classified into
11 IPCC-style classes (codes 10-100).

- Catalog:   https://esa-worldcover.org/en
- License:   CC-BY-4.0 (Zanaga et al. 2022, doi:10.5281/zenodo.7254221)
- Distribution: Microsoft Planetary Computer STAC collection
                ``esa-worldcover`` (https://planetarycomputer.microsoft.com/
                dataset/esa-worldcover)
- Resolution: 10 m native (matches Sentinel-2 L2A chip resolution)
- CRS:        EPSG:4326 (geographic) — no UTM reprojection needed
- Fetch date: 2026-05-23 (cache vintage tracked alongside the chip cache)
- Attribution: "© ESA WorldCover 2021 (CC-BY-4.0)"

Class codes (per WorldCover v200 product manual §3.1):
    10  Tree cover           ← used here for `tree_overhang`
    20  Shrubland
    30  Grassland
    40  Cropland
    50  Built-up             ← used here for `imperviousness`
    60  Bare / sparse vegetation
    70  Snow & ice
    80  Permanent water bodies
    90  Herbaceous wetland
    95  Mangroves
    100 Moss and lichen

Why this source replaces NLCD (the plan's default)
--------------------------------------------------
The plan named NLCD landcover for `vegetation_density`, but NLCD is not
hosted on Microsoft Planetary Computer and would require a separate
direct fetch from MRLC.gov at 30 m resolution (3× coarser than the
cached Sentinel-2 chips). ESA WorldCover at 10 m gives one-to-one
pixel alignment with the chips and produces both class-50 (impervious)
and class-10 (tree) fractions from a single fetch, so the original
NLCD impervious + 3DEP canopy plan reduces to one source here.

Output
------
For each policy this module emits:
    {"imperviousness": float in [0, 1],
     "tree_overhang":  float in [0, 1]}

Both are simple area fractions of the ~256×256 ESA WorldCover window
centred on the policy's (lat, lon). The window is read directly from
the COG over HTTPS via rasterio — no full-product download required.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np

#: ESA WorldCover class codes (single source of truth).
WC_CLASS_TREE = 10
WC_CLASS_BUILTUP = 50

#: Required output keys — kept stable so consumers can type-check.
OUTPUT_KEYS = ("imperviousness", "tree_overhang")

#: Window size in ESA WorldCover pixels (10 m). Matches the 256×256 chip.
DEFAULT_WINDOW_PX = 256


@dataclass(frozen=True)
class WorldCoverFractions:
    """Per-policy area fractions extracted from one ESA WorldCover window."""

    imperviousness: float   # mean(chip == 50)
    tree_overhang: float    # mean(chip == 10)

    def as_dict(self) -> dict[str, float]:
        return {"imperviousness": self.imperviousness, "tree_overhang": self.tree_overhang}


def fractions_from_chip(wc_chip: np.ndarray) -> WorldCoverFractions:
    """Compute imperviousness + tree_overhang from a WorldCover raster window.

    Parameters
    ----------
    wc_chip:
        2-D ``uint8`` array of ESA WorldCover class codes (10/20/.../100).
        Zero values are treated as no-data and excluded from the denominator
        so a coastline / off-map window doesn't bias both fractions toward 0.

    Returns
    -------
    WorldCoverFractions
        Both fields in ``[0, 1]``. If the chip is entirely no-data (max == 0)
        both fractions are 0 — caller is responsible for masking such rows.
    """
    if wc_chip.ndim != 2:
        raise ValueError(f"wc_chip must be 2-D; got shape {wc_chip.shape}")
    valid = wc_chip > 0
    n_valid = int(valid.sum())
    if n_valid == 0:
        return WorldCoverFractions(imperviousness=0.0, tree_overhang=0.0)
    built = int(((wc_chip == WC_CLASS_BUILTUP) & valid).sum())
    tree = int(((wc_chip == WC_CLASS_TREE) & valid).sum())
    return WorldCoverFractions(
        imperviousness=built / n_valid,
        tree_overhang=tree / n_valid,
    )


def fetch_chip(lat: float, lon: float, year: int = 2021,
               window_px: int = DEFAULT_WINDOW_PX) -> np.ndarray:
    """Read a ``window_px × window_px`` ESA WorldCover window centred on (lat, lon).

    Lazily imports ``pystac_client`` / ``planetary_computer`` / ``rasterio``
    so the rest of the module is importable in test environments without
    geospatial deps. STAC search resolves to one ESA WorldCover scene
    (the 2021 product is a single global mosaic split into 3°×3° tiles).

    The window is read in the asset's native EPSG:4326 grid, which is
    pre-aligned to the same global graticule as Sentinel-2 L2A — pixel
    centres are at ``(n + 0.5) × 1/12000°``, so a 256×256 window covers
    exactly the same ground extent the cached chip pipeline targets
    (modulo the UTM-vs-geographic resampling difference, which is
    sub-pixel at the chip scale).

    Raises
    ------
    RuntimeError
        If no scene intersects the requested coordinate.
    """
    import planetary_computer  # noqa: PLC0415
    import pystac_client  # noqa: PLC0415
    import rasterio  # noqa: PLC0415
    from rasterio.windows import Window  # noqa: PLC0415

    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    delta = 0.01
    items = list(catalog.search(
        collections=["esa-worldcover"],
        bbox=[lon - delta, lat - delta, lon + delta, lat + delta],
        max_items=5,
    ).items())
    # Filter to requested year (ids encode year, e.g. ESA_WorldCover_10m_2021_v200_N27W084)
    items_year = [it for it in items if f"_{year}_" in it.id]
    if not items_year:
        items_year = items
    if not items_year:
        raise RuntimeError(
            f"No ESA WorldCover {year} item intersects ({lat:.4f}, {lon:.4f})."
        )

    item = items_year[0]
    asset = item.assets["map"]
    half = window_px // 2
    with rasterio.open(asset.href) as src:
        py, px = src.index(lon, lat)
        win = Window(col_off=max(px - half, 0), row_off=max(py - half, 0),
                     width=window_px, height=window_px)
        data = src.read(1, window=win)
        # Pad with no-data (0) if the window clips the tile edge.
        if data.shape != (window_px, window_px):
            padded = np.zeros((window_px, window_px), dtype=data.dtype)
            padded[: data.shape[0], : data.shape[1]] = data
            data = padded
        return data.astype(np.uint8, copy=False)


def label_for_policy(lat: float, lon: float) -> WorldCoverFractions:
    """Compute weak labels for one policy by fetching + reducing a WC window."""
    chip = fetch_chip(lat=lat, lon=lon)
    return fractions_from_chip(chip)


def label_for_chip_array(wc_chip: np.ndarray) -> WorldCoverFractions:
    """Alias for ``fractions_from_chip`` — kept for the public API symmetry."""
    return fractions_from_chip(wc_chip)
