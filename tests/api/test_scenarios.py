"""Task 12 — unit tests for the Monte Carlo scenario generator."""

from __future__ import annotations

import statistics

from ml.scenarios.generate import generate_scenarios


def test_scenarios_have_valid_probabilities():
    scs = generate_scenarios(storm_id="AL092024", n=1000)
    assert len(scs) == 1000
    total_prob = sum(s["prob"] for s in scs)
    assert abs(total_prob - 1.0) < 1e-3
    assert all(0 < s["prob"] < 1 for s in scs)


def test_scenarios_have_required_fields():
    scs = generate_scenarios(storm_id="AL092024", n=100)
    for s in scs:
        assert {"id", "path", "peak_wind", "surge_grid", "prob"}.issubset(s.keys())
        assert isinstance(s["path"], list)
        assert len(s["path"]) >= 5
        assert isinstance(s["peak_wind"], (int, float))
        assert isinstance(s["surge_grid"], dict)


def test_scenarios_dispersion():
    """Track endpoints should spread out due to perturbation."""
    scs = generate_scenarios(storm_id="AL092024", n=1000)
    final_lats = [s["path"][-1]["lat"] for s in scs]
    stdev_lat = statistics.stdev(final_lats)
    # 5-day track error std is ~2.5 deg lat at endpoint
    assert 1.0 < stdev_lat < 5.0, f"Unexpected lat stdev: {stdev_lat}"


def test_peak_wind_within_reasonable_range():
    scs = generate_scenarios(storm_id="AL092024", n=500)
    winds = [s["peak_wind"] for s in scs]
    assert min(winds) > 60   # Even with perturbation, a 130mph base shouldn't go below 60
    assert max(winds) < 220  # Cap to physically reasonable


def test_scenario_has_kind_hurricane_discriminator():
    """SIM.8: peril-agnostic discriminator on hurricane scenarios."""
    out = generate_scenarios("AL092024", n=2)
    for s in out:
        assert s.get("kind") == "hurricane"
