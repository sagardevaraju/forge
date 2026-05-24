"""HAZUS curve tests.

The AUDIT.2 pass added page-level citations to ``ml/xgb/hazus_curves.py``
docstring. These tests pin the anchor points cited in the docstring so
a future edit can't silently drift the numeric surface away from the
HAZUS-MH 5.1 Hurricane / Flood Technical Manual values.
"""
from ml.xgb.hazus_curves import wind_damage_ratio, surge_damage_ratio


# ── Original behavior tests ────────────────────────────────────────────────


def test_wind_below_threshold_zero():
    assert wind_damage_ratio(75, "wood_frame") == 0.0


def test_wind_manufactured_more_vulnerable_than_masonry():
    assert wind_damage_ratio(110, "manufactured") > wind_damage_ratio(110, "masonry")


def test_wind_monotonic_in_speed():
    speeds = [80, 100, 120, 140, 160, 180]
    ratios = [wind_damage_ratio(s, "wood_frame") for s in speeds]
    assert ratios == sorted(ratios)


def test_surge_zero_when_below_elevation():
    assert surge_damage_ratio(1.0, elevation_m=2.0) == 0.0


def test_surge_caps_at_high_water():
    assert surge_damage_ratio(10.0, elevation_m=0.0) > 0.9


# ── AUDIT.2 — pin HAZUS-MH citation anchors ───────────────────────────────


class TestHazusWindAnchors:
    """Pin the values the docstring cites against HAZUS-MH 5.1 Hurricane
    Technical Manual Tables 6.4-1 / 6.4-2 / 6.4-7 at the Saffir-Simpson
    category boundaries. Drift here means either the source moved or
    someone edited the table without updating the citation."""

    def test_wood_frame_cat2_anchor_5pct(self):
        """research.md §9c records wood-frame ≈ 5% at 110 mph (Cat-2)."""
        assert wind_damage_ratio(110, "wood_frame") == 0.05

    def test_masonry_cat2_anchor_2pct(self):
        """research.md §9c records masonry ≈ 2% at 110 mph (Cat-2)."""
        assert wind_damage_ratio(110, "masonry") == 0.02

    def test_manufactured_cat2_anchor_45pct(self):
        """Manufactured housing curve runs steeper — 45% at 110 mph
        per HAZUS-MH 5.1 Table 6.4-7."""
        assert wind_damage_ratio(110, "manufactured") == 0.45

    def test_wood_frame_cat5_anchor_85pct(self):
        """180 mph anchor = HAZUS deep-tail Cat-5 residential wood frame."""
        assert wind_damage_ratio(180, "wood_frame") == 0.85

    def test_manufactured_more_vulnerable_at_every_anchor(self):
        """Manufactured housing must be > wood frame at every Saffir-Simpson
        category boundary — invariant of the HAZUS curves."""
        for speed in (110, 130, 155):
            assert wind_damage_ratio(speed, "manufactured") > wind_damage_ratio(
                speed, "wood_frame"
            ), f"manufactured ≤ wood_frame at {speed} mph"


class TestHazusSurgeAnchors:
    """Pin the depth-damage anchor values cited against HAZUS-MH 5.1
    Flood Technical Manual Section 9 Table 9.5."""

    def test_one_foot_above_floor_10pct(self):
        """0.3 m ≈ 1 ft above finished floor → 10% damage per HAZUS Table 9.5."""
        assert surge_damage_ratio(0.3, elevation_m=0.0) == 0.10

    def test_three_feet_above_floor_35pct(self):
        """1.0 m ≈ 3 ft above finished floor → 35% damage."""
        assert surge_damage_ratio(1.0, elevation_m=0.0) == 0.35

    def test_six_feet_above_floor_65pct(self):
        """2.0 m ≈ 6 ft above finished floor → 65% damage."""
        assert surge_damage_ratio(2.0, elevation_m=0.0) == 0.65

    def test_above_thirteen_feet_caps_at_95pct(self):
        """The curve saturates at 0.95 (deep tail / first-floor total loss).
        HAZUS does not run residential single-family curves above this
        on the assumption that contents loss + structural settling are
        already at or near max."""
        assert surge_damage_ratio(4.0, elevation_m=0.0) == 0.95
        # Beyond 4 m the np.interp extrapolation stays at the last value.
        assert surge_damage_ratio(10.0, elevation_m=0.0) == 0.95

    def test_elevation_offset_lifts_floor(self):
        """An elevated structure (e.g., pile foundation) shifts the
        damage curve right by the elevation. A 2 m surge against a 1.5 m
        elevation = 0.5 m above floor → interpolates between (0.3, 0.10)
        and (1.0, 0.35) → ≈ 0.171."""
        result = surge_damage_ratio(2.0, elevation_m=1.5)
        # Linear interp: 0.10 + ((0.5 - 0.3) / (1.0 - 0.3)) × (0.35 - 0.10)
        # = 0.10 + (0.2 / 0.7) × 0.25 ≈ 0.1714
        assert abs(result - 0.1714) < 0.001
