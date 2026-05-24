"""Task P3.18 — basin-aware seed tracks for ml.scenarios.generate.

Caribbean and Atlantic Canada demo tracks are added alongside the
existing FL-west-coast track so the Monte-Carlo generator can produce
scenarios for non-CONUS landfalls. Each seed track is 21 waypoints at
6-hour spacing matching the existing convention.
"""

from __future__ import annotations

import pytest

from ml.scenarios.generate import (
    BASIN_DEMO_TRACKS,
    generate_scenarios,
)


def test_basin_demo_tracks_registered():
    assert set(BASIN_DEMO_TRACKS) == {"us_atlantic", "caribbean", "atlantic_canada"}


def test_each_basin_track_has_21_waypoints():
    for name, track in BASIN_DEMO_TRACKS.items():
        assert len(track) == 21, f"{name} has {len(track)} waypoints, expected 21"


def test_basin_tracks_have_expected_landfall_regions():
    """Each track's landfall (~ hour 60) lands in its named region."""
    # Caribbean: ~ 18° N, -74° W (Hispaniola south coast).
    cb = BASIN_DEMO_TRACKS["caribbean"]
    cb_landfall = cb[10]
    assert 17 <= cb_landfall["lat"] <= 21, f"CB lat {cb_landfall['lat']}"
    assert -78 <= cb_landfall["lon"] <= -73, f"CB lon {cb_landfall['lon']}"

    # Atlantic Canada: ~ 44.7° N, -63.6° W (Nova Scotia).
    ca = BASIN_DEMO_TRACKS["atlantic_canada"]
    ca_landfall = ca[10]
    assert 43 <= ca_landfall["lat"] <= 47, f"CA lat {ca_landfall['lat']}"
    assert -66 <= ca_landfall["lon"] <= -60, f"CA lon {ca_landfall['lon']}"

    # US Atlantic: ~ 29.3° N, -82.1° W (FL Gulf Coast — unchanged).
    us = BASIN_DEMO_TRACKS["us_atlantic"]
    us_landfall = us[10]
    assert 25 <= us_landfall["lat"] <= 32, f"US lat {us_landfall['lat']}"
    assert -85 <= us_landfall["lon"] <= -78, f"US lon {us_landfall['lon']}"


def test_basin_tracks_have_monotonic_hours_from_now():
    """All seed tracks should have strictly-monotonic 6h-spaced timestamps."""
    for name, track in BASIN_DEMO_TRACKS.items():
        hours = [p["hours_from_now"] for p in track]
        assert hours[0] == 0, f"{name} first hour {hours[0]}, expected 0"
        for i in range(1, len(hours)):
            assert hours[i] - hours[i-1] == 6, (
                f"{name} non-6h spacing at index {i}: {hours[i-1]}→{hours[i]}"
            )


def test_caribbean_track_drives_scenarios_in_caribbean():
    """generate_scenarios with the Caribbean seed track should produce
    scenarios whose paths stay in Caribbean latitudes (mostly)."""
    cb_track = BASIN_DEMO_TRACKS["caribbean"]
    scs = generate_scenarios(storm_id="CB_TEST", n=20, seed_track=cb_track)
    assert len(scs) == 20
    for s in scs:
        # First waypoint of each scenario should be near the seed first.
        assert s["path"][0]["lat"] < 20  # Caribbean
        # Landfall waypoint (around the middle) should also stay in CB band.
        mid = s["path"][len(s["path"]) // 2]
        assert mid["lat"] < 25, f"midpoint lat {mid['lat']} too far north"


def test_atlantic_canada_track_drives_scenarios_in_north_atlantic():
    """generate_scenarios with the Atlantic Canada seed track should
    produce scenarios whose paths reach Canadian latitudes."""
    ca_track = BASIN_DEMO_TRACKS["atlantic_canada"]
    scs = generate_scenarios(storm_id="CA_TEST", n=20, seed_track=ca_track)
    assert len(scs) == 20
    for s in scs:
        # The track should extend into Canadian latitudes by the end.
        # Seed end-point is 49.8° N; perturbation σ at hour 120 = 2.5°, so
        # a 3σ excursion can land as low as ~ 42° N. Threshold > 42 keeps
        # the test deterministic without baking in the perturbation
        # distribution.
        last = s["path"][-1]
        assert last["lat"] > 42, f"end-track lat {last['lat']} too far south"
