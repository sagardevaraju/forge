"""AUDIT.3 Phase 4 — compute the per-ZIP3 surge-input catalog from real data.

Replaces the hand-coded ``_COASTAL_ZIP3S`` literal in
``ml/scenarios/generate.py`` (~15 ZIP3s × 3 fields × hand-eyeballed
values, no provenance).  The new artifact at
``artifacts/coastal_zip3s.json`` holds the same shape
``{<zip3>: {lat, lon, elev_m, n_policies}}`` but every value is computed
from real public data:

  - ``lat`` and ``lon`` are the mean of all policy coordinates with
    that ZIP3 from the seeded book (synthetic *policy positions*, but
    consistent with the rest of FORGE's geography — see CLAUDE.md
    §"ZIP3 geography" / [[zip3-geography]]).
  - ``elev_m`` is the USGS NED 1/3-arcsec elevation at the centroid,
    fetched via the EPQS endpoint (shares the cache with
    ``scripts/extract_elevations.py``).
  - ``n_policies`` is the raw policy count, useful for downstream
    weighting.

Coastal-state criterion: ZIP3 belongs to a state in
``{FL, TX, LA, AL, MS, GA, SC, NC}`` AND has ≥ 50 policies in the
book (a meaningful exposure threshold).  Per the scoping doc §4
Phase 4, ZIP3-level aggregation stays for the surge calc but its
inputs are now reproducible from the data.

Run::

    python -m scripts.precompute_coastal_zip3s

Re-run whenever the policy book changes substantially (e.g., after a
new CSV upload), the same way ``precompute_portfolio_optimization.py``
gets re-run.  Artifact is committed.
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
from pathlib import Path
from typing import Iterable

import requests

from scripts.extract_elevations import fetch_elevation

log = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = _REPO_ROOT / "forge-local.db"
OUTPUT_JSON = _REPO_ROOT / "artifacts" / "coastal_zip3s.json"

# US Atlantic + Gulf coast hurricane-exposed states.  Mirrors the
# original ``_COASTAL_ZIP3S`` footprint (FL/TX/LA/AL/MS/GA/SC/NC) but
# without the hand-picked ZIP3-level cherry-picking; any ZIP3 in these
# states with meaningful book exposure now lands in the catalog.
_COASTAL_STATES = ("FL", "TX", "LA", "AL", "MS", "GA", "SC", "NC")

# Minimum book exposure for a ZIP3 to enter the catalog.  Anything
# below this is too low-N for a meaningful (lat, lon) centroid.
_MIN_POLICIES_PER_ZIP3 = 50


def _aggregate_centroids(conn: sqlite3.Connection) -> list[dict]:
    """Group policies by ZIP3 within coastal states, return mean lat/lon
    + count per ZIP3."""
    placeholders = ", ".join(["?"] * len(_COASTAL_STATES))
    sql = f"""
        SELECT zip3,
               AVG(lat) AS mean_lat,
               AVG(lon) AS mean_lon,
               COUNT(*) AS n
        FROM policies
        WHERE state IN ({placeholders})
          AND lat IS NOT NULL
          AND lon IS NOT NULL
        GROUP BY zip3
        HAVING n >= ?
        ORDER BY zip3
    """
    rows = conn.execute(sql, (*_COASTAL_STATES, _MIN_POLICIES_PER_ZIP3)
                        ).fetchall()
    return [
        {"zip3": str(z), "lat": float(la), "lon": float(lo),
         "n_policies": int(n)}
        for (z, la, lo, n) in rows
    ]


def _attach_elevations(entries: Iterable[dict], *, refresh: bool = False,
                       ) -> list[dict]:
    """For each ZIP3 centroid, hit USGS EPQS for the elevation.

    Reuses ``scripts/extract_elevations.fetch_elevation`` so it shares
    the ``artifacts/elevations/.cache/`` per-point cache — running
    Phase 3 before Phase 4 reuses every cached elevation already
    fetched for a policy at that exact centroid.
    """
    session = requests.Session()
    out: list[dict] = []
    for entry in entries:
        elev = fetch_elevation(
            entry["lat"], entry["lon"],
            refresh=refresh, session=session)
        out.append({**entry, "elev_m": elev})
    return out


def build_catalog(*, db_path: Path = DB_PATH,
                   refresh: bool = False) -> dict:
    if not db_path.exists():
        raise RuntimeError(
            f"DB not found at {db_path}; run `npm run migrate` and "
            f"`python scripts/seed_policy_book.py` first")
    conn = sqlite3.connect(db_path)
    try:
        centroids = _aggregate_centroids(conn)
    finally:
        conn.close()
    log.info("aggregated %d coastal ZIP3s from policy table", len(centroids))

    enriched = _attach_elevations(centroids, refresh=refresh)
    n_nodata = sum(1 for e in enriched if e["elev_m"] is None)
    if n_nodata:
        log.warning("%d ZIP3 centroids landed in EPQS no-data — usually "
                    "an offshore centroid", n_nodata)

    catalog: dict[str, dict] = {}
    for entry in enriched:
        # Skip ZIP3s where we couldn't get an elevation — the surge
        # calc downstream can't use NULL.
        if entry["elev_m"] is None:
            continue
        catalog[entry["zip3"]] = {
            "lat": round(entry["lat"], 6),
            "lon": round(entry["lon"], 6),
            "elev_m": round(entry["elev_m"], 2),
            "n_policies": entry["n_policies"],
        }

    return {
        "source": {
            "centroid": "AVG(lat,lon) over policies in coastal-state set",
            "elevation": "USGS EPQS at the ZIP3 centroid",
            "epqs_url": "https://epqs.nationalmap.gov/v1/json",
            "coastal_states": list(_COASTAL_STATES),
            "min_policies_per_zip3": _MIN_POLICIES_PER_ZIP3,
        },
        "n_zip3s": len(catalog),
        "catalog": catalog,
        "notes": (
            "Replaces the hand-coded _COASTAL_ZIP3S literal previously "
            "in ml/scenarios/generate.py.  Every (lat, lon, elev_m) "
            "value here is computed from real data (policy table + "
            "USGS NED).  Regenerate after any meaningful change to "
            "the policy book via "
            "`python -m scripts.precompute_coastal_zip3s`."),
    }


def write_artifact(catalog: dict, out_path: Path = OUTPUT_JSON) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(catalog, indent=2, sort_keys=True) + "\n")
    # ``relative_to`` raises if out_path lies outside the repo (which
    # is fine in tests using a tmp_path).  Log the absolute path then.
    try:
        log.info("wrote %s", out_path.relative_to(_REPO_ROOT))
    except ValueError:
        log.info("wrote %s", out_path)


def _main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true",
                        help="Ignore the EPQS cache; re-fetch every centroid.")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(level=getattr(logging, args.log_level),
                        format="%(asctime)s %(levelname)s %(message)s")

    catalog = build_catalog(db_path=args.db, refresh=args.refresh)
    write_artifact(catalog)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
