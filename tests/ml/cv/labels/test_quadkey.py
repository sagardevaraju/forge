"""Tests for ``ml.cv.labels.quadkey`` — Bing tile-system conversion."""

from __future__ import annotations

import math

import pytest

from ml.cv.labels.quadkey import chip_bbox, latlon_to_quadkey


class TestLatlonToQuadkey:
    """End-to-end verification against published Microsoft examples."""

    def test_fl_hernando_zoom_9(self):
        """FL Hernando 28.55,-82.45 → 032021212 (verified against shard listing)."""
        assert latlon_to_quadkey(28.55, -82.45, zoom=9) == "032021212"

    def test_origin_zoom_3(self):
        """Equator/prime-meridian falls in the first tile of the SE quadrant.

        Microsoft's reference doc shows the SE quadrant root digit is 3, then
        each child of the SE corner inherits 0. At z=3 the equator/0° tile
        index works out to ``300``.
        """
        assert latlon_to_quadkey(0.0, 0.0, zoom=3) == "300"

    def test_clamp_to_mercator_limit(self):
        """Latitudes beyond ±85.05 are clamped (Mercator projection limit)."""
        a = latlon_to_quadkey(90.0, 0.0, zoom=5)
        b = latlon_to_quadkey(89.0, 0.0, zoom=5)
        assert a == b  # both clamped to MAX_LAT

    def test_quadkey_length_equals_zoom(self):
        """A z=N quadkey is always exactly N digits."""
        for z in (1, 5, 9, 15):
            qk = latlon_to_quadkey(40.7128, -74.0060, zoom=z)
            assert len(qk) == z
            assert set(qk).issubset({"0", "1", "2", "3"})

    def test_determinism(self):
        """Same inputs always produce the same quadkey."""
        a = latlon_to_quadkey(40.7128, -74.0060, zoom=9)
        b = latlon_to_quadkey(40.7128, -74.0060, zoom=9)
        assert a == b

    def test_distinct_geographies_distinct_quadkeys(self):
        """Two cities ~1000 km apart land in different zoom-9 tiles."""
        fl = latlon_to_quadkey(28.55, -82.45, zoom=9)   # FL Hernando
        nc = latlon_to_quadkey(35.55, -82.55, zoom=9)   # NC mountain
        assert fl != nc


class TestChipBbox:
    """The chip_bbox helper approximates the cached 256×10 m chip extent."""

    def test_default_half_extent_about_1_3_km(self):
        """256 × 10 m / 2 = 1280 m on each side — confirm via lat conversion."""
        lon_min, lat_min, lon_max, lat_max = chip_bbox(0.0, 0.0)
        # at the equator: 1° lat ≈ 111.32 km
        half_lat_m = (lat_max - lat_min) / 2 * 111_320.0
        half_lon_m = (lon_max - lon_min) / 2 * 111_320.0
        # half of 256*10 = 1280 m
        assert math.isclose(half_lat_m, 1280.0, rel_tol=1e-3)
        assert math.isclose(half_lon_m, 1280.0, rel_tol=1e-3)

    def test_lon_shrinks_with_latitude(self):
        """Longitudinal extent must shrink by cos(lat) at higher latitudes."""
        _, _, lon_max_eq, _ = chip_bbox(0.0, 0.0)
        _, _, lon_max_60, _ = chip_bbox(60.0, 0.0)
        # cos(60°) = 0.5, so the lon delta should roughly double in degrees
        delta_eq = lon_max_eq
        delta_60 = lon_max_60
        assert delta_60 > delta_eq * 1.9
        assert delta_60 < delta_eq * 2.1

    def test_returns_lon_min_lat_min_lon_max_lat_max(self):
        """Bing/STAC bbox convention: (lon_min, lat_min, lon_max, lat_max)."""
        bbox = chip_bbox(28.55, -82.45)
        lon_min, lat_min, lon_max, lat_max = bbox
        assert lon_min < lon_max
        assert lat_min < lat_max
        # Center recovers
        assert math.isclose((lon_min + lon_max) / 2, -82.45, abs_tol=1e-9)
        assert math.isclose((lat_min + lat_max) / 2, 28.55, abs_tol=1e-9)
