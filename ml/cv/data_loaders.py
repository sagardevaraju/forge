"""
Sentinel-2 data loader for the FORGE property-risk CV pipeline.

Data source: Microsoft Planetary Computer — Sentinel-2 Level-2A collection
(``sentinel-2-l2a``). Public STAC catalog; no API key required for reads.
https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a

Modes
-----
real   Fetch a live 256×256 chip from Planetary Computer (requires
       ``planetary-computer``, ``pystac-client``, ``rasterio``, ``rioxarray``).
mock   Return a deterministic synthetic chip derived from the coordinate seed.
       No network I/O; safe for CI and downstream-task development.

The active mode is controlled by the environment variable ``FORGE_CV_MODE``
(case-insensitive).  If the variable is absent or set to ``mock`` the module
defaults to mock mode.  Set it to ``real`` to hit the live catalog.
"""

from __future__ import annotations

import os
from typing import List, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Sentinel-2 bands fetched by default (10 m and 20 m native resolution).
#: B04=Red  B03=Green  B02=Blue  B08=NIR  B11=SWIR-1
DEFAULT_BANDS: List[str] = ["B04", "B03", "B02", "B08", "B11"]

#: Output chip spatial size (pixels).
CHIP_SIZE: int = 256

#: Sentinel-2 L2A reflectance scale max (values are integer * 1e-4).
_S2_MAX: int = 10_000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_from_latlon(lat: float, lon: float) -> int:
    """Derive a deterministic integer seed from a (lat, lon) pair.

    The seed is built from the IEEE-754 bit patterns of both floats so that
    *any* unique coordinate pair produces a unique seed, even pairs that share
    one component.
    """
    lat_bits = int(np.float64(lat).view(np.uint64))
    lon_bits = int(np.float64(lon).view(np.uint64))
    # XOR with a large prime shift to break symmetry when lat == lon
    return (lat_bits ^ (lon_bits * 6_364_136_223_846_793_005)) & 0xFFFF_FFFF_FFFF_FFFF


# ---------------------------------------------------------------------------
# Mock path (no network)
# ---------------------------------------------------------------------------


def mock_chip(
    lat: float,
    lon: float,
    seed: int | None = None,
    bands: Sequence[str] = DEFAULT_BANDS,
) -> np.ndarray:
    """Return a deterministic synthetic Sentinel-2 chip.

    Parameters
    ----------
    lat:
        Latitude of the property centroid (WGS-84 decimal degrees).
    lon:
        Longitude of the property centroid (WGS-84 decimal degrees).
    seed:
        Override the auto-derived seed.  Mostly useful for testing.
    bands:
        Band identifiers to include (controls the leading channel count).

    Returns
    -------
    np.ndarray
        Array of shape ``(len(bands), CHIP_SIZE, CHIP_SIZE)`` with dtype
        ``uint16`` and values in ``[0, 10 000]``, matching Sentinel-2 L2A
        scaled surface reflectance.
    """
    if seed is None:
        seed = _seed_from_latlon(lat, lon)

    rng = np.random.default_rng(seed)
    chip = rng.integers(0, _S2_MAX + 1, size=(len(bands), CHIP_SIZE, CHIP_SIZE), dtype=np.uint16)
    return chip


# ---------------------------------------------------------------------------
# Real path (Planetary Computer — imported lazily)
# ---------------------------------------------------------------------------


def fetch_chip(
    lat: float,
    lon: float,
    bands: Sequence[str] = DEFAULT_BANDS,
) -> np.ndarray:
    """Fetch a 256×256 Sentinel-2 L2A chip from Microsoft Planetary Computer.

    Retrieves the most recent scene with cloud cover < 10 % that intersects the
    supplied coordinate, signs the asset URLs via ``planetary_computer``, then
    reads a ``CHIP_SIZE × CHIP_SIZE`` pixel window centred on the point using
    ``rasterio``.

    Data source
    -----------
    Microsoft Planetary Computer — ``sentinel-2-l2a`` STAC collection.
    https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a
    No authentication required for public catalog reads.

    Parameters
    ----------
    lat:
        Latitude of the property centroid (WGS-84 decimal degrees).
    lon:
        Longitude of the property centroid (WGS-84 decimal degrees).
    bands:
        Sentinel-2 band identifiers to fetch (e.g. ``["B04", "B03", "B02",
        "B08", "B11"]``).

    Returns
    -------
    np.ndarray
        Array of shape ``(len(bands), CHIP_SIZE, CHIP_SIZE)`` with dtype
        ``uint16``.

    Raises
    ------
    RuntimeError
        If no suitable scene is found within the search window.
    """
    # Lazy imports — only required for real-mode fetches.
    import planetary_computer  # noqa: PLC0415
    import pystac_client  # noqa: PLC0415
    import rasterio  # noqa: PLC0415
    from rasterio.windows import Window  # noqa: PLC0415

    # -----------------------------------------------------------------------
    # 1. Open the public Planetary Computer STAC catalog.
    # -----------------------------------------------------------------------
    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )

    # -----------------------------------------------------------------------
    # 2. Build a small bounding box (~0.02° ≈ 2 km at mid-latitudes) and
    #    search for the most recent cloud-free scene.
    # -----------------------------------------------------------------------
    delta = 0.01  # degrees
    bbox = [lon - delta, lat - delta, lon + delta, lat + delta]

    search = catalog.search(
        collections=["sentinel-2-l2a"],
        bbox=bbox,
        query={"eo:cloud_cover": {"lt": 10}},
        sortby=[{"field": "datetime", "direction": "desc"}],
        max_items=1,
    )

    items = list(search.items())
    if not items:
        raise RuntimeError(
            f"No Sentinel-2 L2A scene with cloud cover < 10 % found near "
            f"({lat:.4f}, {lon:.4f}).  Widen the search or relax the cloud "
            f"threshold."
        )

    item = items[0]

    # -----------------------------------------------------------------------
    # 3. Read a CHIP_SIZE × CHIP_SIZE window for each requested band.
    # -----------------------------------------------------------------------
    half = CHIP_SIZE // 2
    chips: list[np.ndarray] = []

    for band in bands:
        asset_href = item.assets[band].href
        with rasterio.open(asset_href) as src:
            # Convert geographic coordinates to pixel row/col in this scene.
            py, px = src.index(lon, lat)
            window = Window(
                col_off=max(px - half, 0),
                row_off=max(py - half, 0),
                width=CHIP_SIZE,
                height=CHIP_SIZE,
            )
            data = src.read(1, window=window)

            # Pad to CHIP_SIZE if the window clips the image edge.
            if data.shape != (CHIP_SIZE, CHIP_SIZE):
                padded = np.zeros((CHIP_SIZE, CHIP_SIZE), dtype=data.dtype)
                padded[: data.shape[0], : data.shape[1]] = data
                data = padded

        chips.append(data)

    return np.stack(chips, axis=0).astype(np.uint16)


# ---------------------------------------------------------------------------
# Unified entry point
# ---------------------------------------------------------------------------


def load_chip(
    lat: float,
    lon: float,
    mode: str | None = None,
    bands: Sequence[str] = DEFAULT_BANDS,
    seed: int | None = None,
) -> np.ndarray:
    """Load a Sentinel-2 chip for the given location.

    Dispatches to either :func:`fetch_chip` (real Planetary Computer data) or
    :func:`mock_chip` (deterministic synthetic data) based on *mode*.

    Parameters
    ----------
    lat:
        Latitude of the property centroid (WGS-84 decimal degrees).
    lon:
        Longitude of the property centroid (WGS-84 decimal degrees).
    mode:
        ``"real"`` or ``"mock"``.  If *None* (the default), the value of the
        environment variable ``FORGE_CV_MODE`` is used.  When the variable is
        absent or set to ``"mock"`` (case-insensitive), mock mode is active.
    bands:
        Band identifiers to include.
    seed:
        Seed override forwarded to :func:`mock_chip` (ignored in real mode).

    Returns
    -------
    np.ndarray
        Array of shape ``(len(bands), 256, 256)``, dtype ``uint16``.
    """
    if mode is None:
        env = os.environ.get("FORGE_CV_MODE", "mock").strip().lower()
        mode = env if env in {"real", "mock"} else "mock"

    if mode == "real":
        return fetch_chip(lat=lat, lon=lon, bands=bands)
    else:
        return mock_chip(lat=lat, lon=lon, seed=seed, bands=bands)
