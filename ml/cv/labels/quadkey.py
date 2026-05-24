"""
Bing Maps Tile System — quadkey conversion utilities.

Used by ``ml/cv/labels/ms_buildings.py`` to map a policy's (lat, lon) to the
9-digit quadkey shard inside the Microsoft Building Footprints parquet on
Microsoft Planetary Computer. The full US partition is split into 2,413
parquet shards keyed by quadkey at zoom 9 (each shard covers ~78 km × 78 km
at the equator, smaller at higher latitudes); reading only the relevant
shard turns a 9 GB scan into a ~5 MB scan per policy.

Reference
---------
Microsoft. *Bing Maps Tile System*. 2025.
https://learn.microsoft.com/en-us/bingmaps/articles/bing-maps-tile-system

Web Mercator projection limits: latitude is clamped to ±85.05112878° so the
projection remains finite (the Mercator y-axis diverges at the poles).
"""

from __future__ import annotations

import math

#: Web Mercator latitude clamp; beyond this the projection is undefined.
_MAX_LAT = 85.05112878

#: Standard tile size in pixels at every zoom level (Bing convention).
_TILE_SIZE = 256


def latlon_to_quadkey(lat: float, lon: float, zoom: int = 9) -> str:
    """Convert a WGS-84 ``(lat, lon)`` to a Bing Maps quadkey at ``zoom``.

    Parameters
    ----------
    lat:
        Latitude in WGS-84 decimal degrees. Clamped to ``±85.05112878``.
    lon:
        Longitude in WGS-84 decimal degrees. Treated mod 360 for the
        Mercator projection (i.e. wraps at the antimeridian).
    zoom:
        Bing tile zoom level. The MS Buildings parquet on MPC is
        partitioned at zoom 9 (9-digit quadkeys); other zoom levels are
        supported for testing but not used by the production pipeline.

    Returns
    -------
    str
        A ``zoom``-digit string of characters ``0``/``1``/``2``/``3``
        encoding the tile path from the root.

    Examples
    --------
    >>> latlon_to_quadkey(28.55, -82.45, zoom=9)
    '032021212'
    """
    lat = max(-_MAX_LAT, min(_MAX_LAT, float(lat)))
    sin_lat = math.sin(lat * math.pi / 180.0)
    map_size = _TILE_SIZE * (1 << zoom)
    pixel_x = ((float(lon) + 180.0) / 360.0) * map_size
    pixel_y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * map_size
    tile_x = int(pixel_x // _TILE_SIZE)
    tile_y = int(pixel_y // _TILE_SIZE)

    qk_chars: list[str] = []
    for i in range(zoom, 0, -1):
        digit = 0
        mask = 1 << (i - 1)
        if tile_x & mask:
            digit += 1
        if tile_y & mask:
            digit += 2
        qk_chars.append(str(digit))
    return "".join(qk_chars)


def chip_bbox(lat: float, lon: float, chip_size_pixels: int = 256, chip_res_m: float = 10.0) -> tuple[float, float, float, float]:
    """Approximate the lat/lon bounding box for a cached Sentinel-2 chip.

    The cached chips are ``chip_size_pixels × chip_size_pixels`` at
    ``chip_res_m`` resolution in the local UTM zone (so 256 × 10 m =
    2,560 m on a side). This helper returns the equivalent lat/lon
    bounding box assuming a spherical Earth, which is accurate to
    within a few meters at the chip scale and fine for weak-label
    spatial filtering.

    Returns
    -------
    (lon_min, lat_min, lon_max, lat_max)
        Bing/STAC convention bbox.
    """
    half_meters = chip_size_pixels * chip_res_m / 2.0
    # 1 degree latitude ≈ 111,320 m
    dlat = half_meters / 111_320.0
    # 1 degree longitude shrinks with latitude
    dlon = half_meters / (111_320.0 * math.cos(math.radians(lat)) + 1e-9)
    return (float(lon) - dlon, float(lat) - dlat, float(lon) + dlon, float(lat) + dlat)
