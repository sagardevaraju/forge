"""Task P3.17 — Freeze / Winter-Storm peril Monte-Carlo generator.

Generates regional freeze-event scenarios calibrated against the NOAA
ERA5 freeze-event reanalysis frequency, NWS Winter Storm Severity Index
(WSSI) category distribution, and the Texas Department of Insurance
(2022) Winter Storm Uri loss report. Damage uses the canonical
``winter`` PERIL_SCALES / _HAZUS_MATRIX curves (mirror invariant).
"""

from __future__ import annotations

import math

import pytest

from ml.perils import get_peril, registered_perils
from ml.perils.freeze import FreezePeril


def test_freeze_peril_registered():
    # Per peril-severity-calibration memory: id is internal `freeze`
    # (matches the lib/sim/severity.ts `winter` family — operator label
    # is "Winter Storm"). We name the plug-in by its meteorological
    # cause (freeze events) to disambiguate from snowfall accumulation.
    assert "freeze" in registered_perils()
    assert isinstance(get_peril("freeze"), FreezePeril)


def test_freeze_peril_id():
    assert FreezePeril.peril_id == "freeze"


def test_freeze_generate_returns_n_scenarios():
    scs = FreezePeril().generate_scenarios("FRZ_2026_01_15", n=100)
    assert len(scs) == 100


def test_freeze_scenarios_carry_required_keys():
    scs = FreezePeril().generate_scenarios("FRZ_2026_01_15", n=30)
    valid_levels = {"limited", "minor", "moderate", "major", "extreme"}
    for s in scs:
        assert s["kind"] == "freeze"
        assert "id" in s
        assert "prob" in s
        # Damage path uses canonical winter curves.
        assert s["peril"] == "winter"
        assert s["severity"] in valid_levels
        # GeoJSON Polygon footprint (regional, often multi-state).
        assert s["geometry"]["type"] == "Polygon"
        ring = s["geometry"]["coordinates"][0]
        assert len(ring) >= 4
        assert ring[0] == ring[-1]
        # Region tag — Polar Vortex, Lake-effect, Ice Storm, etc.
        assert "region" in s


def test_freeze_probabilities_sum_to_one():
    scs = FreezePeril().generate_scenarios("FRZ_2026_01_15", n=37)
    total = sum(s["prob"] for s in scs)
    assert abs(total - 1.0) < 1e-6


def test_freeze_deterministic_under_same_id():
    a = FreezePeril().generate_scenarios("FRZ_TEST", n=20)
    b = FreezePeril().generate_scenarios("FRZ_TEST", n=20)
    for x, y in zip(a, b):
        assert x["severity"] == y["severity"]
        assert x["region"] == y["region"]
        assert x["geometry"]["coordinates"] == y["geometry"]["coordinates"]


def test_freeze_distinct_ids_diverge():
    a = FreezePeril().generate_scenarios("FRZ_A", n=20)
    b = FreezePeril().generate_scenarios("FRZ_B", n=20)
    different = sum(1 for x, y in zip(a, b) if x["severity"] != y["severity"])
    assert different > 0


def test_freeze_severity_distribution_matches_wssi_anchors():
    """WSSI category frequency among DAMAGING freeze events (NOAA WSSI
    archive 2018-2023 weighted by industry-loss-bearing share):
       Limited  ≈ 0.50
       Minor    ≈ 0.30
       Moderate ≈ 0.12
       Major    ≈ 0.06
       Extreme  ≈ 0.02
    ±5pp tolerance at n=2000."""
    scs = FreezePeril().generate_scenarios("FRZ_DIST", n=2000)
    counts = {k: 0 for k in ("limited", "minor", "moderate", "major", "extreme")}
    for s in scs:
        counts[s["severity"]] += 1
    n = sum(counts.values())
    fracs = {k: v / n for k, v in counts.items()}
    assert abs(fracs["limited"] - 0.50) < 0.05
    assert abs(fracs["minor"] - 0.30) < 0.05
    assert abs(fracs["moderate"] - 0.12) < 0.05
    assert abs(fracs["major"] - 0.06) < 0.04
    # Extreme is rare — Uri-class is ~1 per 5-10 years
    assert fracs["extreme"] < 0.06


def test_freeze_loss_compute_uses_winter_curves():
    """Mirror invariant: extreme freeze damage matches a hand-built
    `winter` footprint at level=extreme."""
    from api_py.sim_loss import _damage_ratio

    scs = FreezePeril().generate_scenarios("FRZ_TEST", n=200)
    extreme = next((s for s in scs if s["severity"] == "extreme"), None)
    if extreme is None:
        # 2% of 200 = ~4 draws expected; if none, draw more
        scs = FreezePeril().generate_scenarios("FRZ_TEST_BIG", n=1000)
        extreme = next((s for s in scs if s["severity"] == "extreme"), None)
    assert extreme is not None
    dr = _damage_ratio(extreme["peril"], "wood_frame", extreme["severity"])
    # wood_frame.winter base = 0.08; extreme multiplier = 1.00 → 0.08.
    assert abs(dr - 0.08) < 1e-9


def test_freeze_regions_cover_us_cold_zones():
    """Geographic regions span the US cold-impact archetypes:
       Polar Vortex — Plains/Midwest/Texas
       Lake-effect — Great Lakes
       Ice Storm — Southeast/Mid-Atlantic
    All centroids should fall inside CONUS bounds."""
    scs = FreezePeril().generate_scenarios("FRZ_GEO", n=300)
    regions_seen = {s["region"] for s in scs}
    assert len(regions_seen) >= 2, f"expected variety of regions, got {regions_seen}"
    for s in scs:
        c = s["centroid"]
        # CONUS coverage (no AK/HI freeze events in v1).
        assert 24.0 <= c["lat"] <= 49.5
        assert -125.0 <= c["lon"] <= -66.0


def test_freeze_zero_n_returns_empty():
    assert FreezePeril().generate_scenarios("FRZ_TEST", n=0) == []


def test_freeze_extreme_events_have_larger_footprints():
    """Polar Vortex / Uri-class extreme events cover multi-state areas;
    Limited events are localised. Mean footprint area: extreme > limited."""
    scs = FreezePeril().generate_scenarios("FRZ_AREA", n=2000)
    extreme = [s for s in scs if s["severity"] == "extreme"]
    limited = [s for s in scs if s["severity"] == "limited"]
    if not extreme or not limited:
        pytest.skip("draw produced no scenarios in one of the test bins")

    def ring_area(ring):
        a = 0.0
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            a += x1 * y2 - x2 * y1
        return abs(a) * 0.5

    me = sum(ring_area(s["geometry"]["coordinates"][0]) for s in extreme) / len(extreme)
    ml = sum(ring_area(s["geometry"]["coordinates"][0]) for s in limited) / len(limited)
    assert me > ml
