"""Task P2.10 — HURDAT2 best-track ingestion + track-PIT histogram.

NHC publishes the Atlantic basin best-track database (HURDAT2, 1851-
present) as a fixed-width ASCII flat-file at::

    https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2024-040425.txt

Each storm is introduced by a header row followed by N comma-separated
track rows at 6-hour spacing.  This module parses the dump, caches the
result as parquet under ``artifacts/hurdat2/best_track.parquet``, and
exposes:

* :func:`parse_hurdat2`           — live-fetch or load-from-cache
* :func:`parse_hurdat2_text`      — parse an in-memory text blob (tests)
* :func:`landfall_records`        — filter to record_identifier == 'L'
* :func:`track_pit_histogram`     — empirical PIT on track distances

P2.10 scope is **plumbing only**.  ``generate_scenarios`` gains a
``hurdat2_path`` kwarg that does not yet rewire the (state, peak-wind
bucket) log-likelihood.  Wiring the empirical track-PIT into scenario
weighting is a follow-up task (out of P2.10 scope) because the change
touches downstream IS-corrected TVaR / retained-tail consumers
(P2.6 / P2.7).

Cache policy
------------
First call fetches the live HURDAT2 file and writes parquet to
``artifacts/hurdat2/best_track.parquet``.  Subsequent calls read from
disk.  Pass ``force_refresh=True`` to invalidate.  The parquet artifact
is committed (small — Atlantic basin is ~3 MB parquet).

Regenerating the cache locally::

    python -m ml.scenarios.hurdat2 --refresh

Data source notes
-----------------
* Two record types in the flat-file:
    - **Header row** (3 fields):  ``AL092024, IDALIA, 73,``
    - **Track row** (21 fields):  ``YYYYMMDD, HHMM, <rid>, <status>,
      <lat>, <lon>, <wind_kts>, <pres_mb>``, then 12 wind-radii columns.

* Latitude/longitude come as e.g. ``25.0N`` / ``80.0W``.  We strip the
  hemisphere letter and negate longitudes in the western hemisphere
  (consistent with the rest of FORGE which uses signed decimal degrees).

* ``record_identifier`` slot is one of:
    ``L`` (landfall), ``W`` (max wind), ``P`` (min pressure),
    ``I`` (intensity peak), ``T`` (track-turn), ``G`` (genesis),
    ``S`` (subtropical → tropical transition), or blank.
"""

from __future__ import annotations

import argparse
import io
import logging
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import requests

log = logging.getLogger(__name__)

# ── module-level constants ────────────────────────────────────────────────

HURDAT2_URL = "https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2024-040425.txt"

# System-status codes worth keeping for the track-PIT signal.  TD
# (tropical depression) and EX / SS / LO are filtered out because they
# either do not carry meaningful peak-wind or represent non-tropical
# phases that distort the kernel density estimate.
_TROPICAL_STATUSES = {"TS", "HU"}

# Repo-root-anchored cache directory.  ``ml/scenarios/hurdat2.py`` is two
# directories deep, so parents[2] == repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = _REPO_ROOT / "artifacts" / "hurdat2"
BEST_TRACK_PARQUET = CACHE_DIR / "best_track.parquet"

# Network timeout (seconds) for the one-shot live fetch.
_HTTP_TIMEOUT = 60

# In-process memoization so a hot loop doesn't keep round-tripping to disk.
_BEST_TRACK_CACHE: pd.DataFrame | None = None


# ── parsers ───────────────────────────────────────────────────────────────


def _parse_lat(token: str) -> float:
    """Parse e.g. ``25.0N`` → +25.0 or ``10.5S`` → -10.5."""
    t = token.strip()
    if not t:
        raise ValueError("empty lat token")
    hemi = t[-1]
    val = float(t[:-1])
    if hemi == "S":
        val = -val
    elif hemi != "N":
        raise ValueError(f"unexpected lat hemisphere: {t!r}")
    return val


def _parse_lon(token: str) -> float:
    """Parse e.g. ``80.0W`` → -80.0 or ``10.0E`` → +10.0."""
    t = token.strip()
    if not t:
        raise ValueError("empty lon token")
    hemi = t[-1]
    val = float(t[:-1])
    if hemi == "W":
        val = -val
    elif hemi != "E":
        raise ValueError(f"unexpected lon hemisphere: {t!r}")
    return val


def _is_header_row(parts: list[str]) -> bool:
    """Header rows have exactly 4 comma-separated fields when split with
    a trailing-comma artefact (``AL062024, BERYL, 73,`` → 4 parts after
    naïve split).  Detect by storm-id pattern."""
    if not parts:
        return False
    first = parts[0].strip()
    # AL/EP basin prefix + 2-digit cyclone + 4-digit year = 8 chars.
    return len(first) == 8 and first[:2] in {"AL", "EP", "CP"} and first[2:].isdigit()


def parse_hurdat2_text(text: str) -> pd.DataFrame:
    """Parse a HURDAT2 flat-file blob into a long-form DataFrame.

    Returns
    -------
    pandas.DataFrame
        Columns: ``storm_id, name, timestamp, lat, lon, max_wind_kts,
        system_status, record_identifier``.  Track rows whose
        ``system_status`` is outside the tropical set (TS/HU) are
        dropped so the downstream kernel-density estimate isn't
        polluted by non-tropical phases.
    """
    rows: list[dict] = []
    current_id: str | None = None
    current_name: str | None = None

    for raw in text.splitlines():
        if not raw.strip():
            continue
        parts = [p.strip() for p in raw.split(",")]
        # Drop the trailing-comma artefact (last element is "").
        while parts and parts[-1] == "":
            parts.pop()
        if _is_header_row(parts):
            # Header: storm_id, name, n_records
            current_id = parts[0]
            current_name = parts[1] if len(parts) > 1 else ""
            continue
        # Track row needs at least 8 fields: date, time, rid, status,
        # lat, lon, wind, pres.
        if len(parts) < 8 or current_id is None:
            continue
        try:
            ts = datetime.strptime(parts[0] + parts[1], "%Y%m%d%H%M")
            record_id = parts[2]
            status = parts[3]
            lat = _parse_lat(parts[4])
            lon = _parse_lon(parts[5])
            wind = float(parts[6])
        except (ValueError, IndexError):
            continue
        # HURDAT2 sentinel for missing wind is -99.
        if wind < 0:
            continue
        if status not in _TROPICAL_STATUSES:
            continue
        rows.append(
            {
                "storm_id": current_id,
                "name": current_name or "",
                "timestamp": ts,
                "lat": lat,
                "lon": lon,
                "max_wind_kts": wind,
                "system_status": status,
                "record_identifier": record_id,
            }
        )

    if not rows:
        # Caller will see an empty frame with the right schema.
        return pd.DataFrame(
            columns=[
                "storm_id",
                "name",
                "timestamp",
                "lat",
                "lon",
                "max_wind_kts",
                "system_status",
                "record_identifier",
            ]
        )

    df = pd.DataFrame(rows)
    # Stable sort: storm_id, then time.
    df = df.sort_values(["storm_id", "timestamp"], ignore_index=True)
    return df


# ── fetchers (separated so tests can monkeypatch) ────────────────────────


def _fetch_hurdat2_text() -> str:
    log.info("Fetching HURDAT2 best-track file from %s", HURDAT2_URL)
    resp = requests.get(HURDAT2_URL, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.text


# ── cache helpers ─────────────────────────────────────────────────────────


def _ensure_cache_dir() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _reset_cache_for_tests() -> None:
    """Forget the in-process memoized DataFrame (test-only helper)."""
    global _BEST_TRACK_CACHE
    _BEST_TRACK_CACHE = None


def parse_hurdat2(
    path: Path | None = None,
    force_refresh: bool = False,
) -> pd.DataFrame:
    """Load HURDAT2 best-track data, caching to parquet on first call.

    Parameters
    ----------
    path:
        Override the parquet cache location.  Defaults to
        ``artifacts/hurdat2/best_track.parquet``.
    force_refresh:
        Bypass the on-disk parquet cache and re-fetch from NHC.

    Returns
    -------
    pandas.DataFrame
        Columns: ``storm_id, name, timestamp, lat, lon, max_wind_kts,
        system_status, record_identifier``.
    """
    global _BEST_TRACK_CACHE

    cache_path = path if path is not None else BEST_TRACK_PARQUET

    if _BEST_TRACK_CACHE is not None and not force_refresh and path is None:
        return _BEST_TRACK_CACHE

    if cache_path.exists() and not force_refresh:
        df = pd.read_parquet(cache_path)
        if path is None:
            _BEST_TRACK_CACHE = df
        return df

    text = _fetch_hurdat2_text()
    df = parse_hurdat2_text(text)
    _ensure_cache_dir()
    # parquet path may have been monkeypatched to a tmp dir; make sure
    # its parent exists too.
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(cache_path, index=False)
    if path is None:
        _BEST_TRACK_CACHE = df
    return df


def landfall_records(df: pd.DataFrame) -> pd.DataFrame:
    """Filter to rows where ``record_identifier == 'L'`` (landfall flag)."""
    return df[df["record_identifier"] == "L"].reset_index(drop=True)


# ── track PIT histogram ───────────────────────────────────────────────────


def _haversine_km(
    lat1: np.ndarray | float,
    lon1: np.ndarray | float,
    lat2: np.ndarray | float,
    lon2: np.ndarray | float,
) -> np.ndarray:
    """Great-circle distance (km).  Vectorised over numpy arrays."""
    r = 6371.0
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dphi = np.radians(np.asarray(lat2) - np.asarray(lat1))
    dlmb = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlmb / 2.0) ** 2
    return r * 2.0 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def track_pit_histogram(
    df: pd.DataFrame,
    forecast_track_lat: list[float],
    forecast_track_lon: list[float],
    bin_window_km: float = 100.0,
    n_bins: int = 10,
) -> list[int]:
    """Empirical PIT histogram of historical-track distances to a forecast.

    For each historical observation in ``df``, compute the minimum
    great-circle distance (km) to the forecast track and tally it into
    one of ``n_bins`` equal-width bins of width ``bin_window_km``.  The
    histogram is returned as a plain list[int] so it round-trips through
    JSON cleanly.

    Distances ≥ ``n_bins * bin_window_km`` are clipped into the last bin.

    Parameters
    ----------
    df:
        HURDAT2-shape DataFrame (must carry ``lat`` and ``lon`` columns).
    forecast_track_lat / forecast_track_lon:
        Per-waypoint forecast track coordinates.
    bin_window_km:
        Width of each distance bin (km).  Default 100 km.
    n_bins:
        Number of bins.  Default 10 → 0..1000 km range.

    Returns
    -------
    list[int]
        ``len(result) == n_bins``; integers summing to ``len(df)``.
    """
    if n_bins <= 0:
        raise ValueError("n_bins must be positive")
    if bin_window_km <= 0:
        raise ValueError("bin_window_km must be positive")
    if len(forecast_track_lat) != len(forecast_track_lon):
        raise ValueError("forecast_track_lat / _lon length mismatch")
    if not forecast_track_lat:
        raise ValueError("forecast_track is empty")

    if df.empty:
        return [0] * n_bins

    hist_lats = df["lat"].to_numpy(dtype=float)
    hist_lons = df["lon"].to_numpy(dtype=float)
    fc_lats = np.asarray(forecast_track_lat, dtype=float)
    fc_lons = np.asarray(forecast_track_lon, dtype=float)

    # For each (hist, fc) pair, compute distance, take per-hist minimum
    # across forecast waypoints.  Shape: (n_hist, n_fc).
    # Broadcast: hist_lats[:, None] vs fc_lats[None, :].
    dists = _haversine_km(
        hist_lats[:, None],
        hist_lons[:, None],
        fc_lats[None, :],
        fc_lons[None, :],
    )
    min_dists = dists.min(axis=1)  # shape (n_hist,)

    # Bin into 0..n_bins-1.  Clip last bin.
    idx = np.floor(min_dists / bin_window_km).astype(int)
    idx = np.clip(idx, 0, n_bins - 1)

    counts = np.bincount(idx, minlength=n_bins)[:n_bins]
    return counts.astype(int).tolist()


# ── CLI entry-point ───────────────────────────────────────────────────────


def _main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Refresh HURDAT2 parquet cache and print summary stats.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force a live re-fetch from NHC and overwrite the parquet cache.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    df = parse_hurdat2(force_refresh=args.refresh)
    print(f"HURDAT2 records: {len(df):,}")
    print(f"Storms:          {df['storm_id'].nunique():,}")
    if not df.empty:
        print(f"Date range:      {df['timestamp'].min()} → {df['timestamp'].max()}")
        print(f"Landfall flags:  {(df['record_identifier'] == 'L').sum():,}")


if __name__ == "__main__":
    _main()


__all__ = [
    "HURDAT2_URL",
    "CACHE_DIR",
    "BEST_TRACK_PARQUET",
    "parse_hurdat2",
    "parse_hurdat2_text",
    "landfall_records",
    "track_pit_histogram",
]
