"""Tests for ``ml.cv.labels.esa_worldcover`` — ESA WorldCover weak labels.

Network is mocked; the actual MPC fetch path is exercised only by the
precompute script and the integration smoke test (run manually with a
network connection).
"""

from __future__ import annotations

import numpy as np
import pytest

from ml.cv.labels.esa_worldcover import (
    OUTPUT_KEYS,
    WC_CLASS_BUILTUP,
    WC_CLASS_TREE,
    WorldCoverFractions,
    _scene_id_for,
    fractions_from_chip,
    label_for_chip_array,
)


# ---------------------------------------------------------------------------
# Helpers — build a synthetic WC chip with known class fractions
# ---------------------------------------------------------------------------


def synth_chip(builtup_frac: float, tree_frac: float, size: int = 256) -> np.ndarray:
    """Build a deterministic WC chip with the specified class fractions.

    Layout: top ``builtup_frac × size`` rows = class 50; next
    ``tree_frac × size`` rows = class 10; remainder = class 30 (grassland).
    """
    chip = np.full((size, size), 30, dtype=np.uint8)
    n_built = int(builtup_frac * size)
    n_tree = int(tree_frac * size)
    chip[:n_built, :] = WC_CLASS_BUILTUP
    chip[n_built : n_built + n_tree, :] = WC_CLASS_TREE
    return chip


class TestFractionsFromChip:

    def test_keys_are_stable(self):
        """``OUTPUT_KEYS`` exposed for type-checking the dict shape."""
        assert OUTPUT_KEYS == ("imperviousness", "tree_overhang")

    def test_all_builtup_gives_imperviousness_1(self):
        chip = np.full((256, 256), WC_CLASS_BUILTUP, dtype=np.uint8)
        out = fractions_from_chip(chip)
        assert out.imperviousness == pytest.approx(1.0)
        assert out.tree_overhang == pytest.approx(0.0)

    def test_all_tree_gives_tree_overhang_1(self):
        chip = np.full((256, 256), WC_CLASS_TREE, dtype=np.uint8)
        out = fractions_from_chip(chip)
        assert out.imperviousness == pytest.approx(0.0)
        assert out.tree_overhang == pytest.approx(1.0)

    def test_mixed_fractions_recoverable(self):
        """Construct 30% built, 50% tree, 20% grass → fractions match."""
        chip = synth_chip(builtup_frac=0.30, tree_frac=0.50)
        out = fractions_from_chip(chip)
        # Allow tiny rounding from int() truncation in synth_chip.
        assert out.imperviousness == pytest.approx(0.30, abs=0.005)
        assert out.tree_overhang == pytest.approx(0.50, abs=0.005)

    def test_no_data_window_returns_zeros_not_nan(self):
        """An entirely no-data (class==0) chip yields zeros, not NaN."""
        chip = np.zeros((256, 256), dtype=np.uint8)
        out = fractions_from_chip(chip)
        assert out.imperviousness == 0.0
        assert out.tree_overhang == 0.0

    def test_partial_no_data_excluded_from_denominator(self):
        """Half-no-data chip with 50% built in the valid half → impervious = 0.5."""
        chip = np.zeros((256, 256), dtype=np.uint8)
        chip[:128, :128] = WC_CLASS_BUILTUP   # 25 % of pixels
        chip[:128, 128:] = 30                  # 25 % grass (valid)
        # Built is 25% of all pixels, but 50% of *valid* pixels.
        out = fractions_from_chip(chip)
        assert out.imperviousness == pytest.approx(0.5, abs=0.01)

    def test_one_d_input_rejected(self):
        with pytest.raises(ValueError, match="2-D"):
            fractions_from_chip(np.zeros(10, dtype=np.uint8))

    def test_output_clamped_to_unit_interval(self):
        """Fractions are mathematically bounded; test bounds explicitly."""
        chip = synth_chip(builtup_frac=0.5, tree_frac=0.5)
        out = fractions_from_chip(chip)
        for v in (out.imperviousness, out.tree_overhang):
            assert 0.0 <= v <= 1.0


class TestWorldCoverFractionsDataclass:

    def test_as_dict_matches_output_keys(self):
        wcf = WorldCoverFractions(imperviousness=0.4, tree_overhang=0.6)
        d = wcf.as_dict()
        assert set(d.keys()) == set(OUTPUT_KEYS)
        assert d["imperviousness"] == 0.4
        assert d["tree_overhang"] == 0.6

    def test_frozen(self):
        """``WorldCoverFractions`` is frozen — mutation is rejected."""
        wcf = WorldCoverFractions(imperviousness=0.4, tree_overhang=0.6)
        with pytest.raises(Exception):  # FrozenInstanceError or AttributeError
            wcf.imperviousness = 0.0  # type: ignore[misc]


class TestLabelForChipArray:
    """The public alias should round-trip identically."""

    def test_alias_returns_same_values(self):
        chip = synth_chip(0.2, 0.6)
        a = fractions_from_chip(chip)
        b = label_for_chip_array(chip)
        assert a == b


class TestSceneIdFor:
    """ESA WC tile id encodes the SW corner of the 3°×3° tile.

    Verified empirically — MPC STAC search for the point (28.55, -82.45)
    returns the item ``ESA_WorldCover_10m_2021_v200_N27W084``, so the tile
    "N27W084" covers latitudes [27°, 30°] (not [24°, 27°]) and longitudes
    [-84°, -81°] (with W084 being the western edge).
    """

    def test_fl_hernando_resolves_n27w084(self):
        assert _scene_id_for(28.55, -82.45) == "N27W084"

    def test_nc_mountain_resolves_n33w084(self):
        # Asheville, NC ~ 35.5°N -82.5°W → tile spanning [33°, 36°] × [-84°, -81°]
        assert _scene_id_for(35.5, -82.5) == "N33W084"

    def test_southern_hemisphere(self):
        # Sydney, Australia ~ -33.87°S 151.21°E → tile [-36°, -33°] × [150°, 153°]
        assert _scene_id_for(-33.87, 151.21) == "S36E150"

    def test_negative_longitude_at_three_degree_boundary(self):
        # Right at -82° longitude, west of -82 ≡ tile W084.
        assert _scene_id_for(28.5, -82.0) == "N27W084"
        # A pinch east of -81° puts us in the next tile east.
        assert _scene_id_for(28.5, -80.99) == "N27W081"

    def test_zoom_invariant_to_lat_within_band(self):
        # Lats 27.0 and 29.999 should both land in N27W084 (band [27, 30]).
        assert _scene_id_for(27.0, -82.45) == "N27W084"
        assert _scene_id_for(29.999, -82.45) == "N27W084"
        # Lat 30.0 crosses into the next tile north.
        assert _scene_id_for(30.0, -82.45) == "N30W084"
