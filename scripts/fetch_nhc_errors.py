"""AUDIT.3 Phase 1 — fetch + parse NHC OFCL forecast-error climatology.

The National Hurricane Center publishes its operational forecast
verification tabulations as fixed-width ASCII flat-files at:

    https://www.nhc.noaa.gov/verification/verify7.shtml

Two files cover the Atlantic basin for our purposes:

  - ``1989-present_OFCL_v_BCD5_ind_ATL_AC_errors.txt``
      Along-track + cross-track signed errors per forecast hour for
      the official forecast (OFCL) and the BCD5 climatology baseline.
  - ``1989-present_OFCL_v_BCD5_ind_ATL_TI_errors.txt``
      Total track (positive magnitude) + intensity (signed peak-wind)
      errors per forecast hour, same model pair.

File format (re-derived from inspection because the published format
PDF at https://www.nhc.noaa.gov/verification/pdfs/Error_Tabulation_File_Format.pdf
parses cleanly only with a real PDF reader):

  Lines 1-10:  free-text header (basin, period, model list, etc.)
  Line 11:     column header
  Lines 12+:   one row per (storm, valid-time) tuple

  Each data row contains, in order:
    [0]      Date/Time string ``DD-MM-YYYY/HH:MM:SS`` of the verifying
             best-track position.
    [1]      Storm ID ``ALxxYYYY`` (Atlantic basin, storm number, year).
    [2-11]   Per-forecast-hour verification weight at hours
             12/24/36/48/60/72/96/120/144/168.  ``0.00`` means no
             forecast was issued for that valid time at that lead;
             non-zero (typically 1.00, occasionally 0.33 when multiple
             forecasts averaged) means a forecast existed and was
             verified.
    [12-14]  Best-track Lat, Lon, peak-wind (kt) at the valid time.
    [15-58]  Eleven forecast hours (0/12/24/36/48/60/72/96/120/144/168)
             × four series:
               OFCL primary  (suffix ``A01`` or ``T01``)
               OFCL secondary (suffix ``C01`` or ``I01``)
               BCD5 primary  (suffix ``A02`` or ``T02``)
               BCD5 secondary (suffix ``C02`` or ``I02``)
             In the AC file primary=along-track, secondary=cross-track.
             In the TI file primary=total-track, secondary=intensity.

  Sentinel for missing data is ``-9999.0``.

What this script produces
-------------------------

Two committed artifacts:

  artifacts/nhc/track_error.json
    Per-forecast-hour OFCL cross-track + along-track signed-error std
    dev (σ, nm) over 1989-2024 and the 2020-2024 rolling sub-window,
    plus the empirical 67th percentile of the OFCL total-track error
    (which is the NHC "cone radius" by definition).  The published
    2026 Atlantic cone radii (sourced from
    https://www.nhc.noaa.gov/aboutcone.shtml, fit on 2021-2025) are
    included alongside the 2020-2024 numbers as a verification anchor.

  artifacts/nhc/intensity_error.json
    Per-forecast-hour OFCL signed intensity-error std dev (σ, kt) over
    the same two windows.

Raw source files are cached under ``artifacts/nhc/.cache/`` (gitignored).
SHA-256 of each source ``.zip`` is recorded in the JSON so reruns can
detect upstream file drift.

Run::

    python -m scripts.fetch_nhc_errors             # uses cache if present
    python -m scripts.fetch_nhc_errors --refresh   # force re-download

This is Phase 1 of AUDIT.3 per
``docs/scoping/audit-3-nhc-track-error-usgs-ned.md`` §4.  Phase 2 will
consume the JSON inside ``ml/scenarios/generate.py`` to drive Gaussian
perturbation of NHC seed tracks.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import io
import json
import logging
import zipfile
from pathlib import Path
from typing import Iterable, Mapping

import numpy as np
import requests

log = logging.getLogger(__name__)

# ── module-level constants ────────────────────────────────────────────────

BASE_URL = "https://www.nhc.noaa.gov/verification/errors/"
AC_FILE = "1989-present_OFCL_v_BCD5_ind_ATL_AC_errors.txt"
TI_FILE = "1989-present_OFCL_v_BCD5_ind_ATL_TI_errors.txt"

# Forecast hours present in the file.  The scoping doc only requires
# 12-120; we parse 144 and 168 as well so downstream consumers can
# inspect long-range errors without re-running the fetch.
FORECAST_HOURS_FULL = (12, 24, 36, 48, 60, 72, 96, 120, 144, 168)
FORECAST_HOURS_PRIMARY = (12, 24, 36, 48, 60, 72, 96, 120)

# Position of each forecast hour within the 11-element block
# (0, 12, 24, 36, 48, 60, 72, 96, 120, 144, 168).  Index 0 is the
# 000h (initial) slot which we discard — verification at lead 0
# is always zero by definition.
_HOUR_OFFSETS = {12: 1, 24: 2, 36: 3, 48: 4, 60: 5, 72: 6,
                 96: 7, 120: 8, 144: 9, 168: 10}

# Layout of the 59-column data row.  See module docstring.
_FLAG_SLICE = slice(2, 12)          # F012..F168 weights (unused here)
_COL_LAT = 12
_COL_LON = 13
_COL_WS = 14
_OFCL_PRIMARY_START = 15            # A01 (AC) or T01 (TI) — 11 cols
_OFCL_SECONDARY_START = 26          # C01 (AC) or I01 (TI) — 11 cols
# Indices 37-58 are the BCD5 baseline; we don't aggregate them.

_MISSING = -9999.0
_ROLLING_WINDOW_YEARS = 5           # NHC cone is fit on a 5-year window

# Published Atlantic cone radii (nm) for 2026, fit on 2021-2025 data.
# Source: https://www.nhc.noaa.gov/aboutcone.shtml (fetched 2026-05-24).
PUBLISHED_CONE_RADII_NM_2026 = {
    12: 25, 24: 39, 36: 49, 48: 62, 60: 77, 72: 95, 96: 134, 120: 200
}

# Repo-root-anchored cache layout.  ``scripts/fetch_nhc_errors.py`` is
# one directory deep, so parents[1] == repo root.
_REPO_ROOT = Path(__file__).resolve().parents[1]
NHC_DIR = _REPO_ROOT / "artifacts" / "nhc"
CACHE_DIR = NHC_DIR / ".cache"
TRACK_JSON = NHC_DIR / "track_error.json"
INTENSITY_JSON = NHC_DIR / "intensity_error.json"


# ── network + cache ───────────────────────────────────────────────────────

def _fetch_zip(filename: str, *, refresh: bool = False,
               timeout: int = 30) -> tuple[bytes, str]:
    """Return (zip_bytes, sha256) for ``filename``.

    On first call (or with ``refresh=True``) downloads from NHC and
    writes ``CACHE_DIR/filename.zip``.  Otherwise reads from cache.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{filename}.zip"
    if cache_path.exists() and not refresh:
        log.info("cache hit: %s", cache_path.relative_to(_REPO_ROOT))
        zip_bytes = cache_path.read_bytes()
    else:
        url = f"{BASE_URL}{filename}.zip"
        log.info("fetching %s", url)
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        zip_bytes = resp.content
        cache_path.write_bytes(zip_bytes)
    sha = hashlib.sha256(zip_bytes).hexdigest()
    return zip_bytes, sha


def _unzip_to_text(zip_bytes: bytes, expected_member: str) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        with zf.open(expected_member) as fh:
            return fh.read().decode("ascii")


# ── parser ────────────────────────────────────────────────────────────────

def parse_error_file(text: str) -> dict:
    """Parse the fixed-width OFCL error tabulation into a column dict.

    Returns a dict with keys ``year`` (ndarray int), ``primary`` and
    ``secondary`` each mapping forecast-hour → 1-D ndarray of signed
    OFCL errors (filtered to non-missing values).  Suffix interpretation
    is file-specific:
      - AC file: primary = along-track (nm), secondary = cross-track (nm)
      - TI file: primary = total track (nm, ≥0), secondary = intensity (kt)
    """
    lines = text.splitlines()
    # Skip the free-text header.  The column-header line starts with
    # 'Date/Time' — use it as an explicit gate rather than a fixed
    # line count so a future header rewrite doesn't break the parser.
    data_start = None
    for i, line in enumerate(lines):
        if line.lstrip().startswith("Date/Time"):
            data_start = i + 1
            break
    if data_start is None:
        raise ValueError("could not locate column header row")

    years: list[int] = []
    # Pre-allocate per-hour lists for both series; we'll filter after.
    primary_raw: dict[int, list[float]] = {h: [] for h in FORECAST_HOURS_FULL}
    secondary_raw: dict[int, list[float]] = {h: [] for h in FORECAST_HOURS_FULL}
    # Track row-year alignment so we can year-filter later.
    primary_years: dict[int, list[int]] = {h: [] for h in FORECAST_HOURS_FULL}
    secondary_years: dict[int, list[int]] = {h: [] for h in FORECAST_HOURS_FULL}

    for raw in lines[data_start:]:
        if not raw.strip():
            continue
        fields = raw.split()
        if len(fields) < 59:
            # Defensive: file is well-formed, but skip any partial tail rows.
            continue
        # STMID at fields[1] is e.g. 'AL022024' → year is the last 4 chars.
        try:
            year = int(fields[1][-4:])
        except ValueError:
            continue
        years.append(year)
        for hour, off in _HOUR_OFFSETS.items():
            p_val = float(fields[_OFCL_PRIMARY_START + off])
            s_val = float(fields[_OFCL_SECONDARY_START + off])
            if p_val != _MISSING:
                primary_raw[hour].append(p_val)
                primary_years[hour].append(year)
            if s_val != _MISSING:
                secondary_raw[hour].append(s_val)
                secondary_years[hour].append(year)

    return {
        "row_years": np.asarray(years, dtype=np.int32),
        "primary": {h: np.asarray(primary_raw[h], dtype=np.float64)
                    for h in FORECAST_HOURS_FULL},
        "primary_years": {h: np.asarray(primary_years[h], dtype=np.int32)
                          for h in FORECAST_HOURS_FULL},
        "secondary": {h: np.asarray(secondary_raw[h], dtype=np.float64)
                      for h in FORECAST_HOURS_FULL},
        "secondary_years": {h: np.asarray(secondary_years[h], dtype=np.int32)
                            for h in FORECAST_HOURS_FULL},
    }


# ── aggregation ───────────────────────────────────────────────────────────

def _window_mask(year_arr: np.ndarray, lo: int, hi: int) -> np.ndarray:
    """Inclusive year-range mask."""
    return (year_arr >= lo) & (year_arr <= hi)


def _stats_for_window(values: np.ndarray, years: np.ndarray,
                      lo: int, hi: int) -> dict:
    mask = _window_mask(years, lo, hi)
    sample = values[mask]
    if sample.size < 2:
        return {"n_cases": int(sample.size), "sigma": None,
                "mae": None, "p67": None}
    return {
        "n_cases": int(sample.size),
        # Sample std dev (ddof=1) of the signed errors.  For OFCL
        # which is approximately unbiased, this is close to the
        # RMS error.  We report sigma because that's what scenario
        # perturbation needs.
        "sigma": float(np.std(sample, ddof=1)),
        # Mean absolute error for cross-checking against
        # NHC-published MAE tables.
        "mae": float(np.mean(np.abs(sample))),
        # Empirical 67th percentile of |value| — this is the cone
        # construction quantile (used for total-track only, but
        # cheap to record for every series).
        "p67": float(np.percentile(np.abs(sample), 67)),
    }


def build_track_climatology(ac_parsed: Mapping[str, object]) -> dict:
    """Return the per-window track-error climatology for JSON serialization."""
    years = ac_parsed["primary_years"][FORECAST_HOURS_FULL[0]]  # type: ignore[index]
    # 5-year rolling window endpoint = most recent year in the data.
    end_year = int(np.max(years)) if years.size else _dt.date.today().year - 1
    start_year_rolling = end_year - _ROLLING_WINDOW_YEARS + 1

    full_start = int(np.min(years)) if years.size else 1989
    full_end = end_year

    out: dict = {
        "full_period": {"start_year": full_start, "end_year": full_end,
                        "by_hour": {}},
        "rolling_window": {"start_year": start_year_rolling,
                           "end_year": end_year, "by_hour": {}},
    }

    for hour in FORECAST_HOURS_PRIMARY:
        along = ac_parsed["primary"][hour]            # type: ignore[index]
        along_years = ac_parsed["primary_years"][hour]  # type: ignore[index]
        cross = ac_parsed["secondary"][hour]          # type: ignore[index]
        cross_years = ac_parsed["secondary_years"][hour]  # type: ignore[index]
        for label, (lo, hi) in (
            ("full_period", (full_start, full_end)),
            ("rolling_window", (start_year_rolling, end_year)),
        ):
            a = _stats_for_window(along, along_years, lo, hi)
            c = _stats_for_window(cross, cross_years, lo, hi)
            out[label]["by_hour"][str(hour)] = {
                "along_track_sigma_nm": a["sigma"],
                "along_track_mae_nm": a["mae"],
                "cross_track_sigma_nm": c["sigma"],
                "cross_track_mae_nm": c["mae"],
                "n_cases": c["n_cases"],
            }
    return out


def build_total_track_p67(ti_parsed: Mapping[str, object]) -> dict:
    """Per-hour 67th-percentile of the OFCL total-track error.

    By NHC's published definition this *is* the cone radius for that
    forecast hour, fit on the chosen period.
    """
    years = ti_parsed["primary_years"][FORECAST_HOURS_FULL[0]]  # type: ignore[index]
    end_year = int(np.max(years)) if years.size else _dt.date.today().year - 1
    start_year_rolling = end_year - _ROLLING_WINDOW_YEARS + 1
    out = {"rolling_window": {"start_year": start_year_rolling,
                              "end_year": end_year, "by_hour": {}}}
    for hour in FORECAST_HOURS_PRIMARY:
        totals = ti_parsed["primary"][hour]               # type: ignore[index]
        total_years = ti_parsed["primary_years"][hour]    # type: ignore[index]
        mask = _window_mask(total_years, start_year_rolling, end_year)
        sample = totals[mask]
        if sample.size < 2:
            out["rolling_window"]["by_hour"][str(hour)] = {
                "cone_radius_p67_nm": None, "n_cases": int(sample.size)}
        else:
            out["rolling_window"]["by_hour"][str(hour)] = {
                # Total-track error is already a positive magnitude;
                # np.percentile on the raw values is the cone definition.
                "cone_radius_p67_nm": float(np.percentile(sample, 67)),
                "n_cases": int(sample.size),
            }
    return out


def build_intensity_climatology(ti_parsed: Mapping[str, object]) -> dict:
    years = ti_parsed["secondary_years"][FORECAST_HOURS_FULL[0]]  # type: ignore[index]
    end_year = int(np.max(years)) if years.size else _dt.date.today().year - 1
    start_year_rolling = end_year - _ROLLING_WINDOW_YEARS + 1
    full_start = int(np.min(years)) if years.size else 1989
    full_end = end_year
    out: dict = {
        "full_period": {"start_year": full_start, "end_year": full_end,
                        "by_hour": {}},
        "rolling_window": {"start_year": start_year_rolling,
                           "end_year": end_year, "by_hour": {}},
    }
    for hour in FORECAST_HOURS_PRIMARY:
        intensity = ti_parsed["secondary"][hour]              # type: ignore[index]
        int_years = ti_parsed["secondary_years"][hour]        # type: ignore[index]
        for label, (lo, hi) in (
            ("full_period", (full_start, full_end)),
            ("rolling_window", (start_year_rolling, end_year)),
        ):
            s = _stats_for_window(intensity, int_years, lo, hi)
            out[label]["by_hour"][str(hour)] = {
                "peak_wind_sigma_kt": s["sigma"],
                "peak_wind_mae_kt": s["mae"],
                "n_cases": s["n_cases"],
            }
    return out


# ── orchestration ─────────────────────────────────────────────────────────

def fetch_and_build(*, refresh: bool = False) -> dict:
    """Download (or read cached) sources, parse, aggregate, and return
    the two JSON-ready payloads.  Network-dependent — tests should call
    the parser + builders directly using fixtures.
    """
    ac_bytes, ac_sha = _fetch_zip(AC_FILE, refresh=refresh)
    ti_bytes, ti_sha = _fetch_zip(TI_FILE, refresh=refresh)
    ac_text = _unzip_to_text(ac_bytes, AC_FILE)
    ti_text = _unzip_to_text(ti_bytes, TI_FILE)

    ac_parsed = parse_error_file(ac_text)
    ti_parsed = parse_error_file(ti_text)

    fetched_at = _dt.date.today().isoformat()
    common_source = {
        "url_base": BASE_URL,
        "ac_file": AC_FILE,
        "ti_file": TI_FILE,
        "ac_sha256": ac_sha,
        "ti_sha256": ti_sha,
        "fetched_at": fetched_at,
        "basin": "atlantic",
        "model": "OFCL",
        "data_format_doc": (
            "https://www.nhc.noaa.gov/verification/pdfs/"
            "Error_Tabulation_File_Format.pdf"),
        "cone_methodology_doc": "https://www.nhc.noaa.gov/aboutcone.shtml",
    }

    track_payload = {
        "source": {**common_source, "series": "along_track + cross_track"},
        "climatology": build_track_climatology(ac_parsed),
        "cone_radii_empirical": build_total_track_p67(ti_parsed)["rolling_window"],
        "cone_radii_published_2026_nm": PUBLISHED_CONE_RADII_NM_2026,
        "notes": (
            "Per-forecast-hour OFCL track-error climatology, parsed from "
            "the AC + TI tabulations published by NHC. `cross_track_sigma_nm` "
            "and `along_track_sigma_nm` are the sample standard deviations "
            "of the signed forecast error and feed Gaussian waypoint "
            "perturbation in `ml/scenarios/generate.py` (AUDIT.3 Phase 2). "
            "`cone_radii_empirical` is the 67th percentile of the OFCL "
            "total-track absolute error over the rolling 5-year window, "
            "matching the NHC cone-of-uncertainty construction. "
            "`cone_radii_published_2026_nm` is the public Atlantic cone "
            "table from https://www.nhc.noaa.gov/aboutcone.shtml (fit on "
            "2021-2025); use it to verify the empirical fit on rerun."),
    }

    intensity_payload = {
        "source": {**common_source, "series": "intensity (peak_wind_kt)"},
        "climatology": build_intensity_climatology(ti_parsed),
        "notes": (
            "Per-forecast-hour OFCL signed-intensity-error climatology. "
            "`peak_wind_sigma_kt` is the sample standard deviation and "
            "feeds Gaussian peak-wind perturbation in scenario generation. "
            "`peak_wind_mae_kt` is provided as a cross-check against NHC's "
            "annual published MAE numbers."),
    }
    return {"track": track_payload, "intensity": intensity_payload}


def write_artifacts(payloads: Mapping[str, dict]) -> None:
    NHC_DIR.mkdir(parents=True, exist_ok=True)
    TRACK_JSON.write_text(json.dumps(payloads["track"], indent=2,
                                     sort_keys=True) + "\n")
    INTENSITY_JSON.write_text(json.dumps(payloads["intensity"], indent=2,
                                         sort_keys=True) + "\n")
    log.info("wrote %s", TRACK_JSON.relative_to(_REPO_ROOT))
    log.info("wrote %s", INTENSITY_JSON.relative_to(_REPO_ROOT))


def _main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true",
                        help="Force re-download of source zips even when cached.")
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(level=getattr(logging, args.log_level),
                        format="%(asctime)s %(levelname)s %(message)s")
    payloads = fetch_and_build(refresh=args.refresh)
    write_artifacts(payloads)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
