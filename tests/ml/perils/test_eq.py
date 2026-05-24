"""Task P3.16 — Earthquake peril Monte-Carlo generator.

Generates epicenter + Mw + MMI-VI footprint scenarios calibrated against
the Gutenberg-Richter recurrence relation (regional b ≈ 1.0) and the
Bakun-Wentworth (1997) MMI attenuation. Damage uses the canonical
``earthquake`` PERIL_SCALES / _HAZUS_MATRIX curves (mirror invariant).
"""

from __future__ import annotations

import math

import pytest

from ml.perils import get_peril, registered_perils
from ml.perils.eq import EQPeril


def test_eq_peril_registered():
    assert "earthquake" in registered_perils()
    assert isinstance(get_peril("earthquake"), EQPeril)


def test_eq_peril_id():
    assert EQPeril.peril_id == "earthquake"


def test_eq_generate_returns_n_scenarios():
    scs = EQPeril().generate_scenarios("EQ_2026_03_14", n=100)
    assert len(scs) == 100


def test_eq_scenarios_carry_required_keys():
    scs = EQPeril().generate_scenarios("EQ_2026_03_14", n=30)
    for s in scs:
        assert s["kind"] == "earthquake"
        assert "id" in s
        assert "prob" in s
        assert s["peril"] == "earthquake"
        # Continuous Mw — feeds PERIL_SCALES.earthquake.multiplier.
        assert isinstance(s["severity"], (int, float))
        # Bakun-Wentworth zero-crossing for MMI VI is Mw ≈ 5.53 — anything
        # below would produce 0 damage and is excluded from the draw.
        assert 5.53 <= s["severity"] <= 8.0
        # Epicenter point + circular MMI-VI footprint.
        assert "epicenter" in s
        assert "lat" in s["epicenter"] and "lon" in s["epicenter"]
        assert s["geometry"]["type"] == "Polygon"
        ring = s["geometry"]["coordinates"][0]
        assert len(ring) >= 4
        assert ring[0] == ring[-1]
        # MMI radii table (VI, VII, VIII).
        assert "mmi_radii_km" in s
        assert "6" in s["mmi_radii_km"]
        assert s["mmi_radii_km"]["6"] > 0


def test_eq_probabilities_sum_to_one():
    scs = EQPeril().generate_scenarios("EQ_2026_03_14", n=37)
    total = sum(s["prob"] for s in scs)
    assert abs(total - 1.0) < 1e-6


def test_eq_deterministic_under_same_id():
    a = EQPeril().generate_scenarios("EQ_TEST", n=20)
    b = EQPeril().generate_scenarios("EQ_TEST", n=20)
    for x, y in zip(a, b):
        assert x["severity"] == y["severity"]
        assert x["epicenter"] == y["epicenter"]


def test_eq_distinct_ids_diverge():
    a = EQPeril().generate_scenarios("EQ_A", n=20)
    b = EQPeril().generate_scenarios("EQ_B", n=20)
    different = sum(1 for x, y in zip(a, b) if x["severity"] != y["severity"])
    assert different > 0


def test_eq_magnitude_distribution_gutenberg_richter():
    """Gutenberg-Richter with b ≈ 1.0 implies each +1.0 magnitude step
    drops event frequency by ~10×. With Mw lower bound 5.53 and a draw
    of 2000 events:
      - count(5.53 ≤ Mw < 6.5)  ≈ 90 % of draws (the GR floor band)
      - count(6.5 ≤ Mw < 7.5)   ≈ 9 %
      - count(Mw ≥ 7.5)          ≈ 1 %
    Tolerances are loose (±5 % absolute for the floor band, < 5 % for
    the top tail) since this is a single Monte-Carlo draw."""
    scs = EQPeril().generate_scenarios("EQ_GR_TEST", n=2000)
    n = len(scs)
    floor = sum(1 for s in scs if s["severity"] < 6.5)
    mid = sum(1 for s in scs if 6.5 <= s["severity"] < 7.5)
    tail = sum(1 for s in scs if s["severity"] >= 7.5)
    assert floor / n > 0.80
    assert mid / n > 0.04
    assert tail / n < 0.05


def test_eq_loss_compute_uses_earthquake_curves():
    """Mirror invariant: scenario damage matches hand-built EQ footprint."""
    from api_py.sim_loss import _damage_ratio

    scs = EQPeril().generate_scenarios("EQ_TEST", n=80)
    s = scs[0]
    dr = _damage_ratio(s["peril"], "wood_frame", s["severity"])
    # multiplier(Mw) = 1.0 + 0.45 · (Mw − 7.0); wood_frame_base = 0.35
    expected = 0.35 * (1.0 + 0.45 * (s["severity"] - 7.0))
    expected = max(0.0, min(1.0, expected))
    assert abs(dr - expected) < 1e-9


def test_eq_epicenters_inside_us_seismic_zones():
    """USGS NSHM — high-seismic regions cover California / PNW / Inter-
    mountain West / Alaska / New Madrid. Centroids should sit inside a
    union bounding box covering these regions."""
    scs = EQPeril().generate_scenarios("EQ_GEO", n=200)
    for s in scs:
        c = s["epicenter"]
        # The plug-in unions: California, PNW, Intermountain West,
        # New Madrid, Alaska. Loose bounding box.
        assert 30.0 <= c["lat"] <= 70.0
        assert -170.0 <= c["lon"] <= -85.0


def test_eq_mmi_radius_grows_with_magnitude():
    """Bakun-Wentworth: MMI VI radius increases monotonically with Mw."""
    scs = EQPeril().generate_scenarios("EQ_MMI", n=500)
    by_mw = sorted((s["severity"], s["mmi_radii_km"]["6"]) for s in scs)
    # The pair with the smallest Mw should not have a larger MMI-VI
    # radius than the pair with the largest Mw — Bakun-Wentworth is
    # strictly monotonic in Mw.
    assert by_mw[0][1] < by_mw[-1][1]


def test_eq_zero_n_returns_empty():
    assert EQPeril().generate_scenarios("EQ_TEST", n=0) == []
