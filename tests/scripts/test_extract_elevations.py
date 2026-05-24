"""AUDIT.3 Phase 3 — tests for the USGS NED elevation extractor.

Two layers:

1. Parser / cache / DB-write unit tests using mocked EPQS responses and
   an in-memory SQLite copy of the policies schema.  Network-free.

2. A skip-by-default integration test that hits the real EPQS endpoint
   against the bundled ``known_points.json`` anchors.  Opt-in via
   ``FORGE_RUN_NETWORK_TESTS=1``.  This test is the standing health
   check for the USGS endpoint — if it starts failing, the deployment
   knows EPQS shape has drifted before any production extraction does.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from scripts.extract_elevations import (
    KNOWN_POINTS_JSON,
    _ELEV_MAX_M,
    _ELEV_MIN_M,
    _cache_path,
    _select_policies_needing_elevation,
    _update_elevation,
    fetch_elevation,
    parse_epqs_response,
    populate,
)


# ── parser unit tests ─────────────────────────────────────────────────────


def test_parse_epqs_returns_float_for_normal_response() -> None:
    payload = {
        "location": {"x": -82.46, "y": 27.95},
        "value": "5.009602547",
        "resolution": 0.0000308641987179478,
    }
    assert parse_epqs_response(payload) == pytest.approx(5.009602547, rel=1e-9)


def test_parse_epqs_accepts_numeric_value() -> None:
    """EPQS can also return ``value`` as a JSON number (not a string) —
    parse should handle either."""
    assert parse_epqs_response({"value": 12.5}) == pytest.approx(12.5)


def test_parse_epqs_returns_none_for_no_data_sentinel() -> None:
    for sentinel in ("-1000000", "-1000000.000000000"):
        assert parse_epqs_response({"value": sentinel}) is None


def test_parse_epqs_returns_none_for_empty_value() -> None:
    assert parse_epqs_response({"value": ""}) is None
    assert parse_epqs_response({"value": None}) is None


def test_parse_epqs_returns_none_for_out_of_range() -> None:
    # +999999 m is clearly not real terrain — treat as no-data.
    assert parse_epqs_response({"value": str(_ELEV_MAX_M + 1.0)}) is None
    assert parse_epqs_response({"value": str(_ELEV_MIN_M - 1.0)}) is None


def test_parse_epqs_raises_on_missing_value() -> None:
    with pytest.raises(ValueError, match="missing 'value'"):
        parse_epqs_response({"location": {"x": 0, "y": 0}})


def test_parse_epqs_raises_on_unparseable_value() -> None:
    with pytest.raises(ValueError, match="could not parse"):
        parse_epqs_response({"value": "not-a-number"})


# ── cache key behavior ────────────────────────────────────────────────────


def test_cache_path_rounds_coordinates() -> None:
    """Cache key precision is fixed at 6 decimals, so jittery 7th-decimal
    inputs collide into a single cache file."""
    p1 = _cache_path(27.951234, -82.461234)
    p2 = _cache_path(27.9512341111, -82.4612340000)
    assert p1 == p2


def test_cache_path_distinguishes_different_points() -> None:
    """Two physically distinct points must NOT collide."""
    p1 = _cache_path(27.95, -82.46)
    p2 = _cache_path(28.95, -82.46)
    assert p1 != p2


# ── fetch_elevation with mocked transport ────────────────────────────────


class _MockResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._payload


class _MockSession:
    def __init__(self, payload: dict) -> None:
        self.calls = 0
        self._payload = payload

    def get(self, url, *, params=None, timeout=None):
        self.calls += 1
        return _MockResponse(self._payload)


def test_fetch_elevation_caches_response(tmp_path: Path,
                                          monkeypatch) -> None:
    """First call hits the session; second call reads cache only."""
    cache_dir = tmp_path / "elev_cache"
    cache_dir.mkdir()
    monkeypatch.setattr("scripts.extract_elevations.CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        "scripts.extract_elevations._cache_path",
        lambda lat, lon: cache_dir / f"epqs_{round(lat, 6)}_"
                                     f"{round(lon, 6)}.json")
    payload = {"value": "12.34"}
    sess = _MockSession(payload)
    elev1 = fetch_elevation(27.95, -82.46, session=sess)
    elev2 = fetch_elevation(27.95, -82.46, session=sess)
    assert elev1 == pytest.approx(12.34)
    assert elev2 == pytest.approx(12.34)
    assert sess.calls == 1, "cache hit should skip the network"


def test_fetch_elevation_refresh_bypasses_cache(tmp_path: Path,
                                                  monkeypatch) -> None:
    cache_dir = tmp_path / "elev_cache_refresh"
    cache_dir.mkdir()
    monkeypatch.setattr("scripts.extract_elevations.CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        "scripts.extract_elevations._cache_path",
        lambda lat, lon: cache_dir / f"epqs_{round(lat, 6)}_"
                                     f"{round(lon, 6)}.json")
    sess = _MockSession({"value": "5.5"})
    fetch_elevation(27.95, -82.46, session=sess)
    fetch_elevation(27.95, -82.46, session=sess, refresh=True)
    assert sess.calls == 2


def test_fetch_elevation_returns_none_for_offshore(tmp_path: Path,
                                                    monkeypatch) -> None:
    cache_dir = tmp_path / "elev_cache_nodata"
    cache_dir.mkdir()
    monkeypatch.setattr("scripts.extract_elevations.CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        "scripts.extract_elevations._cache_path",
        lambda lat, lon: cache_dir / f"epqs_{round(lat, 6)}_"
                                     f"{round(lon, 6)}.json")
    sess = _MockSession({"value": "-1000000"})
    assert fetch_elevation(0.0, 0.0, session=sess) is None


# ── DB integration with in-memory SQLite ─────────────────────────────────


def _make_inmem_policies_db(rows: list[tuple[int, float, float, float]]
                             ) -> sqlite3.Connection:
    """Build an in-memory policies table with the minimum schema."""
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE TABLE policies (
            id INTEGER PRIMARY KEY,
            lat REAL, lon REAL, elevation_m REAL
        )
    """)
    conn.executemany(
        "INSERT INTO policies (id, lat, lon, elevation_m) "
        "VALUES (?, ?, ?, ?)", rows)
    conn.commit()
    return conn


def test_update_elevation_persists() -> None:
    conn = _make_inmem_policies_db([(1, 27.95, -82.46, None)])
    _update_elevation(conn, 1, 5.5)
    row = conn.execute(
        "SELECT elevation_m FROM policies WHERE id = 1").fetchone()
    assert row[0] == pytest.approx(5.5)


def test_update_elevation_accepts_none_for_nodata() -> None:
    conn = _make_inmem_policies_db([(1, 27.95, -82.46, 3.0)])
    _update_elevation(conn, 1, None)
    row = conn.execute(
        "SELECT elevation_m FROM policies WHERE id = 1").fetchone()
    assert row[0] is None


def test_select_policies_orders_by_id_and_respects_limit() -> None:
    conn = _make_inmem_policies_db([
        (3, 27.0, -82.0, None),
        (1, 28.0, -82.5, 5.0),
        (2, 29.0, -83.0, None),
    ])
    rows = _select_policies_needing_elevation(conn, limit=2)
    assert [r[0] for r in rows] == [1, 2]


def test_select_policies_skips_null_coords() -> None:
    conn = _make_inmem_policies_db([
        (1, 27.0, -82.0, None),
        (2, None, None, None),
        (3, 28.0, -83.0, None),
    ])
    rows = _select_policies_needing_elevation(conn)
    assert [r[0] for r in rows] == [1, 3]


def test_populate_end_to_end_with_mock_session(tmp_path: Path,
                                                  monkeypatch) -> None:
    """Build a small DB, monkey-patch the EPQS fetcher to return known
    values, run populate(), assert the DB is updated."""
    db_path = tmp_path / "tinybook.db"
    sqlite3.connect(db_path).executescript("""
        CREATE TABLE policies (
            id INTEGER PRIMARY KEY,
            lat REAL, lon REAL, elevation_m REAL
        );
        INSERT INTO policies VALUES (1, 27.95, -82.46, NULL);
        INSERT INTO policies VALUES (2, 30.44, -84.28, NULL);
    """)

    fake_elevations = {
        (27.95, -82.46): 5.0,
        (30.44, -84.28): 62.2,
    }

    def fake_fetch(lat, lon, *, refresh=False, session=None):
        return fake_elevations[(round(lat, 2), round(lon, 2))]

    monkeypatch.setattr("scripts.extract_elevations.fetch_elevation",
                        fake_fetch)
    # Disable polite pacing in tests.
    monkeypatch.setattr("scripts.extract_elevations._INTER_REQUEST_SLEEP_S",
                        0.0)

    summary = populate(db_path=db_path)
    assert summary["policies_processed"] == 2
    assert summary["ok"] == 2
    assert summary["errors"] == 0

    conn = sqlite3.connect(db_path)
    elevs = dict(conn.execute(
        "SELECT id, elevation_m FROM policies").fetchall())
    assert elevs[1] == pytest.approx(5.0)
    assert elevs[2] == pytest.approx(62.2)
    conn.close()


# ── known_points anchor file structure ───────────────────────────────────


def test_known_points_json_well_formed() -> None:
    data = json.loads(KNOWN_POINTS_JSON.read_text())
    assert {"source", "wkid", "units", "points"} <= data.keys()
    assert data["wkid"] == 4326
    assert data["units"] == "Meters"
    assert len(data["points"]) >= 4
    for entry in data["points"]:
        assert {"label", "lat", "lon", "expected_m"} <= entry.keys()
        assert -90 <= entry["lat"] <= 90
        assert -180 <= entry["lon"] <= 180
        assert _ELEV_MIN_M <= entry["expected_m"] <= _ELEV_MAX_M


# ── optional live-network integration test ───────────────────────────────


@pytest.mark.skipif(
    os.getenv("FORGE_RUN_NETWORK_TESTS") != "1",
    reason="Live USGS EPQS test — opt in with FORGE_RUN_NETWORK_TESTS=1")
def test_known_points_resolve_against_real_epqs() -> None:
    """Hit the actual USGS endpoint against the bundled anchor points.
    Skipped by default so CI doesn't depend on EPQS uptime; an SRE
    health check can run with FORGE_RUN_NETWORK_TESTS=1."""
    data = json.loads(KNOWN_POINTS_JSON.read_text())
    for entry in data["points"]:
        actual = fetch_elevation(entry["lat"], entry["lon"])
        assert actual is not None, (
            f"EPQS returned no-data for {entry['label']}")
        tol = entry.get("tolerance_m", 5.0)
        assert abs(actual - entry["expected_m"]) <= tol, (
            f"{entry['label']}: expected {entry['expected_m']:.1f} m, "
            f"got {actual:.1f} m, delta {actual - entry['expected_m']:+.1f} m")


@pytest.mark.skipif(
    os.getenv("FORGE_RUN_NETWORK_TESTS") != "1",
    reason="Live USGS EPQS test — opt in with FORGE_RUN_NETWORK_TESTS=1")
def test_populate_end_to_end_against_real_epqs(tmp_path: Path) -> None:
    """End-to-end live integration test for ``populate()``.

    The bundled ``test_known_points_resolve_against_real_epqs`` only
    exercises ``fetch_elevation`` (the EPQS transport + parser).  This
    test also covers the DB write path: it builds a tiny SQLite policies
    table seeded at the five FL/LA anchor coordinates, runs the full
    ``populate(...)`` orchestration against the *live* EPQS endpoint,
    and asserts every row gets the expected elevation within the
    per-point tolerance recorded in ``known_points.json``.

    Together with the unit-test ``test_populate_end_to_end_with_mock_session``
    above (which covers the same orchestration with a mocked transport)
    this pins both ends of the contract — the DB-write side stays
    deterministic, the EPQS side stays honest.

    Opt-in via ``FORGE_RUN_NETWORK_TESTS=1`` for the same reason as the
    fetch-only live test: the suite must not gate CI on EPQS uptime.
    """
    # Pull the five non-Denver anchors so the network footprint stays
    # small (5 EPQS calls at ~1 s + 0.2 s polite pacing ≈ 6 s wall-clock).
    spec = json.loads(KNOWN_POINTS_JSON.read_text())
    anchors = [
        e for e in spec["points"] if "high-elevation" not in e["label"]
    ][:5]
    assert len(anchors) == 5, (
        "known_points.json must carry at least five non-outlier anchors "
        "for this test; got " + str(len(anchors))
    )

    db_path = tmp_path / "test_book.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE policies (id INTEGER PRIMARY KEY, "
            "lat REAL, lon REAL, elevation_m REAL)"
        )
        conn.executemany(
            "INSERT INTO policies (id, lat, lon, elevation_m) "
            "VALUES (?, ?, ?, NULL)",
            [(i + 1, e["lat"], e["lon"]) for i, e in enumerate(anchors)],
        )
        conn.commit()
    finally:
        conn.close()

    summary = populate(db_path=db_path, limit=5)
    assert summary["policies_processed"] == 5
    assert summary["errors"] == 0, (
        f"live populate() reported errors: {summary}"
    )
    # Every anchor must come back with a non-NULL elevation; nodata
    # at a city centroid would mean EPQS shape has drifted.
    assert summary["nodata"] == 0, (
        f"live populate() reported nodata at city centroids: {summary}"
    )

    # Read each row back and verify it's within tolerance of the anchor.
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT id, elevation_m FROM policies ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    elevs = {r[0]: r[1] for r in rows}

    for idx, entry in enumerate(anchors, start=1):
        actual = elevs[idx]
        assert actual is not None, (
            f"policy {idx} ({entry['label']}): expected non-NULL elevation"
        )
        tol = entry.get("tolerance_m", 5.0)
        assert abs(actual - entry["expected_m"]) <= tol, (
            f"policy {idx} ({entry['label']}): expected "
            f"{entry['expected_m']:.1f} ± {tol:.1f} m, got {actual:.1f} m"
        )
