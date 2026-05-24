"""Task P3.14 — SCS (Severe Convective Storm) peril.

Generates Monte-Carlo hail-swath scenarios calibrated against Smith & Katz
(2013) US billion-dollar disaster climatology + TORRO stone-diameter
frequencies. Damage uses the canonical ``hail`` PERIL_SCALES /
_HAZUS_MATRIX curves (mirror invariant). Tests pin the contract.
"""

from __future__ import annotations

import math

import pytest

from ml.perils import get_peril, registered_perils
from ml.perils.scs import SCSPeril


# ── registry / ABC contract ────────────────────────────────────────────────


def test_scs_peril_registered():
    assert "scs" in registered_perils()
    assert isinstance(get_peril("scs"), SCSPeril)


def test_scs_peril_id():
    assert SCSPeril.peril_id == "scs"


# ── scenario contract ──────────────────────────────────────────────────────


def test_scs_generate_returns_n_scenarios():
    scs = SCSPeril().generate_scenarios("SCS_2026_06_15", n=100)
    assert len(scs) == 100


def test_scs_scenarios_carry_required_keys():
    scs = SCSPeril().generate_scenarios("SCS_2026_06_15", n=25)
    for s in scs:
        assert s["kind"] == "scs"
        assert "id" in s
        assert "prob" in s
        # Damage path uses canonical hail curves — every scenario must
        # surface a ``peril`` key set to ``"hail"`` so the existing
        # sim_loss._damage_ratio / _damage_multiplier dispatchers work
        # without any switch on ``kind``.
        assert s["peril"] == "hail"
        # Stone diameter (mm) — feeds PERIL_SCALES.hail.multiplier.
        assert isinstance(s["severity"], (int, float))
        assert 20 <= s["severity"] <= 120
        # GeoJSON Polygon footprint for the hail swath.
        assert s["geometry"]["type"] == "Polygon"
        ring = s["geometry"]["coordinates"][0]
        assert len(ring) >= 4
        # Closed ring (first == last).
        assert ring[0] == ring[-1]


def test_scs_probabilities_sum_to_one():
    scs = SCSPeril().generate_scenarios("SCS_2026_06_15", n=37)
    total = sum(s["prob"] for s in scs)
    assert abs(total - 1.0) < 1e-6


def test_scs_deterministic_under_same_id():
    """Same scenario_id ⇒ bit-identical output. The MIP precompute relies
    on this to cache scenarios across runs (Task P2.0 contract)."""
    a = SCSPeril().generate_scenarios("SCS_TEST", n=20)
    b = SCSPeril().generate_scenarios("SCS_TEST", n=20)
    for x, y in zip(a, b):
        assert x["severity"] == y["severity"]
        assert x["geometry"]["coordinates"] == y["geometry"]["coordinates"]
        assert x["centroid"] == y["centroid"]


def test_scs_distinct_ids_diverge():
    a = SCSPeril().generate_scenarios("SCS_2026_06_15", n=20)
    b = SCSPeril().generate_scenarios("SCS_2026_07_15", n=20)
    # At least one severity or centroid differs.
    different = sum(
        1 for x, y in zip(a, b)
        if x["severity"] != y["severity"] or x["centroid"] != y["centroid"]
    )
    assert different > 0


# ── hail-curve mirror invariant ────────────────────────────────────────────


def test_scs_severity_distribution_matches_torro_anchors():
    """Severity draws should reproduce TORRO frequency bins in expectation.

    TORRO frequencies among severe-hail (≥ 25 mm) events:
      25-35 mm (quarter) ≈ 55%
      35-50 mm (golf)    ≈ 25%
      50-70 mm (tennis)  ≈ 13%
      70-100 mm (baseball) ≈ 6%
      100-120 mm (softball) ≈ 1%

    With n=2000 the empirical bins should be within ±5pp of the anchors
    (loose tolerance — this is a draw, not the population).
    """
    scs = SCSPeril().generate_scenarios("SCS_DIST_TEST", n=2000)
    bins = {"q": 0, "g": 0, "t": 0, "b": 0, "s": 0}
    for s in scs:
        d = s["severity"]
        if d < 35:
            bins["q"] += 1
        elif d < 50:
            bins["g"] += 1
        elif d < 70:
            bins["t"] += 1
        elif d < 100:
            bins["b"] += 1
        else:
            bins["s"] += 1
    n = sum(bins.values())
    fracs = {k: v / n for k, v in bins.items()}
    # ±5pp tolerance vs TORRO anchors.
    assert abs(fracs["q"] - 0.55) < 0.05
    assert abs(fracs["g"] - 0.25) < 0.05
    assert abs(fracs["t"] - 0.13) < 0.05
    assert abs(fracs["b"] - 0.06) < 0.04
    # Softball is rare — just check it's bounded.
    assert fracs["s"] < 0.05


def test_scs_loss_compute_uses_hail_curves():
    """The scenarios must feed unchanged into ``api_py.sim_loss``. The
    mirror invariant means PERIL_SCALES.hail.multiplier(45 mm) = 1.0,
    so a generated 45 mm scenario must produce the same damage_ratio
    as a hand-built hail footprint at 45 mm.
    """
    from api_py.sim_loss import _damage_ratio

    scs = SCSPeril().generate_scenarios("SCS_TEST", n=50)
    # Find a near-45 mm scenario; verify damage_ratio matches hail @ 45 mm.
    near = min(scs, key=lambda s: abs(s["severity"] - 45.0))
    dr_scs = _damage_ratio(near["peril"], "wood_frame", near["severity"])
    dr_hail_45 = _damage_ratio("hail", "wood_frame", 45.0)
    # Multiplier is linear (0.04 × (d − 20)) so we can compute the expected.
    expected = 0.18 * max(0.0, 0.04 * (near["severity"] - 20.0))
    assert abs(dr_scs - expected) < 1e-9
    # The 45-mm anchor specifically matches PERIL_SCALES.hail at 1.0.
    if abs(near["severity"] - 45.0) < 1e-9:
        assert abs(dr_hail_45 - 0.18) < 1e-9


# ── geometry sanity ────────────────────────────────────────────────────────


def test_scs_geometries_inside_hail_alley():
    """Brooks et al. 2003 — peak SCS hail frequency is in the southern
    Plains. Centroids should sit inside the broad Hail Alley bounding box."""
    scs = SCSPeril().generate_scenarios("SCS_GEO_TEST", n=200)
    for s in scs:
        c = s["centroid"]
        # Bounding box from ml/perils/scs.py _HAIL_ALLEY_BBOX (broad).
        assert 25.0 <= c["lat"] <= 50.0
        assert -110.0 <= c["lon"] <= -85.0


def test_scs_geometry_area_scales_with_severity():
    """Bigger stones come from bigger storm cores. The generated polygon
    area for the top severity bin should exceed that of the bottom bin
    in expectation (not strict per-scenario)."""
    scs = SCSPeril().generate_scenarios("SCS_AREA_TEST", n=400)
    small = [s for s in scs if s["severity"] < 35]
    large = [s for s in scs if s["severity"] >= 70]
    if not small or not large:
        pytest.skip("draw produced no scenarios in one of the test bins")

    def ring_area(ring):
        # Crude planar polygon area in deg² (sufficient for the inequality).
        a = 0.0
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            a += x1 * y2 - x2 * y1
        return abs(a) * 0.5

    mean_small = sum(ring_area(s["geometry"]["coordinates"][0]) for s in small) / len(small)
    mean_large = sum(ring_area(s["geometry"]["coordinates"][0]) for s in large) / len(large)
    assert mean_large > mean_small


def test_scs_zero_n_returns_empty():
    assert SCSPeril().generate_scenarios("SCS_TEST", n=0) == []
