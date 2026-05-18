"""Task P2.10 — HURDAT2 best-track ingestion + track-PIT histogram tests.

The tests run offline using a small canned HURDAT2 snippet plus the
cached parquet artifact under ``artifacts/hurdat2/`` when present
(committed to the repo, regenerable via
``python -m ml.scenarios.hurdat2 --refresh``).
"""

from __future__ import annotations

from pathlib import Path

import pytest


ARTIFACT_DIR = Path(__file__).resolve().parents[2] / "artifacts" / "hurdat2"
BEST_TRACK_CACHE = ARTIFACT_DIR / "best_track.parquet"


# A canned 3-storm HURDAT2 fixture.  Two header rows + their tracks, mixed
# with a Tropical Depression (status TD) and a landfall row (record_id L)
# so the parser + landfall filter tests get the variety they need.
#
# Format (per NHC HURDAT2 documentation):
#   header:  AL,CY,YYYY, <NAME>, <n_records>,
#   track row: YYYYMMDD, HHMM, <record_id>, <status>, <lat>N/S, <lon>W/E,
#              <wind_kts>, <pres_mb>, then 12 wind-radii columns.
_HURDAT2_FIXTURE = """\
AL011900,         UNNAMED, 4,
19000601, 0000,  , TS, 25.0N,  80.0W,  40, 1000,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
19000601, 0600,  , TS, 25.5N,  80.5W,  45,  998,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
19000601, 1200, L, HU, 26.0N,  81.0W,  70,  985,   60,   40,   40,   60,    0,    0,    0,    0,    0,    0,    0,    0,
19000601, 1800,  , HU, 26.5N,  81.5W,  65,  990,   50,   30,   30,   50,    0,    0,    0,    0,    0,    0,    0,    0,
AL022000,           ALPHA, 3,
20000801, 0000,  , TD, 20.0N,  60.0W,  30, 1005,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
20000801, 0600,  , TS, 20.5N,  60.5W,  40, 1000,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
20000801, 1200,  , TS, 21.0N,  61.0W,  45,  998,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
AL032010,           BRAVO, 3,
20100901, 0000,  , HU, 28.0N,  88.0W,  80,  975,   70,   50,   50,   70,    0,    0,    0,    0,    0,    0,    0,    0,
20100901, 0600,  , HU, 28.5N,  88.5W,  90,  965,   80,   60,   60,   80,    0,    0,    0,    0,    0,    0,    0,    0,
20100901, 1200, L, HU, 29.0N,  89.0W,  95,  960,   90,   60,   60,   90,    0,    0,    0,    0,    0,    0,    0,    0,
"""


# ── plan-mandated tests ───────────────────────────────────────────────────


def test_parser_correctness(tmp_path):
    """Parses the canned 3-storm fixture; assert columns, types, row count."""
    from ml.scenarios.hurdat2 import parse_hurdat2_text

    df = parse_hurdat2_text(_HURDAT2_FIXTURE)

    # Expected columns.
    expected_cols = {
        "storm_id",
        "name",
        "timestamp",
        "lat",
        "lon",
        "max_wind_kts",
        "system_status",
        "record_identifier",
    }
    assert expected_cols.issubset(set(df.columns)), f"missing cols: {expected_cols - set(df.columns)}"

    # 4 + 3 + 3 = 10 raw track rows across 3 storms; the parser drops the
    # single TD row (Tropical Depression filtered out of the kernel-density
    # estimate per design), leaving 9 retained.
    assert len(df) == 9

    # Types & sentinel content.
    assert df["storm_id"].dtype == object
    assert df["max_wind_kts"].dtype.kind in "if"
    assert df["lat"].between(-90, 90).all()
    assert df["lon"].between(-180, 180).all()

    # Storm names + ids parsed correctly.
    assert set(df["storm_id"].unique()) == {"AL011900", "AL022000", "AL032010"}
    assert "BRAVO" in set(df["name"].unique())

    # Western hemisphere → negative longitudes.
    assert (df["lon"] < 0).all()


def test_cache_reuse(tmp_path, monkeypatch):
    """Second parse_hurdat2() call must hit cache, not fetch."""
    from ml.scenarios import hurdat2

    # Redirect cache to a fresh tmp dir.
    cache_path = tmp_path / "best_track.parquet"
    monkeypatch.setattr(hurdat2, "BEST_TRACK_PARQUET", cache_path)
    monkeypatch.setattr(hurdat2, "CACHE_DIR", tmp_path)
    hurdat2._reset_cache_for_tests()

    fetch_calls = {"n": 0}

    def _fetch_once() -> str:
        fetch_calls["n"] += 1
        if fetch_calls["n"] > 1:
            raise RuntimeError("network fetch must not be called when parquet exists")
        return _HURDAT2_FIXTURE

    monkeypatch.setattr(hurdat2, "_fetch_hurdat2_text", _fetch_once)

    df1 = hurdat2.parse_hurdat2()
    # In-process memo must not mask the disk-cache test → reset to force load.
    hurdat2._reset_cache_for_tests()
    df2 = hurdat2.parse_hurdat2()

    assert len(df1) == len(df2) == 9
    assert fetch_calls["n"] == 1


def test_landfall_filter():
    """landfall_records() returns only L-flagged rows."""
    from ml.scenarios.hurdat2 import landfall_records, parse_hurdat2_text

    df = parse_hurdat2_text(_HURDAT2_FIXTURE)
    lf = landfall_records(df)

    # Two landfall rows in the fixture (storms AL011900 and AL032010).
    assert len(lf) == 2
    assert (lf["record_identifier"] == "L").all()
    assert set(lf["storm_id"].unique()) == {"AL011900", "AL032010"}


def test_track_pit_correctness():
    """For a synthetic dataset where all historical tracks lie ~50 km from
    the forecast, the PIT distribution must be sharply peaked around the
    50 km bin."""
    import numpy as np
    import pandas as pd

    from ml.scenarios.hurdat2 import track_pit_histogram

    # Build a synthetic HURDAT2-shape DataFrame: many historical track
    # points all sitting ~50 km north of a reference forecast point.
    # 1° lat ≈ 111 km, so ~0.45° offset ≈ 50 km.
    rng = np.random.default_rng(42)
    n = 200
    df = pd.DataFrame(
        {
            "storm_id": [f"AL{i:02d}1900" for i in range(n)],
            "name": ["TEST"] * n,
            "timestamp": pd.date_range("1900-01-01", periods=n, freq="6h"),
            # All points ~50 km north of (25.0, -80.0) with tiny jitter.
            "lat": 25.0 + 0.450 + rng.normal(0.0, 0.005, size=n),
            "lon": -80.0 + rng.normal(0.0, 0.005, size=n),
            "max_wind_kts": rng.uniform(60.0, 100.0, size=n),
            "system_status": ["HU"] * n,
            "record_identifier": [""] * n,
        }
    )

    # Single-point forecast at (25.0, -80.0).  Bin width 20 km, 10 bins
    # → range 0..200 km.  The 50 km observation must land in bin 2
    # (40-60 km) and dominate.
    hist = track_pit_histogram(
        df,
        forecast_track_lat=[25.0],
        forecast_track_lon=[-80.0],
        bin_window_km=20.0,
        n_bins=10,
    )

    assert len(hist) == 10
    # The dominant bin index should be 2 (40-60 km).
    dominant = max(range(len(hist)), key=lambda i: hist[i])
    assert dominant == 2, f"expected dominant bin 2, got {dominant} (hist={hist})"
    # That bin should hold the lion's share (≥ 80%) of observations.
    assert hist[dominant] >= 0.8 * sum(hist), f"not sharply peaked: {hist}"


def test_generate_scenarios_accepts_hurdat2_path(tmp_path):
    """generate_scenarios accepts a hurdat2_path kwarg as plumbing — must
    not crash, and the kwarg must be optional (default None)."""
    from ml.scenarios.generate import generate_scenarios

    # Bare call without the kwarg still works.
    bare = generate_scenarios(storm_id="AL092024", n=4)
    assert len(bare) == 4

    # With a non-existent path — plumbing only, no consumer wired.
    scs = generate_scenarios(
        storm_id="AL092024",
        n=4,
        hurdat2_path=tmp_path / "does_not_exist.parquet",
    )
    assert len(scs) == 4
    # Scenario shape unchanged.
    for s in scs:
        assert "path" in s
        assert "peak_wind" in s


# ── live-cache spot check (only runs if the committed parquet exists) ─────


@pytest.mark.skipif(not BEST_TRACK_CACHE.exists(), reason="hurdat2 cache not seeded")
def test_committed_cache_has_modern_atlantic_storms():
    """When the live cache is committed, sanity-check it carries real
    Atlantic basin records covering multiple decades."""
    from ml.scenarios import hurdat2

    # Reset module-level memoization in case a prior test populated it
    # with a synthetic fixture; pass the canonical artifact path
    # explicitly so a monkeypatched module constant can't shadow it.
    hurdat2._reset_cache_for_tests()
    df = hurdat2.parse_hurdat2(path=BEST_TRACK_CACHE)

    # Full Atlantic basin (1851-present) is ~35k track records.
    assert len(df) >= 10_000
    assert "max_wind_kts" in df.columns
    # Must span more than one decade.
    years = df["timestamp"].dt.year
    assert years.max() - years.min() > 50
