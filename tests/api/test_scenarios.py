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
    """Peak-wind perturbation is sized from NHC intensity climatology
    (σ ≈ 25 mph at the 120h horizon — wider than the old hand-coded
    15 mph σ).  What we still care about:

      - hard physical clip in the generator (TS-floor 35 mph,
        Cat-5+ ceiling 215 mph) actually fires
      - the bulk of the distribution stays near the seed peak,
        not biased low or high
    """
    # Phase 2b: seed peak comes from the HURDAT2-sampled landmark
    # storm (Hurricane Ian, peaking at 140 kt ≈ 161 mph) rather than
    # a hand-tabulated 140 mph literal.  Compute the expected median
    # from the seed track so the assertion stays aligned with the
    # data and won't break if the landmark storm is swapped later.
    from ml.scenarios.generate import sample_basin_seed_track
    seed = sample_basin_seed_track("us_atlantic")
    seed_peak = max(p["peak_wind"] for p in seed)

    scs = generate_scenarios(storm_id="AL092024", n=500)
    winds = sorted(s["peak_wind"] for s in scs)
    # Physical clip — every draw within the hard bounds.
    assert all(35.0 <= w <= 215.0 for w in winds)
    # Bulk dispersion check: 10-90 percentile band sits inside the clip
    # bounds; median tracks the seed peak.
    p10, p50, p90 = winds[49], winds[249], winds[449]
    assert 80 < p10 < p50 < p90 < 215
    assert abs(p50 - seed_peak) < 10.0, (
        f"median peak wind drift: p50={p50:.1f}, seed_peak={seed_peak:.1f}")


def test_scenario_has_kind_hurricane_discriminator():
    """SIM.8: peril-agnostic discriminator on hurricane scenarios."""
    out = generate_scenarios("AL092024", n=2)
    for s in out:
        assert s.get("kind") == "hurricane"
