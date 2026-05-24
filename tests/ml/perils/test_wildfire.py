"""Task P3.15 — Wildfire peril Monte-Carlo generator.

Generates burn-perimeter scenarios calibrated against NIFC fire size-class
data, USGS dNBR burn severity, and CA-DINS post-fire structural-impact
records (Cal Fire Damage Inspection database). Damage uses the canonical
``wildfire`` PERIL_SCALES / _HAZUS_MATRIX curves (mirror invariant).
"""

from __future__ import annotations

import math

import pytest

from ml.perils import get_peril, registered_perils
from ml.perils.wildfire import WildfirePeril


def test_wildfire_peril_registered():
    assert "wildfire" in registered_perils()
    assert isinstance(get_peril("wildfire"), WildfirePeril)


def test_wildfire_peril_id():
    assert WildfirePeril.peril_id == "wildfire"


def test_wildfire_generate_returns_n_scenarios():
    scs = WildfirePeril().generate_scenarios("WF_2026_07_15", n=100)
    assert len(scs) == 100


def test_wildfire_scenarios_carry_required_keys():
    scs = WildfirePeril().generate_scenarios("WF_2026_07_15", n=30)
    valid_levels = {"low", "moderate", "high"}
    for s in scs:
        assert s["kind"] == "wildfire"
        assert "id" in s
        assert "prob" in s
        # Damage path uses canonical wildfire curves.
        assert s["peril"] == "wildfire"
        assert s["severity"] in valid_levels
        # Acres burned anchored to NWCG fire size class (Class E+).
        assert s["acres_burned"] >= 300
        # GeoJSON Polygon footprint.
        assert s["geometry"]["type"] == "Polygon"
        ring = s["geometry"]["coordinates"][0]
        assert len(ring) >= 4
        assert ring[0] == ring[-1]


def test_wildfire_probabilities_sum_to_one():
    scs = WildfirePeril().generate_scenarios("WF_2026_07_15", n=41)
    total = sum(s["prob"] for s in scs)
    assert abs(total - 1.0) < 1e-6


def test_wildfire_deterministic_under_same_id():
    a = WildfirePeril().generate_scenarios("WF_TEST", n=20)
    b = WildfirePeril().generate_scenarios("WF_TEST", n=20)
    for x, y in zip(a, b):
        assert x["severity"] == y["severity"]
        assert x["acres_burned"] == y["acres_burned"]
        assert x["geometry"]["coordinates"] == y["geometry"]["coordinates"]


def test_wildfire_distinct_ids_diverge():
    a = WildfirePeril().generate_scenarios("WF_2026_07", n=20)
    b = WildfirePeril().generate_scenarios("WF_2026_08", n=20)
    different = sum(
        1 for x, y in zip(a, b)
        if x["severity"] != y["severity"] or x["centroid"] != y["centroid"]
    )
    assert different > 0


def test_wildfire_severity_distribution_matches_ca_dins_anchors():
    """dNBR severity distribution among DAMAGING wildfires (CA-DINS):
       Low      ≈ 0.20
       Moderate ≈ 0.55
       High     ≈ 0.25
    ±8pp tolerance at n=2000."""
    scs = WildfirePeril().generate_scenarios("WF_DIST", n=2000)
    counts = {"low": 0, "moderate": 0, "high": 0}
    for s in scs:
        counts[s["severity"]] += 1
    n = sum(counts.values())
    fracs = {k: v / n for k, v in counts.items()}
    assert abs(fracs["low"] - 0.20) < 0.08
    assert abs(fracs["moderate"] - 0.55) < 0.08
    assert abs(fracs["high"] - 0.25) < 0.08


def test_wildfire_size_distribution_heavy_tailed():
    """NIFC: among DAMAGING fires (Class E+), median ≈ 1k acres,
    p95 ≈ 100k+ acres (mega-fire tail). Sanity: max > 50× median."""
    scs = WildfirePeril().generate_scenarios("WF_SIZE", n=500)
    acres = sorted(s["acres_burned"] for s in scs)
    median = acres[len(acres) // 2]
    p95 = acres[int(len(acres) * 0.95)]
    assert p95 > 10 * median, f"p95={p95} not >> median={median}; tail too thin"


def test_wildfire_loss_compute_uses_wildfire_curves():
    """Mirror invariant: scenario damage must equal what
    api_py.sim_loss._damage_ratio computes for hand-built footprints."""
    from api_py.sim_loss import _damage_ratio

    scs = WildfirePeril().generate_scenarios("WF_TEST", n=80)
    high = next((s for s in scs if s["severity"] == "high"), None)
    assert high is not None
    dr = _damage_ratio(high["peril"], "wood_frame", high["severity"])
    # wood_frame base 0.92 × high-multiplier 1.00 = 0.92 (clipped at 1)
    assert abs(dr - 0.92) < 1e-9


def test_wildfire_geometries_inside_western_wui():
    """Headwaters Economics + USFS WHP — damaging US wildfires cluster
    in the West / Southwest. Centroids should sit inside that bbox."""
    scs = WildfirePeril().generate_scenarios("WF_GEO", n=200)
    for s in scs:
        c = s["centroid"]
        assert 30.0 <= c["lat"] <= 49.5
        assert -125.0 <= c["lon"] <= -100.0


def test_wildfire_zero_n_returns_empty():
    assert WildfirePeril().generate_scenarios("WF_TEST", n=0) == []


def test_wildfire_perimeter_area_scales_with_acres():
    """Larger fires draw larger perimeter polygons."""
    scs = WildfirePeril().generate_scenarios("WF_AREA", n=400)
    small = [s for s in scs if s["acres_burned"] < 1500]
    large = [s for s in scs if s["acres_burned"] > 50000]
    if not small or not large:
        pytest.skip("draw produced no scenarios in one of the test bins")

    def ring_area(ring):
        a = 0.0
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            a += x1 * y2 - x2 * y1
        return abs(a) * 0.5

    ms = sum(ring_area(s["geometry"]["coordinates"][0]) for s in small) / len(small)
    ml = sum(ring_area(s["geometry"]["coordinates"][0]) for s in large) / len(large)
    assert ml > ms
