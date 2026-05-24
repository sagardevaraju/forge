"""Task P3.18 — Caribbean / Atlantic Canada basin expansion.

Pins the region-filter helpers in ``ml.scenarios.hurdat2`` and verifies
the acceptance criterion: refitting Saffir-Simpson frequencies on the
full Atlantic basin (US + Caribbean + Atlantic Canada + Bahamas /
Bermuda) produces a log-likelihood within ±10% of the US-Atlantic-only
baseline on a common holdout.

This is the AUDIT.4 fit (PR #16) extended to capture HURDAT2's full
geographic coverage rather than the implicit-US-only convention the
older calibration assumed.
"""

from __future__ import annotations

import math
from pathlib import Path

import pandas as pd
import pytest

from ml.scenarios.hurdat2 import is_in_region
from ml.scenarios.importance import (
    BUCKET_WIND_RANGES,
    fit_basin_frequencies_from_hurdat2,
    log_likelihood_of_distribution,
)


# ── region predicate ───────────────────────────────────────────────────────


@pytest.mark.parametrize("lat,lon,region,expected", [
    # US Atlantic — Florida west coast
    (28.5, -82.5, "us_atlantic", True),
    # US Atlantic — Texas Gulf
    (29.0, -94.5, "us_atlantic", True),
    # US Atlantic — Maine
    (44.0, -69.0, "us_atlantic", True),
    # Caribbean — Puerto Rico
    (18.4, -66.1, "caribbean", True),
    # Caribbean — Cuba
    (22.0, -79.5, "caribbean", True),
    # Caribbean — Jamaica
    (18.0, -77.0, "caribbean", True),
    # Atlantic Canada — Nova Scotia
    (44.7, -63.6, "atlantic_canada", True),
    # Atlantic Canada — Newfoundland
    (47.5, -52.7, "atlantic_canada", True),
    # Full Atlantic catches all three
    (18.4, -66.1, "full_atlantic", True),
    (28.5, -82.5, "full_atlantic", True),
    (44.7, -63.6, "full_atlantic", True),
    # Non-matches
    (28.5, -82.5, "caribbean", False),       # Florida is not Caribbean
    (18.4, -66.1, "us_atlantic", False),     # PR is not US Atlantic (in this taxonomy)
    (44.7, -63.6, "us_atlantic", False),     # Nova Scotia is not US
])
def test_is_in_region(lat, lon, region, expected):
    assert is_in_region(lat, lon, region) is expected


def test_is_in_region_rejects_unknown_label():
    with pytest.raises(ValueError, match="Unknown region"):
        is_in_region(28.0, -82.0, "antarctica")


# ── fit_basin_frequencies_from_hurdat2 with region filter ─────────────────


def _synth_full_atlantic_parquet(tmp_path: Path) -> Path:
    """Build a synthetic HURDAT2 parquet with landfalls across the
    three regions. Bucket distributions are similar but not identical
    so the region filter has observable effect.
    """
    # 20 US landfalls: 10 tropical / 5 cat1 / 3 cat2 / 1 cat3 / 1 cat4+
    # 10 Caribbean landfalls: 4 tropical / 3 cat1 / 1 cat2 / 1 cat3 / 1 cat4+
    # 4 Canadian landfalls: 4 tropical
    rows = []
    sid = 0
    def add(lat, lon, kts):
        nonlocal sid
        sid += 1
        rows.append({
            "storm_id": f"AL{sid:02d}2024",
            "name": "TEST",
            "timestamp": pd.Timestamp("2024-08-01") + pd.Timedelta(hours=sid),
            "lat": lat, "lon": lon,
            "max_wind_kts": kts,
            "system_status": "HU" if kts >= 65 else "TS",
            "record_identifier": "L",
        })
    # US Atlantic — Florida west coast
    for kts in [50]*10 + [70]*5 + [90]*3 + [105] + [130]:
        add(28.0, -82.5, kts)
    # Caribbean — Puerto Rico
    for kts in [50]*4 + [70]*3 + [90] + [105] + [130]:
        add(18.4, -66.1, kts)
    # Atlantic Canada — Nova Scotia
    for kts in [50]*4:
        add(44.7, -63.6, kts)
    df = pd.DataFrame(rows)
    path = tmp_path / "best_track_synth_full.parquet"
    df.to_parquet(path, index=False)
    return path


def test_fit_region_us_atlantic_only(tmp_path):
    path = _synth_full_atlantic_parquet(tmp_path)
    us = fit_basin_frequencies_from_hurdat2(path, region="us_atlantic")
    assert abs(sum(us.values()) - 1.0) < 1e-9
    # 20 US landfalls: 10/5/3/1/1 → 0.5/0.25/0.15/0.05/0.05
    assert us["tropical"] == 0.5
    assert us["cat1"] == 0.25
    assert us["cat2"] == 0.15
    assert us["cat3"] == 0.05
    assert us["cat4+"] == 0.05


def test_fit_region_full_atlantic_default_matches_current_behaviour(tmp_path):
    """Default region (full_atlantic) is what the existing fitter
    already does — backward compatibility."""
    path = _synth_full_atlantic_parquet(tmp_path)
    full = fit_basin_frequencies_from_hurdat2(path)  # no region arg
    full_explicit = fit_basin_frequencies_from_hurdat2(path, region="full_atlantic")
    assert full == full_explicit


def test_fit_region_caribbean_only(tmp_path):
    path = _synth_full_atlantic_parquet(tmp_path)
    carib = fit_basin_frequencies_from_hurdat2(path, region="caribbean")
    assert abs(sum(carib.values()) - 1.0) < 1e-9
    # 10 Caribbean landfalls: 4/3/1/1/1 → 0.4/0.3/0.1/0.1/0.1
    assert carib["tropical"] == 0.4
    assert carib["cat1"] == 0.3
    assert carib["cat2"] == 0.1
    assert carib["cat3"] == 0.1
    assert carib["cat4+"] == 0.1


def test_fit_region_atlantic_canada_only(tmp_path):
    path = _synth_full_atlantic_parquet(tmp_path)
    can = fit_basin_frequencies_from_hurdat2(path, region="atlantic_canada")
    assert abs(sum(can.values()) - 1.0) < 1e-9
    # 4 Canadian landfalls all tropical
    assert can["tropical"] == 1.0


def test_fit_region_with_no_landfalls_raises(tmp_path):
    """Region filter producing zero landfalls — refuse rather than emit
    a zero distribution (silent failure mode)."""
    path = _synth_full_atlantic_parquet(tmp_path)
    # Override taxonomy: ask for Caribbean storms in a parquet that has
    # them but disable matching by passing a custom predicate (use unknown).
    with pytest.raises(ValueError):
        # Filter to a region with no landfalls in synthetic data — none
        # of the synthetic events are in Atlantic Canada below lat 44 or
        # outside the Nova-Scotia-region bbox. We use a synth where no
        # landfalls match by zeroing out the Canadian rows first:
        df = pd.read_parquet(path)
        df = df[~df.apply(lambda r: is_in_region(r["lat"], r["lon"], "atlantic_canada"), axis=1)]
        empty_path = path.parent / "no_canada.parquet"
        df.to_parquet(empty_path, index=False)
        fit_basin_frequencies_from_hurdat2(empty_path, region="atlantic_canada")


# ── log-likelihood acceptance ─────────────────────────────────────────────


def test_log_likelihood_helper_basic():
    """LL = Σ n_i · log(p_i)."""
    p = {"a": 0.5, "b": 0.5}
    n = {"a": 10, "b": 10}
    expected = 10 * math.log(0.5) + 10 * math.log(0.5)
    assert abs(log_likelihood_of_distribution(p, n) - expected) < 1e-9


def test_log_likelihood_helper_zero_prob_zero_count():
    """Zero count in zero-prob bucket contributes 0, doesn't crash."""
    p = {"a": 1.0, "b": 0.0}
    n = {"a": 5, "b": 0}
    assert log_likelihood_of_distribution(p, n) == 5 * math.log(1.0)


def test_log_likelihood_helper_zero_prob_with_count_is_neg_inf():
    """Non-zero count under a zero-prob bucket → −inf (model assigns
    zero probability to observed event; the model is rejected)."""
    p = {"a": 1.0, "b": 0.0}
    n = {"a": 5, "b": 1}
    assert log_likelihood_of_distribution(p, n) == float("-inf")


def test_full_atlantic_fit_within_10pct_of_us_baseline_on_full_holdout(tmp_path):
    """Plan acceptance criterion: refitting Saffir-Simpson frequencies
    on the full Atlantic basin produces a log-likelihood within ±10%
    of the US-Atlantic-only baseline on a common holdout (the full
    landfall set).

    This validates that the basin expansion doesn't materially distort
    the existing Phase 2 / AUDIT.4 calibration — Caribbean and Atlantic
    Canada landfalls are sparse enough that the bucket shape is
    dominated by the US contribution.
    """
    path = _synth_full_atlantic_parquet(tmp_path)
    us = fit_basin_frequencies_from_hurdat2(path, region="us_atlantic")
    full = fit_basin_frequencies_from_hurdat2(path, region="full_atlantic")

    # Use the full landfall counts as the common holdout.
    df = pd.read_parquet(path)
    L = df[df["record_identifier"] == "L"]
    counts: dict[str, int] = {b: 0 for b in BUCKET_WIND_RANGES}
    from ml.scenarios.importance import _bucket_for_mph, _KTS_TO_MPH
    for kts in L["max_wind_kts"]:
        b = _bucket_for_mph(float(kts) * _KTS_TO_MPH)
        if b is not None:
            counts[b] += 1

    ll_us = log_likelihood_of_distribution(us, counts)
    ll_full = log_likelihood_of_distribution(full, counts)

    # Both LLs are negative (log-probabilities sum). The full-basin fit
    # should be a STRICTLY-BETTER (less negative) model of the full
    # holdout (it was fitted on it!) — and the US-only baseline must
    # not be too distorted.
    assert ll_full >= ll_us, (
        f"full-basin fit ({ll_full}) should beat US-only ({ll_us}) on full data"
    )
    # ±10% tolerance: |ll_full - ll_us| / |ll_us| ≤ 0.10
    rel = abs(ll_full - ll_us) / abs(ll_us)
    assert rel <= 0.10, (
        f"full-basin vs US-baseline LL relative gap = {rel:.4f} exceeds 10%"
    )


def test_full_atlantic_fit_within_10pct_against_real_hurdat2():
    """Same acceptance criterion against the committed HURDAT2 parquet."""
    repo_root = Path(__file__).resolve().parents[2]
    parquet = repo_root / "artifacts" / "hurdat2" / "best_track.parquet"
    if not parquet.exists():
        pytest.skip("HURDAT2 parquet missing — run `python -m ml.scenarios.hurdat2 --refresh`")
    us = fit_basin_frequencies_from_hurdat2(parquet, region="us_atlantic")
    full = fit_basin_frequencies_from_hurdat2(parquet, region="full_atlantic")

    df = pd.read_parquet(parquet)
    L = df[df["record_identifier"] == "L"]
    counts: dict[str, int] = {b: 0 for b in BUCKET_WIND_RANGES}
    from ml.scenarios.importance import _bucket_for_mph, _KTS_TO_MPH
    for kts in L["max_wind_kts"]:
        b = _bucket_for_mph(float(kts) * _KTS_TO_MPH)
        if b is not None:
            counts[b] += 1

    ll_us = log_likelihood_of_distribution(us, counts)
    ll_full = log_likelihood_of_distribution(full, counts)

    rel = abs(ll_full - ll_us) / abs(ll_us)
    # Real HURDAT2: with 735 US / 241 Caribbean / 24 Canada landfalls
    # the US-only distribution is very close to the full-basin one
    # (the bucket shape is dominated by US).
    assert rel <= 0.10, (
        f"Real HURDAT2: full-basin vs US-baseline LL relative gap "
        f"= {rel:.4f} exceeds 10%"
    )
