"""AUDIT.3 Phase 4 — tests for the coastal-ZIP3 catalog precompute.

Two layers:

1. Unit tests against an in-memory DB + mocked EPQS exercise the
   aggregation SQL, the elevation enrichment, and the catalog
   serialization shape.

2. A committed-artifact test asserts ``artifacts/coastal_zip3s.json``
   is well-formed, every entry has real-data-derived values, and the
   loader function in ``ml.scenarios.generate`` round-trips against
   the same artifact.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from scripts.precompute_coastal_zip3s import (
    OUTPUT_JSON,
    _aggregate_centroids,
    _attach_elevations,
    _COASTAL_STATES,
    _MIN_POLICIES_PER_ZIP3,
    build_catalog,
    write_artifact,
)


# ── DB aggregation ────────────────────────────────────────────────────────


def _make_db(rows: list[tuple]) -> sqlite3.Connection:
    """Build an in-memory ``policies`` table with the minimum schema."""
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE TABLE policies (
            id INTEGER PRIMARY KEY,
            state TEXT,
            zip3 TEXT,
            lat REAL, lon REAL,
            elevation_m REAL
        )
    """)
    conn.executemany(
        "INSERT INTO policies (id, state, zip3, lat, lon, elevation_m) "
        "VALUES (?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
    return conn


def test_aggregate_centroids_groups_by_zip3_and_averages() -> None:
    rows = []
    for i in range(60):
        rows.append((i + 1, "FL", "337", 27.5 + i * 0.001,
                     -82.6 + i * 0.001, None))
    conn = _make_db(rows)
    out = _aggregate_centroids(conn)
    assert len(out) == 1
    entry = out[0]
    assert entry["zip3"] == "337"
    assert entry["n_policies"] == 60
    # Mean lat over 27.500 → 27.559 = 27.5295
    assert entry["lat"] == pytest.approx(27.5295, rel=1e-3)


def test_aggregate_centroids_skips_below_threshold() -> None:
    """A ZIP3 with fewer than _MIN_POLICIES_PER_ZIP3 policies must not
    enter the catalog — too low-N for a meaningful centroid."""
    rows = [
        (i + 1, "FL", "338", 27.0 + i * 0.01, -82.0, None)
        for i in range(_MIN_POLICIES_PER_ZIP3 - 1)  # 49 — just under
    ]
    conn = _make_db(rows)
    assert _aggregate_centroids(conn) == []


def test_aggregate_centroids_filters_to_coastal_states_only() -> None:
    rows = []
    for i in range(60):
        rows.append((i + 1, "CA", "900", 34.0, -118.0, None))
        rows.append((i + 100, "FL", "337", 27.5, -82.6, None))
    conn = _make_db(rows)
    out = _aggregate_centroids(conn)
    # CA (non-coastal in FORGE's set) is excluded; FL ZIP3 remains.
    zip3s = {e["zip3"] for e in out}
    assert zip3s == {"337"}


def test_aggregate_centroids_ignores_null_coords() -> None:
    rows = [(i + 1, "FL", "337",
             27.5 if i < 50 else None,
             -82.6 if i < 50 else None,
             None)
            for i in range(60)]
    conn = _make_db(rows)
    out = _aggregate_centroids(conn)
    # Only 50 valid rows → below the 50-policy threshold? No, exactly 50.
    # With HAVING n >= 50, that passes.
    assert out and out[0]["n_policies"] == 50


# ── elevation enrichment ──────────────────────────────────────────────────


def test_attach_elevations_calls_epqs_per_entry(monkeypatch) -> None:
    """``_attach_elevations`` calls ``fetch_elevation`` once per entry."""
    fake_calls: list[tuple[float, float]] = []

    def fake_fetch(lat, lon, *, refresh=False, session=None):
        fake_calls.append((round(lat, 3), round(lon, 3)))
        return 5.0 + lat  # deterministic, distinct per lat

    monkeypatch.setattr("scripts.precompute_coastal_zip3s.fetch_elevation",
                        fake_fetch)
    entries = [
        {"zip3": "337", "lat": 27.5, "lon": -82.6, "n_policies": 60},
        {"zip3": "704", "lat": 29.95, "lon": -90.07, "n_policies": 80},
    ]
    out = _attach_elevations(entries)
    assert len(out) == 2
    assert out[0]["elev_m"] == pytest.approx(5.0 + 27.5)
    assert out[1]["elev_m"] == pytest.approx(5.0 + 29.95)
    assert fake_calls == [(27.5, -82.6), (29.95, -90.07)]


def test_attach_elevations_passes_none_for_nodata(monkeypatch) -> None:
    """``fetch_elevation`` returning ``None`` (no-data) flows through."""
    monkeypatch.setattr(
        "scripts.precompute_coastal_zip3s.fetch_elevation",
        lambda lat, lon, *, refresh=False, session=None: None)
    entries = [{"zip3": "999", "lat": 27.5, "lon": -82.6, "n_policies": 50}]
    out = _attach_elevations(entries)
    assert out[0]["elev_m"] is None


# ── build_catalog end-to-end on an in-memory DB ───────────────────────────


def test_build_catalog_drops_nodata_entries(tmp_path: Path,
                                              monkeypatch) -> None:
    """Centroids that EPQS returns no-data for should NOT enter the
    catalog (the surge calc can't use NULL elevation)."""
    db_path = tmp_path / "book.db"
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE policies (
            id INTEGER PRIMARY KEY,
            state TEXT,
            zip3 TEXT,
            lat REAL, lon REAL,
            elevation_m REAL
        )
    """)
    conn.executemany(
        "INSERT INTO policies VALUES (?, ?, ?, ?, ?, NULL)",
        [(i + 1, "FL", "337", 27.5, -82.6) for i in range(60)] +
        [(i + 101, "FL", "999", 50.0, -180.0) for i in range(60)]
    )
    conn.commit()
    conn.close()

    def fake_fetch(lat, lon, *, refresh=False, session=None):
        # 337 (Tampa) → real elevation; 999 (offshore) → no-data.
        return None if (round(lat, 1), round(lon, 1)) == (50.0, -180.0) else 5.0

    monkeypatch.setattr("scripts.precompute_coastal_zip3s.fetch_elevation",
                        fake_fetch)
    catalog = build_catalog(db_path=db_path)
    assert catalog["n_zip3s"] == 1
    assert "337" in catalog["catalog"]
    assert "999" not in catalog["catalog"]


def test_build_catalog_records_source_provenance(tmp_path: Path,
                                                   monkeypatch) -> None:
    db_path = tmp_path / "book.db"
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE policies (
            id INTEGER PRIMARY KEY,
            state TEXT, zip3 TEXT, lat REAL, lon REAL, elevation_m REAL
        )
    """)
    conn.executemany(
        "INSERT INTO policies VALUES (?, ?, ?, ?, ?, NULL)",
        [(i + 1, "FL", "337", 27.5, -82.6) for i in range(60)])
    conn.commit()
    conn.close()
    monkeypatch.setattr(
        "scripts.precompute_coastal_zip3s.fetch_elevation",
        lambda lat, lon, *, refresh=False, session=None: 5.0)
    catalog = build_catalog(db_path=db_path)
    src = catalog["source"]
    assert "epqs_url" in src and "epqs.nationalmap.gov" in src["epqs_url"]
    assert set(src["coastal_states"]) == set(_COASTAL_STATES)
    assert src["min_policies_per_zip3"] == _MIN_POLICIES_PER_ZIP3


def test_build_catalog_requires_db_to_exist(tmp_path: Path) -> None:
    missing = tmp_path / "does_not_exist.db"
    with pytest.raises(RuntimeError, match="DB not found"):
        build_catalog(db_path=missing)


def test_write_artifact_round_trips(tmp_path: Path) -> None:
    catalog = {
        "source": {"foo": "bar"},
        "n_zip3s": 1,
        "catalog": {"337": {"lat": 27.5, "lon": -82.6, "elev_m": 5.0,
                            "n_policies": 60}},
        "notes": "test",
    }
    out = tmp_path / "catalog.json"
    write_artifact(catalog, out_path=out)
    parsed = json.loads(out.read_text())
    assert parsed == catalog


# ── committed-artifact tests ──────────────────────────────────────────────


@pytest.fixture(scope="module")
def committed_catalog() -> dict:
    if not OUTPUT_JSON.exists():
        pytest.skip("artifacts/coastal_zip3s.json not present — "
                    "run `python -m scripts.precompute_coastal_zip3s` first")
    return json.loads(OUTPUT_JSON.read_text())


def test_committed_catalog_has_required_fields(committed_catalog: dict) -> None:
    assert {"source", "n_zip3s", "catalog", "notes"} <= committed_catalog.keys()
    assert committed_catalog["n_zip3s"] == len(committed_catalog["catalog"])


def test_committed_catalog_zip3s_are_3_digit_strings(
        committed_catalog: dict) -> None:
    for z in committed_catalog["catalog"]:
        assert isinstance(z, str)
        assert len(z) == 3
        assert z.isdigit()


def test_committed_catalog_entries_have_physical_values(
        committed_catalog: dict) -> None:
    """Every entry has plausible (lat, lon, elev_m, n_policies)."""
    for z, entry in committed_catalog["catalog"].items():
        assert 24 <= entry["lat"] <= 40, f"{z} lat out of CONUS coastal band"
        assert -100 <= entry["lon"] <= -65, f"{z} lon out of CONUS"
        assert -200 <= entry["elev_m"] <= 5000, f"{z} elev physically wrong"
        assert entry["n_policies"] >= _MIN_POLICIES_PER_ZIP3


def test_committed_catalog_covers_florida_and_louisiana(
        committed_catalog: dict) -> None:
    """The seeded FORGE book is FL-heavy with LA exposure — both should
    have multiple ZIP3s in the catalog."""
    # FL ZIP3 prefixes start with 32-34 mostly; LA with 70-71.
    fl_count = sum(1 for z in committed_catalog["catalog"] if z.startswith("3"))
    la_count = sum(1 for z in committed_catalog["catalog"] if z.startswith("7"))
    assert fl_count >= 5, f"only {fl_count} FL-style ZIP3s in catalog"
    assert la_count >= 1, f"only {la_count} LA-style ZIP3s in catalog"


def test_loader_round_trips_with_artifact() -> None:
    """``_load_coastal_zip3_catalog`` in generate.py reads the same
    file and returns the same set of ZIP3s."""
    if not OUTPUT_JSON.exists():
        pytest.skip("artifact not present")
    from ml.scenarios.generate import _load_coastal_zip3_catalog
    _load_coastal_zip3_catalog.cache_clear()
    loaded = _load_coastal_zip3_catalog()
    raw = json.loads(OUTPUT_JSON.read_text())["catalog"]
    assert set(loaded.keys()) == set(raw.keys())
    for z in loaded:
        # Loader strips n_policies; the three surge-relevant fields
        # must be present and float-typed.
        assert {"lat", "lon", "elev_m"} == set(loaded[z].keys())
        assert all(isinstance(v, float) for v in loaded[z].values())
        # Values must match the underlying artifact.
        assert loaded[z]["lat"] == raw[z]["lat"]
        assert loaded[z]["lon"] == raw[z]["lon"]
        assert loaded[z]["elev_m"] == raw[z]["elev_m"]
