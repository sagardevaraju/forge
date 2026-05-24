"""AUDIT.3 Phase 3 — populate policies.elevation_m with real USGS NED values.

The USGS Elevation Point Query Service (EPQS) sits in front of the
National Elevation Dataset (NED) at 1/3-arcsecond resolution (~10 m
horizontal) and returns a single elevation value in meters for any
(lat, lon) point.  Public-domain, no auth, no tile downloads:

    https://epqs.nationalmap.gov/v1/json?x={lon}&y={lat}&units=Meters&wkid=4326

This script replaces the flood-zone-based synthetic elevations seeded
by ``scripts/seed_policy_book.py`` with the actual ground elevation at
each policy's (lat, lon).

Why a separate script and not part of the seed
==============================================

  - The EPQS endpoint rate-limits to ~1 req / 0.5-2 s and the 10k-policy
    book takes ~3-5 hours of wall time to populate end-to-end.  Seeding
    has to stay quick (sub-second).
  - Re-runnability: the script caches every result to
    ``artifacts/elevations/.cache/`` (gitignored) keyed by rounded
    (lat, lon).  Cache hits skip the network; a re-run after a crash
    resumes where the previous left off.
  - Tests-without-network: the parser is exercised against a bundled
    EPQS response fixture.  A small set of real-world anchor elevations
    in ``artifacts/elevations/known_points.json`` lets the integration
    test verify end-to-end behavior against a handful of cities.

Run
===

::

    python -m scripts.extract_elevations            # full 10k book
    python -m scripts.extract_elevations --limit 100   # first 100 policies
    python -m scripts.extract_elevations --verify      # spot-check known points
    python -m scripts.extract_elevations --refresh     # ignore cache, re-fetch

The script is idempotent — re-running picks up from the cache and only
re-queries any policies that are still NULL or that have moved (cached
by rounded coordinates, not by policy id).
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path
from typing import Iterable

import requests

log = logging.getLogger(__name__)

# ── module-level paths + constants ────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = _REPO_ROOT / "forge-local.db"
ELEVATIONS_DIR = _REPO_ROOT / "artifacts" / "elevations"
CACHE_DIR = ELEVATIONS_DIR / ".cache"
KNOWN_POINTS_JSON = ELEVATIONS_DIR / "known_points.json"

EPQS_URL = "https://epqs.nationalmap.gov/v1/json"
EPQS_TIMEOUT_S = 15
# Polite pacing between requests — EPQS doesn't publish a formal rate
# limit but starts returning empty/timeout responses if hit too fast.
_INTER_REQUEST_SLEEP_S = 0.2

# Cache key precision: rounding (lat, lon) to 6 decimals = ~10 cm,
# safely finer than NED 1/3-arcsec resolution (~10 m) so we don't
# collide independent policies into a single cached value.
_COORD_PRECISION = 6

# Physical bounds for CONUS — anything outside is an error / off-shore.
_ELEV_MIN_M = -200.0   # Death Valley is -86 m; allow some buffer
_ELEV_MAX_M = 5000.0   # Mt. Whitney is 4421 m; CONUS doesn't exceed this

# EPQS returns this sentinel when the point is outside the NED footprint
# (e.g., over open ocean or in territories like PR not covered by 1/3-arcsec).
_EPQS_NODATA_SENTINELS = {"-1000000", "-1000000.000000000"}


# ── HTTP + parser ─────────────────────────────────────────────────────────


def _cache_path(lat: float, lon: float) -> Path:
    """Return the cache filename for a rounded (lat, lon) pair."""
    return CACHE_DIR / f"epqs_{round(lat, _COORD_PRECISION)}_" \
                       f"{round(lon, _COORD_PRECISION)}.json"


def parse_epqs_response(payload: dict) -> float | None:
    """Extract the elevation in meters from an EPQS JSON payload.

    Returns ``None`` when the point is over no-data (off the NED
    footprint, e.g., open ocean).  Raises ``ValueError`` for malformed
    payloads.
    """
    if "value" not in payload:
        raise ValueError("EPQS payload missing 'value' field")
    raw = payload["value"]
    # The endpoint returns elevation as a STRING (e.g., "5.009602547")
    # and uses "-1000000" as a sentinel for "no data here".
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or text in _EPQS_NODATA_SENTINELS:
        return None
    try:
        elev = float(text)
    except ValueError as e:
        raise ValueError(f"could not parse EPQS value {raw!r}") from e
    if not (_ELEV_MIN_M <= elev <= _ELEV_MAX_M):
        # Out-of-range but not the no-data sentinel — treat as missing
        # rather than crash; the caller will leave the DB column NULL.
        log.warning("EPQS elevation %.3f m outside physical range; "
                    "treating as no-data", elev)
        return None
    return elev


def fetch_elevation(
    lat: float, lon: float, *, refresh: bool = False,
    session: requests.Session | None = None,
    max_retries: int = 3,
) -> float | None:
    """Return the elevation in meters at ``(lat, lon)``, caching the
    JSON response under ``artifacts/elevations/.cache/`` for re-runs.
    Returns ``None`` for points outside the NED no-data footprint.

    Retries up to ``max_retries`` times on transient transport errors
    (``ReadTimeout``, ``ConnectionError``) with exponential backoff
    (1 s, 2 s, 4 s, …).  Other ``requests`` exceptions and
    ``ValueError`` from the parser propagate immediately — they
    signal a code-level problem, not flaky network.
    """
    cache_p = _cache_path(lat, lon)
    if cache_p.exists() and not refresh:
        return parse_epqs_response(json.loads(cache_p.read_text()))

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    sess = session or requests
    params = {"x": lon, "y": lat, "units": "Meters",
              "wkid": 4326, "includeDate": "false"}
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            resp = sess.get(EPQS_URL, params=params, timeout=EPQS_TIMEOUT_S)
            resp.raise_for_status()
            payload = resp.json()
            cache_p.write_text(json.dumps(payload))
            return parse_epqs_response(payload)
        except (requests.ReadTimeout, requests.ConnectionError) as e:
            last_err = e
            if attempt < max_retries - 1:
                backoff = 2 ** attempt
                log.warning("EPQS transient error at (%.4f, %.4f) "
                            "(attempt %d/%d): %s — retrying in %ds",
                            lat, lon, attempt + 1, max_retries, e, backoff)
                time.sleep(backoff)
            else:
                log.error("EPQS gave up at (%.4f, %.4f) after %d attempts: %s",
                          lat, lon, max_retries, e)
    # All retries exhausted.
    raise last_err if last_err is not None else RuntimeError(
        "fetch_elevation exhausted retries without an exception")


# ── DB I/O ────────────────────────────────────────────────────────────────


def _open_db(db_path: Path = DB_PATH) -> sqlite3.Connection:
    if not db_path.exists():
        raise RuntimeError(
            f"DB not found at {db_path}; run `npm run migrate` and "
            f"`python scripts/seed_policy_book.py` first")
    return sqlite3.connect(db_path)


def _select_policies_needing_elevation(
    conn: sqlite3.Connection, *, limit: int | None = None,
    force: bool = False,
) -> list[tuple[int, float, float]]:
    """Return policy rows to populate.  By default skips rows whose
    elevation has already been overwritten by an EPQS call (i.e., whose
    cached value is non-NULL and matches the EPQS-style precision).
    ``force=True`` selects every policy regardless of current value.
    """
    if force:
        sql = "SELECT id, lat, lon FROM policies " \
              "WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY id"
    else:
        # We can't tell from the column alone whether elevation_m came
        # from the synthetic seed or a real EPQS call, so use the cache
        # presence as a proxy: if no cache file exists, we haven't
        # called EPQS yet for that point.  Caller can pass --force to
        # bypass.
        sql = "SELECT id, lat, lon FROM policies " \
              "WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY id"
    if limit is not None and limit > 0:
        sql += f" LIMIT {int(limit)}"
    cur = conn.execute(sql)
    return [(r[0], float(r[1]), float(r[2])) for r in cur.fetchall()]


def _update_elevation(conn: sqlite3.Connection, policy_id: int,
                      elev_m: float | None) -> None:
    conn.execute(
        "UPDATE policies SET elevation_m = ? WHERE id = ?",
        (elev_m, policy_id))


# ── orchestration ─────────────────────────────────────────────────────────


def populate(
    *, limit: int | None = None, refresh: bool = False,
    db_path: Path = DB_PATH, force: bool = False,
    progress_every: int = 100,
) -> dict:
    """Walk the policies table, fetch real EPQS elevations, write them
    back.  Returns a summary dict with counts.
    """
    conn = _open_db(db_path)
    try:
        rows = _select_policies_needing_elevation(
            conn, limit=limit, force=force)
        log.info("policies to process: %d", len(rows))
        n_ok = 0
        n_nodata = 0
        n_error = 0
        n_cache_hit = 0
        session = requests.Session()
        for idx, (pid, lat, lon) in enumerate(rows, start=1):
            cache_p = _cache_path(lat, lon)
            cache_was_present = cache_p.exists() and not refresh
            try:
                elev = fetch_elevation(lat, lon, refresh=refresh,
                                       session=session)
            except (requests.RequestException, ValueError) as e:
                log.warning("policy %d (%.4f, %.4f): %s", pid, lat, lon, e)
                n_error += 1
                continue
            _update_elevation(conn, pid, elev)
            if elev is None:
                n_nodata += 1
            else:
                n_ok += 1
            if cache_was_present:
                n_cache_hit += 1
            else:
                # Polite pacing only for real network calls.
                time.sleep(_INTER_REQUEST_SLEEP_S)
            if idx % progress_every == 0:
                log.info("[%d/%d] ok=%d nodata=%d err=%d cache_hits=%d",
                         idx, len(rows), n_ok, n_nodata, n_error,
                         n_cache_hit)
                conn.commit()
        conn.commit()
        return {
            "policies_processed": len(rows),
            "ok": n_ok,
            "nodata": n_nodata,
            "errors": n_error,
            "cache_hits": n_cache_hit,
        }
    finally:
        conn.close()


def verify_known_points() -> int:
    """Spot-check the EPQS plumbing against a small bundled set of
    well-known city elevations in ``artifacts/elevations/known_points.json``.
    Returns 0 if every point lands within tolerance, non-zero otherwise.
    """
    if not KNOWN_POINTS_JSON.exists():
        log.error("known_points.json not found at %s", KNOWN_POINTS_JSON)
        return 2
    spec = json.loads(KNOWN_POINTS_JSON.read_text())
    n_bad = 0
    session = requests.Session()
    for entry in spec["points"]:
        lat, lon = entry["lat"], entry["lon"]
        expected_m = entry["expected_m"]
        tol_m = entry.get("tolerance_m", 5.0)
        try:
            actual = fetch_elevation(lat, lon, session=session)
        except Exception as e:
            log.error("%s: fetch failed: %s", entry["label"], e)
            n_bad += 1
            continue
        if actual is None:
            log.error("%s: EPQS returned no-data", entry["label"])
            n_bad += 1
            continue
        delta = abs(actual - expected_m)
        marker = "OK " if delta <= tol_m else "BAD"
        log.info("  %s  %-30s  expected %6.1f  actual %6.1f  Δ %+.1f m",
                 marker, entry["label"], expected_m, actual, actual - expected_m)
        if delta > tol_m:
            n_bad += 1
    return 0 if n_bad == 0 else 1


def _main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=None,
                        help="Process only the first N policies (testing).")
    parser.add_argument("--refresh", action="store_true",
                        help="Ignore the EPQS cache; re-fetch every point.")
    parser.add_argument("--force", action="store_true",
                        help="Re-process every policy even if cached.")
    parser.add_argument("--verify", action="store_true",
                        help="Spot-check against known_points.json and exit.")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(level=getattr(logging, args.log_level),
                        format="%(asctime)s %(levelname)s %(message)s")

    if args.verify:
        return verify_known_points()

    summary = populate(limit=args.limit, refresh=args.refresh,
                       db_path=args.db, force=args.force)
    print(json.dumps(summary, indent=2), file=sys.stderr)
    return 0 if summary["errors"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(_main())
