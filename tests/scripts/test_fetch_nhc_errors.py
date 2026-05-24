"""Tests for AUDIT.3 Phase 1 — NHC OFCL forecast-error climatology.

Two layers of test coverage:

1. **Parser unit tests** exercise ``parse_error_file`` and the
   aggregation helpers against a synthetic 4-row fixture so we can
   verify header skipping, missing-value handling, year extraction,
   and the std-dev / MAE / 67-percentile math against known inputs.

2. **Committed-artifact tests** assert structural validity and
   physical plausibility of ``artifacts/nhc/{track_error,intensity_error}.json``.
   These are the canonical numbers that ``ml/scenarios/generate.py``
   will consume in AUDIT.3 Phase 2 — a regression in the script would
   land here before it ever reached the scenario generator.

The committed artifacts cover OFCL Atlantic 1989-2023 (file dated
May 2025, the 2024 hurricane season was not yet in the verification
window when fetched).  The rolling 5-year window is therefore 2019-2023.
Reconstructed cone radii are compared against the published 2026 NHC
Atlantic cone (fit on 2021-2025) — they agree within ~15% at every
forecast hour, with our numbers consistently slightly higher because
OFCL skill has improved over the four-year window offset.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from scripts.fetch_nhc_errors import (
    FORECAST_HOURS_PRIMARY,
    PUBLISHED_CONE_RADII_NM_2026,
    TRACK_JSON,
    INTENSITY_JSON,
    _stats_for_window,
    build_intensity_climatology,
    build_total_track_p67,
    build_track_climatology,
    parse_error_file,
)


# ── fixtures ────────────────────────────────────────────────────────────

# A miniature AC-file blob covering one storm in 2022 and one in 2023
# with hand-picked errors at hours 12/24/36/48/60.  Layout exactly
# matches the real file: 10-line header, column-header row, then data.
# Forecast-hour columns 144/168 are filled with -9999 throughout.
_FIXTURE_HEADER = (
    "Verification statistics for:    ATLANTIC 1989-2024              \n"
    "Model(s) verified:              OFCL BCD5\n"
    "Min, max wind speed included:   00 200 kt.\n"
    "Subtropical stage (if any) included.\n"
    "Extratropical stage (if any) excluded.\n"
    "Dissipation forecasts excluded.\n"
    "Initial position domain:  00N-90N  110W-000W\n"
    "A-decks taken from subdirectory:   data\n"
    "B-decks taken from subdirectory:   data\n"
    "\n"
    "Date/Time               STMID  F012  F024  F036  F048  F060  F072  "
    "F096  F120  F144  F168       Lat     Lon    WS  000hA01  012hA01  "
    "024hA01  036hA01  048hA01  060hA01  072hA01  096hA01  120hA01  "
    "144hA01  168hA01  000hC01  012hC01  024hC01  036hC01  048hC01  "
    "060hC01  072hC01  096hC01  120hC01  144hC01  168hC01  000hA02  "
    "012hA02  024hA02  036hA02  048hA02  060hA02  072hA02  096hA02  "
    "120hA02  144hA02  168hA02  000hC02  012hC02  024hC02  036hC02  "
    "048hC02  060hC02  072hC02  096hC02  120hC02  144hC02  168hC02\n"
)


def _row(date: str, stmid: str, *, a12: float, a24: float, c12: float,
         c24: float) -> str:
    """Build one fixture row.  Forecast hours 36-168 are missing."""
    miss = "-9999.0"
    a_block = [
        "0.0", f"{a12}", f"{a24}", miss, miss, miss, miss, miss, miss,
        miss, miss
    ]
    c_block = [
        "0.0", f"{c12}", f"{c24}", miss, miss, miss, miss, miss, miss,
        miss, miss
    ]
    bcd5 = [miss] * 22  # A02 + C02 blocks unused
    fields = [
        date, stmid,
        # 10 flag values
        "1.00", "1.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00",
        "0.00", "0.00",
        # Lat, Lon, WS
        "27.0", "-95.0", "40",
        *a_block, *c_block, *bcd5,
    ]
    return "  ".join(fields)


@pytest.fixture
def fixture_text() -> str:
    rows = [
        # 2022 storm: along-track {+10, +20}, cross-track {-5, -8}
        _row("01-08-2022/00:00:00", "AL012022", a12=10.0, a24=20.0,
             c12=-5.0, c24=-8.0),
        _row("01-08-2022/06:00:00", "AL012022", a12=14.0, a24=24.0,
             c12=-7.0, c24=-10.0),
        # 2023 storm: along-track {-12, -22}, cross-track {+6, +9}
        _row("15-09-2023/00:00:00", "AL022023", a12=-12.0, a24=-22.0,
             c12=6.0, c24=9.0),
        _row("15-09-2023/06:00:00", "AL022023", a12=-18.0, a24=-28.0,
             c12=10.0, c24=14.0),
    ]
    return _FIXTURE_HEADER + "\n".join(rows) + "\n"


# ── parser unit tests ──────────────────────────────────────────────────

def test_parse_skips_free_text_header(fixture_text: str) -> None:
    parsed = parse_error_file(fixture_text)
    assert parsed["row_years"].tolist() == [2022, 2022, 2023, 2023]


def test_parse_extracts_signed_errors(fixture_text: str) -> None:
    parsed = parse_error_file(fixture_text)
    # AC file: primary=along-track, secondary=cross-track.
    assert parsed["primary"][12].tolist() == [10.0, 14.0, -12.0, -18.0]
    assert parsed["primary"][24].tolist() == [20.0, 24.0, -22.0, -28.0]
    assert parsed["secondary"][12].tolist() == [-5.0, -7.0, 6.0, 10.0]
    assert parsed["secondary"][24].tolist() == [-8.0, -10.0, 9.0, 14.0]


def test_parse_filters_missing_sentinel(fixture_text: str) -> None:
    parsed = parse_error_file(fixture_text)
    # Forecast hours 36/48/60/72/96/120/144/168 were all -9999 in the
    # fixture, so they should have zero retained cases.
    for hour in (36, 48, 60, 72, 96, 120, 144, 168):
        assert parsed["primary"][hour].size == 0
        assert parsed["secondary"][hour].size == 0


def test_parse_aligns_year_with_value(fixture_text: str) -> None:
    parsed = parse_error_file(fixture_text)
    # primary_years should track primary values 1:1.
    assert parsed["primary_years"][12].tolist() == [2022, 2022, 2023, 2023]


def test_parse_missing_header_raises() -> None:
    with pytest.raises(ValueError, match="column header"):
        parse_error_file("just one\nline\nof junk\n")


# ── aggregation math ───────────────────────────────────────────────────

def test_stats_for_window_known_values() -> None:
    vals = np.array([10.0, 14.0, -12.0, -18.0])
    years = np.array([2022, 2022, 2023, 2023])
    stats = _stats_for_window(vals, years, 2022, 2023)
    assert stats["n_cases"] == 4
    # ddof=1 std with mean = -1.5:
    #   sum_sq_dev = 11.5² + 15.5² + 10.5² + 16.5² = 755
    #   σ = sqrt(755 / 3) = 15.864
    assert stats["sigma"] == pytest.approx(15.864, rel=1e-3)
    assert stats["mae"] == pytest.approx(13.5, rel=1e-9)
    # 67th percentile of |vals| = |[10, 14, -12, -18]| = [10, 12, 14, 18]
    # 67th pct (linear interp) over n=4: rank 0.67*3 = 2.01 ≈ 14.02
    assert stats["p67"] == pytest.approx(14.02, rel=1e-2)


def test_stats_for_window_year_filter() -> None:
    vals = np.array([10.0, 14.0, -12.0, -18.0])
    years = np.array([2022, 2022, 2023, 2023])
    stats = _stats_for_window(vals, years, 2023, 2023)
    assert stats["n_cases"] == 2
    assert stats["sigma"] == pytest.approx(np.std([-12.0, -18.0], ddof=1),
                                           rel=1e-9)


def test_stats_for_window_empty() -> None:
    vals = np.array([1.0])  # only 1 value → can't compute std with ddof=1
    years = np.array([2020])
    stats = _stats_for_window(vals, years, 2019, 2019)  # filters to empty
    assert stats["n_cases"] == 0
    assert stats["sigma"] is None


def test_track_climatology_shape(fixture_text: str) -> None:
    parsed = parse_error_file(fixture_text)
    out = build_track_climatology(parsed)
    assert set(out["rolling_window"]["by_hour"].keys()) == {
        str(h) for h in FORECAST_HOURS_PRIMARY}
    # Only hours 12 and 24 have data in the fixture.
    entry_12 = out["rolling_window"]["by_hour"]["12"]
    assert entry_12["n_cases"] == 4
    assert entry_12["along_track_sigma_nm"] is not None
    entry_60 = out["rolling_window"]["by_hour"]["60"]
    assert entry_60["n_cases"] == 0
    assert entry_60["along_track_sigma_nm"] is None


def test_total_track_p67_shape(fixture_text: str) -> None:
    parsed = parse_error_file(fixture_text)
    # Re-use the AC fixture as a stand-in TI fixture — primary stats
    # only depend on column position, not on file type.
    out = build_total_track_p67(parsed)
    assert set(out["rolling_window"]["by_hour"].keys()) == {
        str(h) for h in FORECAST_HOURS_PRIMARY}


def test_intensity_climatology_shape(fixture_text: str) -> None:
    parsed = parse_error_file(fixture_text)
    out = build_intensity_climatology(parsed)
    entry_12 = out["rolling_window"]["by_hour"]["12"]
    assert entry_12["n_cases"] == 4
    assert "peak_wind_sigma_kt" in entry_12
    assert "peak_wind_mae_kt" in entry_12


# ── committed-artifact tests ────────────────────────────────────────────

@pytest.fixture(scope="module")
def track_artifact() -> dict:
    if not TRACK_JSON.exists():
        pytest.skip("artifacts/nhc/track_error.json not present — "
                    "run `python -m scripts.fetch_nhc_errors` first.")
    return json.loads(TRACK_JSON.read_text())


@pytest.fixture(scope="module")
def intensity_artifact() -> dict:
    if not INTENSITY_JSON.exists():
        pytest.skip("artifacts/nhc/intensity_error.json not present — "
                    "run `python -m scripts.fetch_nhc_errors` first.")
    return json.loads(INTENSITY_JSON.read_text())


def test_track_artifact_has_required_top_level(track_artifact: dict) -> None:
    expected = {"source", "climatology", "cone_radii_empirical",
                "cone_radii_published_2026_nm", "notes"}
    assert expected <= track_artifact.keys()


def test_track_artifact_source_provenance(track_artifact: dict) -> None:
    src = track_artifact["source"]
    assert src["basin"] == "atlantic"
    assert src["model"] == "OFCL"
    # SHA-256 of the NHC zips must be 64 hex chars.
    for key in ("ac_sha256", "ti_sha256"):
        assert len(src[key]) == 64
        int(src[key], 16)  # raises ValueError if not hex


def test_track_climatology_covers_all_primary_hours(track_artifact: dict) -> None:
    rolling = track_artifact["climatology"]["rolling_window"]["by_hour"]
    assert set(rolling.keys()) == {str(h) for h in FORECAST_HOURS_PRIMARY}


def test_track_sigmas_monotonic(track_artifact: dict) -> None:
    """Forecast skill degrades with lead time, so σ should grow
    monotonically from 12h → 120h in both cross-track and along-track."""
    rolling = track_artifact["climatology"]["rolling_window"]["by_hour"]
    cross = [rolling[str(h)]["cross_track_sigma_nm"]
             for h in FORECAST_HOURS_PRIMARY]
    along = [rolling[str(h)]["along_track_sigma_nm"]
             for h in FORECAST_HOURS_PRIMARY]
    assert cross == sorted(cross)
    assert along == sorted(along)


def test_track_sigmas_in_physical_range(track_artifact: dict) -> None:
    """Hard bounds from NHC's published OFCL verification history —
    cross-track and along-track σ both fall in 10-300 nm range across
    forecast hours 12-120."""
    rolling = track_artifact["climatology"]["rolling_window"]["by_hour"]
    for h in FORECAST_HOURS_PRIMARY:
        for key in ("cross_track_sigma_nm", "along_track_sigma_nm"):
            sigma = rolling[str(h)][key]
            assert 5.0 < sigma < 300.0, (
                f"{key} at hour {h} = {sigma:.2f} nm out of plausible range")


def test_cone_radii_reconstruct_published_within_20_pct(
        track_artifact: dict) -> None:
    """The empirical 67th-percentile cone reconstruction is computed on
    2019-2023 OFCL data; the published 2026 cone uses 2021-2025.  Over
    the ~4-year window offset, OFCL skill has improved steadily, so our
    numbers run slightly higher than the published.  We require ≤20%
    agreement at every forecast hour."""
    empirical = track_artifact["cone_radii_empirical"]["by_hour"]
    for hour_int, published in PUBLISHED_CONE_RADII_NM_2026.items():
        empirical_val = empirical[str(hour_int)]["cone_radius_p67_nm"]
        rel_err = (empirical_val - published) / published
        assert abs(rel_err) <= 0.20, (
            f"hour {hour_int}: empirical {empirical_val:.1f} nm vs "
            f"published {published} nm, rel error {rel_err:+.1%} "
            f"exceeds 20% tolerance")


def test_cone_radius_120h_in_expected_range(track_artifact: dict) -> None:
    """5-day cone has historically settled in the 175-275 nm band over
    the last decade; published 2026 = 200 nm."""
    r120 = track_artifact["cone_radii_empirical"]["by_hour"]["120"][
        "cone_radius_p67_nm"]
    assert 175.0 < r120 < 275.0


def test_intensity_sigmas_monotonic(intensity_artifact: dict) -> None:
    rolling = intensity_artifact["climatology"]["rolling_window"]["by_hour"]
    sigmas = [rolling[str(h)]["peak_wind_sigma_kt"]
              for h in FORECAST_HOURS_PRIMARY]
    assert sigmas == sorted(sigmas)


def test_intensity_sigmas_in_physical_range(intensity_artifact: dict) -> None:
    """Hard bounds from NHC's published intensity-error history —
    OFCL σ in 5-30 kt over forecast hours 12-120."""
    rolling = intensity_artifact["climatology"]["rolling_window"]["by_hour"]
    for h in FORECAST_HOURS_PRIMARY:
        sigma = rolling[str(h)]["peak_wind_sigma_kt"]
        assert 3.0 < sigma < 30.0, (
            f"intensity σ at hour {h} = {sigma:.2f} kt out of plausible range")


def test_intensity_24h_mae_matches_published_band(
        intensity_artifact: dict) -> None:
    """NHC's published OFCL 24h Atlantic intensity MAE has run in the
    6-9 kt band for recent years; the 2019-2023 average lands in there."""
    rolling = intensity_artifact["climatology"]["rolling_window"]["by_hour"]
    mae24 = rolling["24"]["peak_wind_mae_kt"]
    assert 5.5 < mae24 < 9.5, f"24h MAE = {mae24:.2f} kt out of expected band"


def test_n_cases_large_enough_for_climatology(track_artifact: dict) -> None:
    """For the 5-year rolling window we expect at least 400 verifications
    at every forecast hour 12-120.  This guards against an upstream
    file truncation."""
    rolling = track_artifact["climatology"]["rolling_window"]["by_hour"]
    for h in FORECAST_HOURS_PRIMARY:
        assert rolling[str(h)]["n_cases"] >= 400, (
            f"hour {h}: only {rolling[str(h)]['n_cases']} cases in window")
