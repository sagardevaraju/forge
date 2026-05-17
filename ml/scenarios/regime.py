"""Task P2.3 — AMO / ENSO regime labels for scenario conditioning.

Pulls monthly Atlantic Multidecadal Oscillation (AMO) and Oceanic Niño
Index (ONI) values from NOAA, caches them locally as parquet under
``artifacts/regime/``, and returns a small label dict that downstream
scenario generation (Tasks P2.4 / P2.5 / P2.10) can use to condition
Monte-Carlo draws on the prevailing climate regime.

P2.3 is **plumbing only** — the regime label is attached to scenario
metadata but does *not* yet alter the perturbation math.

Data sources
------------
* AMO monthly (ERSST.v5, NOAA NCEI)::

    https://www.ncei.noaa.gov/pub/data/cmb/ersst/v5/index/ersst.v5.amo.dat

  Three-column whitespace-delimited text ``year  month  ssta`` with a
  one-line header.  Sentinel for missing values is ``-99.99``.

  We use the NCEI ERSST source rather than the PSL Kaplan re-host
  (``psl.noaa.gov/data/correlation/amon.us.long.data``) because the
  Kaplan series stops being updated in 2023, while the ERSST.v5 series
  is current.

* ONI monthly (CPC re-hosted by PSL)::

    https://psl.noaa.gov/data/correlation/oni.data

  Fixed-width: one row per year, year column followed by 12 monthly
  values.  Sentinel is ``-99.9`` for not-yet-observed months and a
  ``-99.9`` repeated on a trailer line marks EOF.

Classification thresholds (NOAA convention)
-------------------------------------------
* AMO: ``warm`` if monthly index ≥ 0 else ``cold``.  (More rigorous is a
  13-month running mean; the boolean on raw monthly is the published
  CPC convention for quick labels and is sufficient for P2.3.)
* ENSO (ONI): ``nino`` if ≥ +0.5, ``nina`` if ≤ −0.5, else ``neutral``.

Cache policy
------------
First call writes ``artifacts/regime/amo.parquet`` and
``artifacts/regime/oni.parquet`` from the live URLs.  Subsequent calls
read from disk.  Pass ``force_refresh=True`` to invalidate.  The tests
ship a pre-populated cache so they run offline.

Regenerating the cache locally::

    python -m ml.scenarios.regime --refresh
"""

from __future__ import annotations

import argparse
import logging
from datetime import date as _date
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import requests

log = logging.getLogger(__name__)

# ── module-level constants ────────────────────────────────────────────────

AMO_URL = "https://www.ncei.noaa.gov/pub/data/cmb/ersst/v5/index/ersst.v5.amo.dat"
ONI_URL = "https://psl.noaa.gov/data/correlation/oni.data"

# NOAA sentinel values.  AMO uses -99.99; ONI uses -99.9.  We mask any
# value <= this threshold to be safe across both.
_SENTINEL_THRESHOLD = -99.0

# Repo-root-anchored cache directory.  ``ml/scenarios/regime.py`` is two
# directories deep, so parents[2] == repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = _REPO_ROOT / "artifacts" / "regime"
AMO_PARQUET = CACHE_DIR / "amo.parquet"
ONI_PARQUET = CACHE_DIR / "oni.parquet"

# Network timeout (seconds) for the one-shot live fetch.
_HTTP_TIMEOUT = 30

# In-process memoization so a hot loop doesn't keep round-tripping to disk.
_AMO_CACHE: pd.DataFrame | None = None
_ONI_CACHE: pd.DataFrame | None = None


# ── parsers ───────────────────────────────────────────────────────────────


def _parse_amo_text(text: str) -> pd.DataFrame:
    """Parse the NCEI ERSST AMO whitespace-delimited text dump.

    Returns a long-form DataFrame with columns ``year``, ``month``,
    ``value``.  Sentinel rows are dropped.
    """
    rows: list[tuple[int, int, float]] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 3:
            continue
        # Skip header line: "Year  month  SSTA".
        try:
            year = int(parts[0])
            month = int(parts[1])
            value = float(parts[2])
        except ValueError:
            continue
        if not (1 <= month <= 12) or year < 1800 or year > 2200:
            continue
        if value <= _SENTINEL_THRESHOLD:
            continue
        rows.append((year, month, value))
    if not rows:
        raise ValueError("No AMO rows parsed from NCEI dump")
    df = pd.DataFrame(rows, columns=["year", "month", "value"])
    return df.sort_values(["year", "month"], ignore_index=True)


def _parse_oni_text(text: str) -> pd.DataFrame:
    """Parse the PSL ONI fixed-width dump (year + 12 monthly values).

    Returns a long-form DataFrame with columns ``year``, ``month``,
    ``value``.  Sentinel cells are dropped.
    """
    rows: list[tuple[int, int, float]] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 13:
            # 1 year col + 12 months.  Header (``1950  2026``) is 2 cols
            # and the trailer (``-99.9``) is 1 col, both correctly skipped.
            continue
        try:
            year = int(parts[0])
            values = [float(p) for p in parts[1:]]
        except ValueError:
            continue
        if year < 1800 or year > 2200:
            continue
        for month, value in enumerate(values, start=1):
            if value <= _SENTINEL_THRESHOLD:
                continue
            rows.append((year, month, value))
    if not rows:
        raise ValueError("No ONI rows parsed from PSL dump")
    df = pd.DataFrame(rows, columns=["year", "month", "value"])
    return df.sort_values(["year", "month"], ignore_index=True)


# ── fetchers (separated so tests can monkeypatch) ────────────────────────


def _fetch_amo_data() -> pd.DataFrame:
    log.info("Fetching AMO monthly index from %s", AMO_URL)
    resp = requests.get(AMO_URL, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    return _parse_amo_text(resp.text)


def _fetch_oni_data() -> pd.DataFrame:
    log.info("Fetching ONI monthly index from %s", ONI_URL)
    resp = requests.get(ONI_URL, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    return _parse_oni_text(resp.text)


# ── cache helpers ─────────────────────────────────────────────────────────


def _ensure_cache_dir() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _load_or_fetch(
    cache_path: Path,
    fetcher,
    force_refresh: bool,
) -> pd.DataFrame:
    if cache_path.exists() and not force_refresh:
        return pd.read_parquet(cache_path)
    df = fetcher()
    _ensure_cache_dir()
    df.to_parquet(cache_path, index=False)
    return df


def _load_amo(force_refresh: bool = False) -> pd.DataFrame:
    global _AMO_CACHE
    if _AMO_CACHE is not None and not force_refresh:
        return _AMO_CACHE
    _AMO_CACHE = _load_or_fetch(AMO_PARQUET, _fetch_amo_data, force_refresh)
    return _AMO_CACHE


def _load_oni(force_refresh: bool = False) -> pd.DataFrame:
    global _ONI_CACHE
    if _ONI_CACHE is not None and not force_refresh:
        return _ONI_CACHE
    _ONI_CACHE = _load_or_fetch(ONI_PARQUET, _fetch_oni_data, force_refresh)
    return _ONI_CACHE


def _reset_cache_for_tests() -> None:
    """Forget the in-process memoized DataFrames (test-only helper)."""
    global _AMO_CACHE, _ONI_CACHE
    _AMO_CACHE = None
    _ONI_CACHE = None


# ── classification ────────────────────────────────────────────────────────


def _classify_amo(value: float) -> str:
    return "warm" if value >= 0.0 else "cold"


def _classify_enso(value: float) -> str:
    if value >= 0.5:
        return "nino"
    if value <= -0.5:
        return "nina"
    return "neutral"


def _lookup_value(df: pd.DataFrame, year: int, month: int) -> float:
    """Return the index value for ``(year, month)`` or fall back to the
    most recent month at-or-before that date.  Raises if no data exists
    on or before the requested month."""
    hit = df[(df["year"] == year) & (df["month"] == month)]
    if not hit.empty:
        return float(hit["value"].iloc[0])
    # Fall back to the most recent observed month at or before the
    # requested date.  This handles the AMO publication lag gracefully.
    earlier = df[(df["year"] < year) | ((df["year"] == year) & (df["month"] <= month))]
    if earlier.empty:
        raise ValueError(f"No regime data on or before {year}-{month:02d}")
    last = earlier.sort_values(["year", "month"]).iloc[-1]
    return float(last["value"])


# ── public API ────────────────────────────────────────────────────────────


def _coerce_date(date: str | _date | datetime) -> tuple[int, int]:
    if isinstance(date, datetime):
        return date.year, date.month
    if isinstance(date, _date):
        return date.year, date.month
    if isinstance(date, str):
        # Accept "YYYY-MM" or "YYYY-MM-DD".
        try:
            d = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            d = datetime.strptime(date, "%Y-%m").date()
        return d.year, d.month
    raise TypeError(f"Unsupported date type: {type(date)!r}")


def regime_label(
    date: str | _date | datetime,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Return the AMO/ENSO regime label for ``date``.

    Parameters
    ----------
    date:
        ``YYYY-MM-DD`` or ``YYYY-MM`` string, or a ``date``/``datetime``.
        The day is ignored; classification is by month.
    force_refresh:
        Bypass the on-disk parquet cache and re-fetch from NOAA.

    Returns
    -------
    dict
        ``{"amo_phase", "enso", "amo_value", "oni_value", "month"}``.
    """
    year, month = _coerce_date(date)

    amo_df = _load_amo(force_refresh=force_refresh)
    oni_df = _load_oni(force_refresh=force_refresh)

    amo_value = _lookup_value(amo_df, year, month)
    oni_value = _lookup_value(oni_df, year, month)

    return {
        "amo_phase": _classify_amo(amo_value),
        "enso": _classify_enso(oni_value),
        "amo_value": round(amo_value, 4),
        "oni_value": round(oni_value, 4),
        "month": f"{year:04d}-{month:02d}",
    }


# ── CLI entry-point ───────────────────────────────────────────────────────


def _main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Refresh AMO/ONI parquet cache and print a label.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force a live re-fetch from NOAA and overwrite the parquet cache.",
    )
    parser.add_argument(
        "--date",
        default=datetime.now().strftime("%Y-%m-%d"),
        help="Date to label (YYYY-MM-DD).  Defaults to today.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    out = regime_label(date=args.date, force_refresh=args.refresh)
    print(out)


if __name__ == "__main__":
    _main()


__all__ = [
    "AMO_URL",
    "ONI_URL",
    "AMO_PARQUET",
    "ONI_PARQUET",
    "regime_label",
]
