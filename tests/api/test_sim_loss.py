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
    (3, 30.0, -85.0, 400_000.0, "manufactured", "325"),
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


def _footprint(peril="hail", intensity="severe", severity=None):
    fp = {
        "peril": peril,
        "intensity": intensity,
        "geometry": TAMPA_POLY,
        "effective_date": "2026-05-18",
        "metadata": {"drawn_by": "test", "drawn_at": "2026-05-18T00:00:00Z"},
    }
    if severity is not None:
        fp["severity"] = severity
    return fp


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
    # Two cohorts are inside (337_wood_frame, 337_masonry); 325_manufactured is outside.
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


def test_damage_multiplier_continuous_anchors():
    from api_py.sim_loss import _damage_multiplier
    assert _damage_multiplier("earthquake", 6.0) == pytest.approx(0.55)
    assert _damage_multiplier("earthquake", 7.0) == pytest.approx(1.0)
    assert _damage_multiplier("earthquake", 8.0) == pytest.approx(1.45)
    # Recalibrated to real-world thresholds: 20 mm damage threshold, 45 mm severe.
    assert _damage_multiplier("hail", 20) == pytest.approx(0.0)
    assert _damage_multiplier("hail", 25) == pytest.approx(0.2)
    assert _damage_multiplier("hail", 45) == pytest.approx(1.0)
    assert _damage_multiplier("hail", 65) == pytest.approx(1.8)


def test_damage_multiplier_clamps_low():
    from api_py.sim_loss import _damage_multiplier
    # Below-range inputs honestly return 0. Earthquake zeroes out below
    # Mw 5.53 (Bakun-Wentworth MMI VI zero-crossing) — the previous
    # `max(0.05, …)` floor produced phantom 3.5 % wood-frame damage at
    # M5.0 even though M5.0 quakes produce essentially no filed claims.
    # Hail returns 0 below the 20 mm damage threshold.
    assert _damage_multiplier("earthquake", 5.0) == pytest.approx(0.0)
    assert _damage_multiplier("earthquake", 1.0) == pytest.approx(0.0)
    # Just above the Bakun-Wentworth threshold the linear formula resumes.
    assert _damage_multiplier("earthquake", 6.0) == pytest.approx(0.55)
    assert _damage_multiplier("hail", 0) == pytest.approx(0.0)
    assert _damage_multiplier("hail", 15) == pytest.approx(0.0)


def test_damage_multiplier_discrete():
    from api_py.sim_loss import _damage_multiplier
    assert _damage_multiplier("tornado", "ef0") == pytest.approx(0.325)
    assert _damage_multiplier("tornado", "ef3") == pytest.approx(1.0)
    assert _damage_multiplier("tornado", "ef5") == pytest.approx(1.45)
    # Flood, wildfire, and winter are recalibrated off the legacy spine.
    #   - NWS Flood: Minor is nuisance flooding (0.25), Major is multi-floor
    #     inundation (1.20)
    #   - dNBR Wildfire: low = minimal structural impact (0.10), high is
    #     HAZUS-severe total loss (1.00)
    #   - WSSI Winter: Limited is nuisance (0.01), Minor is scattered pipe
    #     burst (0.04), Extreme anchors at HAZUS-severe (1.00) matching
    #     Uri 2021 / Buffalo 2014 worst-hit-ZIP mean DRs
    # Mirrors lib/sim/severity.ts.
    assert _damage_multiplier("flood", "minor") == pytest.approx(0.25)
    assert _damage_multiplier("flood", "moderate") == pytest.approx(0.70)
    assert _damage_multiplier("flood", "major") == pytest.approx(1.20)
    assert _damage_multiplier("wildfire", "low") == pytest.approx(0.10)
    assert _damage_multiplier("wildfire", "moderate") == pytest.approx(0.40)
    assert _damage_multiplier("wildfire", "high") == pytest.approx(1.00)
    assert _damage_multiplier("winter", "limited") == pytest.approx(0.01)
    assert _damage_multiplier("winter", "minor") == pytest.approx(0.04)
    assert _damage_multiplier("winter", "moderate") == pytest.approx(0.15)
    assert _damage_multiplier("winter", "major") == pytest.approx(0.40)
    assert _damage_multiplier("winter", "extreme") == pytest.approx(1.00)


def test_damage_multiplier_legacy_tier_fallback():
    from api_py.sim_loss import _damage_multiplier
    # Footprints stored before the per-peril scales carry a tier string.
    assert _damage_multiplier("hail", "severe") == pytest.approx(1.0)
    assert _damage_multiplier("tornado", "moderate") == pytest.approx(0.55)
    assert _damage_multiplier("earthquake", "catastrophic") == pytest.approx(1.45)


def test_generate_honours_severity():
    # An EF5 tornado footprint produces strictly larger losses than EF0.
    big = generate_sim_losses(
        "1234567890123_abcdef02", _footprint(peril="tornado", severity="ef5"),
        SAMPLE_POLICIES, cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    small = generate_sim_losses(
        "1234567890123_abcdef02", _footprint(peril="tornado", severity="ef0"),
        SAMPLE_POLICIES, cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    assert big["losses"].sum() > small["losses"].sum()


def test_generate_legacy_intensity_fallback():
    # A footprint with only `intensity` (no `severity`) still produces losses.
    result = generate_sim_losses(
        "1234567890123_abcdef03", _footprint(peril="hail", intensity="severe"),
        SAMPLE_POLICIES, cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    assert result["losses"].sum() > 0


def test_summarize_builds_histogram_and_tail_stats():
    from api_py.sim_loss import _summarize
    # 4 cohorts × K=200; per-scenario totals = column sums.
    rng = np.random.default_rng(0)
    losses = rng.lognormal(mean=12.0, sigma=0.5, size=(4, 200))
    result = {"K": 200, "cohort_keys": ["a", "b", "c", "d"], "losses": losses,
              "meta": {"sim_id": "x", "peril": "hail", "intensity": "severe"}}
    out = _summarize(result, bins=20)
    assert set(out["summary"]) == {"mean", "p50", "p90", "p99", "tvar99", "min", "max"}
    assert len(out["histogram"]["counts"]) == 20
    assert len(out["histogram"]["bin_edges"]) == 21
    assert sum(out["histogram"]["counts"]) == 200            # every scenario binned
    totals = losses.sum(axis=0)
    assert out["summary"]["tvar99"] >= out["summary"]["p99"]  # tail mean ≥ quantile
    assert out["summary"]["max"] == float(totals.max())


def test_summarize_handles_all_zero_losses():
    from api_py.sim_loss import _summarize
    result = {"K": 10, "cohort_keys": [], "losses": np.zeros((0, 10)),
              "meta": {"sim_id": "x", "peril": "hail", "intensity": "severe"}}
    out = _summarize(result, bins=5)
    assert out["summary"]["mean"] == 0.0
    assert out["summary"]["tvar99"] == 0.0
    assert sum(out["histogram"]["counts"]) == 10


def test_run_request_skips_persist_when_disabled(monkeypatch):
    from api_py import sim_loss
    monkeypatch.setenv("FORGE_SIM_PERSIST", "0")
    calls = []
    monkeypatch.setattr(sim_loss, "write_artifact",
                        lambda *a, **k: calls.append("write") or (Path("x"), Path("y")))
    resp = sim_loss.run_request({
        "sim_id": "1234567890123_abcdef00", "footprint": _footprint(),
        "policies": SAMPLE_POLICIES, "K": 50,
    })
    assert calls == []                       # persist skipped
    assert resp["artifact_path"] is None
    assert resp["K"] == 50
    assert "histogram" in resp and "summary" in resp
    assert resp["n_cohorts"] >= 0


def test_run_request_persists_when_enabled(monkeypatch):
    from api_py import sim_loss
    monkeypatch.setenv("FORGE_SIM_PERSIST", "1")
    calls = []
    monkeypatch.setattr(sim_loss, "write_artifact",
                        lambda sim_id, result, **k: (calls.append(sim_id),
                                                     (Path(f"/tmp/{sim_id}.parquet"), Path("m")))[1])
    resp = sim_loss.run_request({
        "sim_id": "1234567890123_abcdef00", "footprint": _footprint(),
        "policies": SAMPLE_POLICIES, "K": 50,
    })
    assert calls == ["1234567890123_abcdef00"]
    assert resp["artifact_path"] == "/tmp/1234567890123_abcdef00.parquet"


def test_run_request_rejects_missing_fields():
    from api_py import sim_loss
    with pytest.raises(ValueError):
        sim_loss.run_request({"policies": SAMPLE_POLICIES})
