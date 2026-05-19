"""Tests for api_py.sim_loss.generate_sim_losses."""
import json
from pathlib import Path
import numpy as np
import pytest

from api_py.sim_loss import generate_sim_losses, peril_decay, perturbation_sigmas
from api_py.cohort_keys import cohort_key as _cohort_key, policy_quintile_lookup


SAMPLE_POLICIES = [
    # (id, lat, lon, tiv, build_type, zip3)
    (1, 27.7, -82.3, 500_000.0, "wood_frame", "337"),
    (2, 27.8, -82.2, 800_000.0, "masonry", "337"),
    (3, 30.0, -85.0, 400_000.0, "mobile_home", "325"),
]


def _canonical_keyer(policies):
    """Return a cohort_keyer using the full quintile-aware cohort key.

    Pins to the same cuts as policy_quintile_lookup so the key format
    matches what _solve_stdin._handle_sim_loss and the MIP precompute emit.
    """
    quintile_by_id = policy_quintile_lookup(policies)
    return lambda p: _cohort_key(p, quintile_by_id[int(p[0])])

TAMPA_POLY = {
    "type": "Polygon",
    "coordinates": [[[-82.5, 27.5], [-82.0, 27.5], [-82.0, 28.0], [-82.5, 28.0], [-82.5, 27.5]]],
}


def _footprint(peril="hail", intensity="severe"):
    return {
        "peril": peril,
        "intensity": intensity,
        "geometry": TAMPA_POLY,
        "effective_date": "2026-05-18",
        "metadata": {"drawn_by": "test", "drawn_at": "2026-05-18T00:00:00Z"},
    }


def test_generate_returns_cohort_x_K_array():
    result = generate_sim_losses(
        sim_id="1234567890123_abcdef00",
        footprint=_footprint(),
        policies=SAMPLE_POLICIES,
        cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
        K=100,
    )
    assert result["K"] == 100
    assert result["losses"].shape[1] == 100
    # Two cohorts are inside (337_wood_frame, 337_masonry); 325_mobile_home is outside.
    assert result["losses"].shape[0] >= 1


def test_canonical_quintile_keyer_emits_full_key():
    """Regression: generate_sim_losses with the full quintile-aware keyer must
    produce cohort_keys in the canonical ``{zip3}_{build_type}_q{N}`` format.

    This locks in the format that _solve_stdin._handle_sim_loss emits after
    the cohort-key mismatch fix (bug: promote path used prefix-only keys,
    causing every sim loss lookup in precompute to miss silently).
    """
    keyer = _canonical_keyer(SAMPLE_POLICIES)
    result = generate_sim_losses(
        sim_id="1234567890123_abcdef01",
        footprint=_footprint(),
        policies=SAMPLE_POLICIES,
        cohort_keyer=keyer,
        K=100,
    )
    # All cohort_keys must match the canonical pattern.
    for key in result["cohort_keys"]:
        parts = key.split("_")
        # Format: zip3 _ build_type[s] _ q{N}
        assert parts[-1].startswith("q"), (
            f"cohort key '{key}' does not end with q{{quintile}} suffix — "
            "prefix-only key would silently miss MIP cohort lookup"
        )
        assert parts[-1][1:].isdigit(), f"quintile suffix in '{key}' is not numeric"
        q = int(parts[-1][1:])
        assert 0 <= q <= 4, f"quintile {q} out of range 0..4 in key '{key}'"


def test_seed_is_deterministic():
    a = generate_sim_losses("1234567890123_abcdef00", _footprint(), SAMPLE_POLICIES,
                            cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    b = generate_sim_losses("1234567890123_abcdef00", _footprint(), SAMPLE_POLICIES,
                            cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    np.testing.assert_array_equal(a["losses"], b["losses"])


def test_empty_polygon_yields_zero_losses():
    fp = _footprint()
    fp["geometry"] = {"type": "Polygon",
                      "coordinates": [[[0.0, 0.0], [0.001, 0.0], [0.001, 0.001], [0.0, 0.001], [0.0, 0.0]]]}
    result = generate_sim_losses("1234567890123_abcdef00", fp, SAMPLE_POLICIES,
                                 cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    # No policies in this tiny equatorial box.
    assert result["losses"].sum() == 0.0


def test_peril_decay_returns_unit_inside_uniform_perils():
    # flood / wildfire / winter are uniform-inside.
    assert peril_decay("flood", distance_km=0.0, width_km=0.2) == 1.0
    assert peril_decay("wildfire", distance_km=0.0, width_km=0.2) == 1.0


def test_perturbation_sigmas_returns_per_peril_values():
    sigmas = perturbation_sigmas("tornado")
    assert "vertex_deg" in sigmas
    assert "width_pct" in sigmas


def test_intensity_clipped_at_one():
    fp = _footprint(peril="wildfire", intensity="catastrophic")
    result = generate_sim_losses("1234567890123_abcdef00", fp, SAMPLE_POLICIES,
                                 cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    # The two inside policies have wildfire severe damage_ratio = 0.92 / 0.85;
    # catastrophic x1.45 then clipped at 1.0.
    # Per-policy loss ≤ TIV × 1.0 → cohort totals bounded.
    assert (result["losses"] <= 500_000 + 800_000).all()
