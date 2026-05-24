"""AUDIT.3 Phase 2a — verify that scenario perturbation reconstructs
the NHC cone of uncertainty.

The contract from ``docs/scoping/audit-3-nhc-track-error-usgs-ned.md``
§4 Phase 2:

    Produce K=1000 scenarios that, in aggregate, reconstruct the NHC
    cone of uncertainty.  Tests for: scenario set reconstructs NHC
    cone widths within 10% at hours 24/48/72/96/120; deterministic for
    a given (basin, seed_storm_id).

This test draws K=1000 scenarios from a known seed track and computes
the 67th percentile of total perturbation magnitude at each forecast
hour.  That percentile is the NHC "cone radius" by published
definition.  We compare it back against the empirical cone in the
climatology artifact — which was itself fit on 2019-2023 OFCL records
in PR #49 — and against the published 2026 NHC Atlantic cone.
"""

from __future__ import annotations

import json
import math
import statistics

import numpy as np
import pytest

from ml.scenarios.generate import (
    _R67_TO_SIGMA,
    _TRACK_ERROR_JSON,
    _interpolate_at_hour,
    _load_nhc_climatology,
    generate_scenarios,
)

# Same FORECAST_HOURS_PRIMARY as in scripts/fetch_nhc_errors.py.
_HOURS = (12, 24, 36, 48, 60, 72, 96, 120)
# Verification subset called out in the scoping doc.
_HOURS_REQUIRED = (24, 48, 72, 96, 120)


# ── climatology loader ────────────────────────────────────────────────────


def test_load_nhc_climatology_returns_two_tables() -> None:
    track, wind = _load_nhc_climatology()
    # Each table maps int hour → float σ.
    assert isinstance(track, dict) and isinstance(wind, dict)
    assert 0 in track and 0 in wind
    assert track[0] == 0.0 and wind[0] == 0.0
    for hour in _HOURS:
        assert hour in track and hour in wind
        assert track[hour] > 0 and wind[hour] > 0


def test_climatology_sigma_monotonic_in_hour() -> None:
    track, wind = _load_nhc_climatology()
    track_seq = [track[h] for h in _HOURS]
    wind_seq = [wind[h] for h in _HOURS]
    assert track_seq == sorted(track_seq), (
        "track σ must grow with forecast hour")
    assert wind_seq == sorted(wind_seq), (
        "wind σ must grow with forecast hour")


def test_climatology_track_sigma_matches_r67_to_sigma_conversion() -> None:
    """σ_track at each hour equals the empirical r67 from the JSON
    artifact divided by sqrt(-2·ln(0.33)).  This is the contract the
    cone-reconstruction test relies on."""
    track_sigma, _ = _load_nhc_climatology()
    payload = json.loads(_TRACK_ERROR_JSON.read_text())
    by_hour = payload["cone_radii_empirical"]["by_hour"]
    for hour in _HOURS:
        expected = by_hour[str(hour)]["cone_radius_p67_nm"] * _R67_TO_SIGMA
        assert track_sigma[hour] == pytest.approx(expected, rel=1e-9)


# ── interpolation ─────────────────────────────────────────────────────────


def test_interpolate_at_hour_matches_table_at_pins() -> None:
    track, _ = _load_nhc_climatology()
    for hour in _HOURS:
        assert _interpolate_at_hour(track, float(hour)) == track[hour]


def test_interpolate_at_hour_linear_between_pins() -> None:
    track, _ = _load_nhc_climatology()
    # Hour 30 sits between 24 and 36 — should land halfway.
    expected = (track[24] + track[36]) / 2.0
    assert _interpolate_at_hour(track, 30.0) == pytest.approx(expected,
                                                              rel=1e-9)


def test_interpolate_at_hour_clamps_above_120() -> None:
    track, _ = _load_nhc_climatology()
    # Hour > 120 should clamp to the 120h endpoint (we don't extrapolate
    # beyond the fitted climatology).
    assert _interpolate_at_hour(track, 240.0) == track[120]


def test_interpolate_at_hour_clamps_below_zero() -> None:
    track, _ = _load_nhc_climatology()
    assert _interpolate_at_hour(track, -10.0) == track[0]


# ── cone reconstruction (the headline Phase 2a verification) ──────────────


def _empirical_cone_from_scenarios(
    scenarios: list[dict], seed_path: list[dict],
) -> dict[int, float]:
    """For each forecast hour present in ``seed_path``, compute the 67th
    percentile of the great-circle distance (nm) between each scenario's
    perturbed waypoint and the seed waypoint at that hour.  This is the
    NHC cone-construction algorithm, applied to our scenario ensemble.
    """
    cone: dict[int, float] = {}
    # Convert 1° lat → 60 nm; for longitude, scale by cos(lat) at the
    # seed waypoint.  Approximation is excellent at the Atlantic basin scale.
    for idx, seed_pt in enumerate(seed_path):
        hour = int(seed_pt["hours_from_now"])
        if hour == 0:
            continue
        cos_lat = math.cos(math.radians(seed_pt["lat"]))
        dists_nm = []
        for s in scenarios:
            pt = s["path"][idx]
            dlat = pt["lat"] - seed_pt["lat"]
            dlon = (pt["lon"] - seed_pt["lon"]) * cos_lat
            d_deg = math.sqrt(dlat * dlat + dlon * dlon)
            dists_nm.append(d_deg * 60.0)  # 1° = 60 nm
        cone[hour] = float(np.percentile(dists_nm, 67))
    return cone


def test_scenarios_reconstruct_nhc_cone_within_10_percent() -> None:
    """Per scoping doc §4 Phase 2 verification: K=1000 scenarios must
    reproduce the empirical NHC cone widths within 10% at the canonical
    verification hours (24/48/72/96/120)."""
    scs = generate_scenarios(storm_id="AL092024_PHASE2A", n=1000)
    # Reconstruct what seed track was used (the default FL demo path).
    # Pulling it directly from the module keeps this test honest about
    # what is being calibrated against.
    from ml.scenarios.generate import _DEMO_TRACK_FL
    cone = _empirical_cone_from_scenarios(scs, _DEMO_TRACK_FL)

    payload = json.loads(_TRACK_ERROR_JSON.read_text())
    empirical = payload["cone_radii_empirical"]["by_hour"]
    for hour in _HOURS_REQUIRED:
        target = empirical[str(hour)]["cone_radius_p67_nm"]
        produced = cone[hour]
        rel = (produced - target) / target
        assert abs(rel) <= 0.10, (
            f"hour {hour}: scenario cone {produced:.1f} nm vs "
            f"empirical {target:.1f} nm, rel error {rel:+.1%} "
            f"exceeds 10% scoping-doc tolerance")


def test_scenarios_reconstruct_published_cone_within_20_percent() -> None:
    """Looser bound against the published 2026 NHC Atlantic cone radii
    (fit on 2021-2025).  20% reflects the ~10% window-offset bias from
    PR #49 plus the ~10% sampling noise at K=1000 — both expected and
    intentional."""
    scs = generate_scenarios(storm_id="AL092024_PUBLISHED", n=1000)
    from ml.scenarios.generate import _DEMO_TRACK_FL
    cone = _empirical_cone_from_scenarios(scs, _DEMO_TRACK_FL)

    payload = json.loads(_TRACK_ERROR_JSON.read_text())
    published = payload["cone_radii_published_2026_nm"]
    for hour in _HOURS_REQUIRED:
        target = float(published[str(hour)])
        produced = cone[hour]
        rel = (produced - target) / target
        assert abs(rel) <= 0.20, (
            f"hour {hour}: scenario cone {produced:.1f} nm vs "
            f"published {target} nm, rel error {rel:+.1%}")


def test_scenarios_are_deterministic_for_storm_id() -> None:
    """Same storm_id ⇒ bit-identical scenarios.  Independent of the
    NHC climatology refactor — but a regression here on this PR would
    indicate I broke the RNG seeding."""
    a = generate_scenarios(storm_id="AL092024", n=200)
    b = generate_scenarios(storm_id="AL092024", n=200)
    assert len(a) == len(b)
    for x, y in zip(a, b):
        assert x["peak_wind"] == y["peak_wind"]
        assert x["path"][-1]["lat"] == y["path"][-1]["lat"]
        assert x["path"][-1]["lon"] == y["path"][-1]["lon"]


def test_wind_dispersion_matches_intensity_climatology() -> None:
    """The std deviation of peak-wind across scenarios should be close
    to the 120h NHC intensity σ converted from kt → mph.  Verifies the
    intensity climatology is actually being consumed."""
    _, wind_sigma_table = _load_nhc_climatology()
    sigma_kt_120h = wind_sigma_table[120]
    sigma_mph_120h = sigma_kt_120h * 1.150779

    scs = generate_scenarios(storm_id="AL092024_WIND", n=2000)
    winds = [s["peak_wind"] for s in scs]
    # Clipping at 35 / 215 mph will compress the observed σ slightly,
    # but with seed_peak=130 and σ≈25 mph the clipping bites < 1% of
    # the time at either end, so the observed σ should land within
    # ~15% of the input σ.
    observed = statistics.stdev(winds)
    assert abs(observed - sigma_mph_120h) / sigma_mph_120h < 0.15, (
        f"observed wind σ {observed:.2f} vs target {sigma_mph_120h:.2f} mph")
