"""Tests for ``ml.cv.labels.ms_buildings`` — roof-complexity weak labels.

Network (Azure parquet) is mocked through the shard cache. The shapely +
Polsby-Popper math runs against deterministic synthetic polygons.
"""

from __future__ import annotations

import math

import pytest
import shapely.affinity as sa
import shapely.geometry as sg

from ml.cv.labels.ms_buildings import (
    MAX_BUILDINGS_PER_CHIP,
    RoofComplexity,
    polsby_popper,
    reduce_geometries,
    reduce_with_index,
)


class TestPolsbyPopper:

    def test_perfect_circle_equals_one(self):
        # Discretized circle (regular 64-gon) — should land very close to 1.0
        circle = sg.Point(0, 0).buffer(1.0, quad_segs=16)
        pp = polsby_popper(circle.area, circle.length)
        assert pp == pytest.approx(1.0, abs=0.01)

    def test_unit_square_is_pi_over_4(self):
        """A square has PP = 4π·1 / 16 = π/4 ≈ 0.7854 (closed form)."""
        sq = sg.box(0, 0, 1, 1)
        pp = polsby_popper(sq.area, sq.length)
        assert pp == pytest.approx(math.pi / 4.0, abs=1e-6)

    def test_long_thin_rect_close_to_zero(self):
        """10 × 0.1 rect: PP = 4π · 1 / (20.2)² ≈ 0.0308."""
        rect = sg.box(0, 0, 10, 0.1)
        pp = polsby_popper(rect.area, rect.length)
        assert pp == pytest.approx(0.0308, abs=0.001)

    def test_degenerate_zero_perimeter_returns_zero(self):
        """No-perimeter input is treated as PP = 0, not NaN/inf."""
        assert polsby_popper(area=0.0, perimeter=0.0) == 0.0

    def test_capped_at_one(self):
        """Numerical noise may push PP slightly above 1; guard returns 1.0."""
        # Manufacture a "circle-too-good": PP = 4π·1 / (4π·0.99)² > 1
        a = 1.0
        p = math.sqrt(4 * math.pi * a) * 0.99  # smaller P than feasible
        pp = polsby_popper(a, p)
        assert pp == 1.0


class TestReduceGeometries:

    @staticmethod
    def _box_at(cx: float, cy: float, size: float = 0.0001) -> sg.Polygon:
        return sg.box(cx - size, cy - size, cx + size, cy + size)

    def test_empty_input_returns_zero(self):
        out = reduce_geometries([], chip_bbox=(0, 0, 1, 1))
        assert out.value == 0.0
        assert out.n_buildings == 0
        assert out.n_geometries_scanned == 0

    def test_buildings_outside_bbox_ignored(self):
        # All three squares are perfect (PP = π/4 ≈ 0.785) but outside the
        # chip bbox — result must be 0, not 1 - 0.785.
        geoms = [self._box_at(10, 10), self._box_at(-5, -5), self._box_at(0.5, 0.5)]
        out = reduce_geometries(geoms, chip_bbox=(2, 2, 4, 4))
        assert out.value == 0.0
        assert out.n_buildings == 0

    def test_all_squares_give_one_minus_pi_over_4(self):
        # 5 unit-ish squares all centred inside the bbox → mean PP = π/4 →
        # roof_complexity = 1 - π/4 ≈ 0.2146.
        geoms = [self._box_at(cx, 0.5) for cx in (0.1, 0.3, 0.5, 0.7, 0.9)]
        out = reduce_geometries(geoms, chip_bbox=(0, 0, 1, 1))
        assert out.value == pytest.approx(1.0 - math.pi / 4.0, abs=1e-6)
        assert out.n_buildings == 5

    def test_jagged_polygon_pushes_value_up(self):
        """Adding a jagged H-shape raises the mean roof_complexity."""
        h_shape = sg.Polygon([
            (0, 0), (1, 0), (1, 0.4), (2, 0.4), (2, 0), (3, 0),
            (3, 1), (2, 1), (2, 0.6), (1, 0.6), (1, 1), (0, 1),
        ])
        h_shape = sa.translate(h_shape, xoff=0, yoff=0)  # centred at (1.5, 0.5)
        sq = sg.box(0, 2, 1, 3)  # centred at (0.5, 2.5)
        out = reduce_geometries([h_shape, sq], chip_bbox=(-1, -1, 4, 4))
        # H is much less compact than square → roof_complexity > 1 - π/4
        sq_only = reduce_geometries([sq], chip_bbox=(-1, -1, 4, 4))
        assert out.value > sq_only.value

    def test_max_buildings_cap(self):
        """``MAX_BUILDINGS_PER_CHIP`` short-circuits pathological dense shards."""
        # 10 × MAX squares, all inside bbox
        n = MAX_BUILDINGS_PER_CHIP + 10
        geoms = [self._box_at(0.5, 0.5, size=1e-6) for _ in range(n)]
        out = reduce_geometries(geoms, chip_bbox=(0, 0, 1, 1))
        # Count is capped; scanned reflects the early break.
        assert out.n_buildings == MAX_BUILDINGS_PER_CHIP


class TestReduceWithIndex:
    """``reduce_with_index`` must agree with ``reduce_geometries`` for the
    same input set — the STRtree is a prefilter, not a behaviour change."""

    @staticmethod
    def _setup(geoms, bbox):
        from shapely.strtree import STRtree
        tree = STRtree(list(geoms))
        return reduce_with_index(tuple(geoms), tree, bbox), reduce_geometries(geoms, bbox)

    def test_matches_naive_on_squares(self):
        geoms = [sg.box(cx, 0.5, cx + 0.01, 0.5 + 0.01) for cx in (0.1, 0.3, 0.5, 0.7, 0.9)]
        with_idx, naive = self._setup(geoms, (0, 0, 1, 1))
        assert with_idx.value == naive.value
        assert with_idx.n_buildings == naive.n_buildings

    def test_matches_naive_on_empty(self):
        with_idx, naive = self._setup([], (0, 0, 1, 1))
        assert with_idx.value == naive.value == 0.0

    def test_matches_naive_outside_bbox(self):
        geoms = [sg.box(10, 10, 10.01, 10.01), sg.box(-5, -5, -4.99, -4.99)]
        with_idx, naive = self._setup(geoms, (0, 0, 1, 1))
        assert with_idx.n_buildings == naive.n_buildings == 0


class TestRoofComplexityDataclass:

    def test_frozen(self):
        rc = RoofComplexity(value=0.3, n_buildings=10, n_geometries_scanned=50)
        with pytest.raises(Exception):
            rc.value = 0.5  # type: ignore[misc]

    def test_as_dict_keys(self):
        rc = RoofComplexity(value=0.3, n_buildings=10, n_geometries_scanned=50)
        d = rc.as_dict()
        assert d == {
            "roof_complexity": 0.3,
            "n_buildings_in_chip": 10,
            "n_geometries_scanned": 50,
        }


# ---------------------------------------------------------------------------
# Network-touching paths are mocked
# ---------------------------------------------------------------------------


class TestLabelForPolicyMocked:
    """``label_for_policy`` reads a shard through ``load_shard_geometries``.

    We monkeypatch the cached shard reader to return synthetic polygons so
    no Azure I/O happens during the test.
    """

    def test_label_for_policy_uses_quadkey(self, monkeypatch):
        # Verify the function looks up the correct quadkey shard for FL Hernando.
        from ml.cv.labels import ms_buildings
        from ml.cv.labels.quadkey import latlon_to_quadkey

        seen_quadkeys: list[str] = []

        def fake_loader(qk: str):
            seen_quadkeys.append(qk)
            return (sg.box(-82.45 - 0.001, 28.55 - 0.001, -82.45 + 0.001, 28.55 + 0.001),)

        monkeypatch.setattr(ms_buildings, "load_shard_geometries", fake_loader)

        out = ms_buildings.label_for_policy(28.55, -82.45)
        # Square box → PP = π/4 → roof_complexity = 1 - π/4
        assert out.value == pytest.approx(1.0 - math.pi / 4.0, abs=1e-6)
        assert out.n_buildings == 1
        assert seen_quadkeys == [latlon_to_quadkey(28.55, -82.45, zoom=9)]
