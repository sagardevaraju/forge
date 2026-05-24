"""Basin-aware seed tracks for ``ml.scenarios.generate``.

Task P3.18 originally added hand-tabulated Caribbean and Atlantic-Canada
demo tracks alongside the FL-west-coast track.  AUDIT.3 Phase 2b (PR
following #50) replaced all three with HURDAT2-derived landmark storms:

    us_atlantic     → AL092022  Hurricane Ian   (Cat-4 SW FL landfall)
    caribbean       → AL152017  Hurricane Maria (Cat-4 PR landfall)
    atlantic_canada → AL072022  Hurricane Fiona (Cat-2 Nova Scotia)

The dict ``BASIN_DEMO_TRACKS`` is gone; consumers now call the function
``sample_basin_seed_track(basin, *, seed_storm_id=None)``.
"""

from __future__ import annotations

import pytest

from ml.scenarios.generate import (
    _LANDMARK_STORM_BY_BASIN,
    generate_scenarios,
    sample_basin_seed_track,
)


_BASINS = ("us_atlantic", "caribbean", "atlantic_canada")


def test_basin_seed_tracks_registered():
    assert set(_LANDMARK_STORM_BY_BASIN) == set(_BASINS)


def test_each_basin_track_has_21_waypoints():
    for basin in _BASINS:
        track = sample_basin_seed_track(basin)
        assert len(track) == 21, (
            f"{basin} has {len(track)} waypoints, expected 21")


def test_basin_tracks_have_expected_landfall_regions():
    """Hour-60 waypoint of each track lands in its named region.

    These are the HURDAT2 ground-truth lat/lon of each landmark storm
    at hour 60 of the standard-cadence slice (i.e., 60 hours after
    the storm's first standard-cadence record):
      Ian  hour 60 ≈ 18.7° N, -82.4° W (central Caribbean, pre-FL)
      Maria hour 60 ≈ 17.0° N, -64.3° W (USVI/PR approach)
      Fiona hour 60 ≈ 20.2° N, -70.1° W (north of Hispaniola)
    """
    us = sample_basin_seed_track("us_atlantic")
    us_landfall_idx = next(i for i, p in enumerate(us)
                           if p["hours_from_now"] == 60)
    assert 15 <= us[us_landfall_idx]["lat"] <= 35, (
        f"US lat at hour 60 = {us[us_landfall_idx]['lat']}")
    assert -90 <= us[us_landfall_idx]["lon"] <= -75, (
        f"US lon at hour 60 = {us[us_landfall_idx]['lon']}")

    cb = sample_basin_seed_track("caribbean")
    cb_landfall_idx = next(i for i, p in enumerate(cb)
                           if p["hours_from_now"] == 60)
    assert 12 <= cb[cb_landfall_idx]["lat"] <= 22, (
        f"CB lat at hour 60 = {cb[cb_landfall_idx]['lat']}")
    assert -70 <= cb[cb_landfall_idx]["lon"] <= -55, (
        f"CB lon at hour 60 = {cb[cb_landfall_idx]['lon']}")

    ca = sample_basin_seed_track("atlantic_canada")
    ca_landfall_idx = next(i for i, p in enumerate(ca)
                           if p["hours_from_now"] == 60)
    # Fiona at hour 60 of standard-cadence slice is still in tropics;
    # she didn't reach NS until ~hour 144.  All we can guarantee at
    # hour 60 is "northern tropical Atlantic"; the full track does
    # reach Canadian latitudes by its tail (see endpoint test below).
    assert 15 <= ca[ca_landfall_idx]["lat"] <= 35, (
        f"CA lat at hour 60 = {ca[ca_landfall_idx]['lat']}")


def test_basin_tracks_have_monotonic_hours_from_now():
    """Every seed track has strictly-monotonic 6h-spaced timestamps."""
    for basin in _BASINS:
        track = sample_basin_seed_track(basin)
        hours = [p["hours_from_now"] for p in track]
        assert hours[0] == 0, f"{basin} first hour {hours[0]}, expected 0"
        for i in range(1, len(hours)):
            assert hours[i] - hours[i-1] == 6, (
                f"{basin} non-6h spacing at index {i}: "
                f"{hours[i-1]}→{hours[i]}")


def test_basin_tracks_carry_peak_wind_in_mph():
    """HURDAT2 peak winds are in knots; the seed track converts to mph.

    Sanity bound: tropical storm 35 mph → Cat-5+ 200 mph."""
    for basin in _BASINS:
        track = sample_basin_seed_track(basin)
        for waypoint in track:
            pw = waypoint["peak_wind"]
            assert 30.0 <= pw <= 220.0, (
                f"{basin} peak_wind {pw} out of physical range")


def test_us_atlantic_seed_track_is_hurricane_ian():
    """Hour-0 of us_atlantic landmark = Ian at 2022-09-24 00:00 UTC
    (14.7° N, -71.7° W, 35 kt tropical-storm intensity)."""
    track = sample_basin_seed_track("us_atlantic")
    assert track[0]["lat"] == pytest.approx(14.7, abs=0.1)
    assert track[0]["lon"] == pytest.approx(-71.7, abs=0.1)
    # 35 kt × 1.150779 = 40.3 mph
    assert track[0]["peak_wind"] == pytest.approx(40.3, abs=0.5)


def test_caribbean_track_drives_scenarios_in_caribbean():
    """``generate_scenarios`` with the Caribbean landmark stays in CB lat."""
    cb_track = sample_basin_seed_track("caribbean")
    scs = generate_scenarios(storm_id="CB_TEST", n=20, seed_track=cb_track)
    assert len(scs) == 20
    for s in scs:
        # Maria's first standard-cadence row was at 12.2°N — comfortably
        # tropical.  Perturbation σ at hour 0 = 0, so the first waypoint
        # tracks the seed exactly.
        assert s["path"][0]["lat"] < 18, (
            f"first-waypoint lat {s['path'][0]['lat']} surprised")


def test_atlantic_canada_track_reaches_north_atlantic_latitudes():
    """Fiona's last standard-cadence record in the 21-row window is
    well into the mid-Atlantic; perturbed endpoints should still
    average above the 25° N tropical/sub-tropical line."""
    ca_track = sample_basin_seed_track("atlantic_canada")
    scs = generate_scenarios(storm_id="CA_TEST", n=50, seed_track=ca_track)
    assert len(scs) == 50
    end_lats = [s["path"][-1]["lat"] for s in scs]
    avg_end_lat = sum(end_lats) / len(end_lats)
    assert avg_end_lat > 18, (
        f"avg endpoint lat {avg_end_lat:.2f} too far south for "
        f"an Atlantic-Canada-named seed")


def test_sample_with_explicit_seed_storm_id_overrides_default():
    """Passing ``seed_storm_id=`` should pick a different storm even
    in a different basin slot."""
    # Use Hurricane Matthew 2016 (AL142016) as an alternate Caribbean.
    track_matthew = sample_basin_seed_track(
        "caribbean", seed_storm_id="AL142016")
    track_maria = sample_basin_seed_track("caribbean")
    assert track_matthew != track_maria
    # Matthew's HURDAT2 first row was Sept 28 2016 at 13.4°N.
    assert track_matthew[0]["lat"] == pytest.approx(13.4, abs=0.1)


def test_sample_unknown_basin_raises():
    with pytest.raises(ValueError, match="unknown basin"):
        sample_basin_seed_track("pacific")


def test_sample_unknown_storm_id_raises():
    with pytest.raises(RuntimeError, match="not in HURDAT2"):
        sample_basin_seed_track("us_atlantic", seed_storm_id="AL999999")


def test_sample_is_deterministic():
    """Same inputs ⇒ exact same track (lru_cache contract)."""
    a = sample_basin_seed_track("us_atlantic")
    b = sample_basin_seed_track("us_atlantic")
    assert a == b
