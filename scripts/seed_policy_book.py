"""Seed 10,000 synthetic residential policies across FL, TX, LA, NC.

Run from anywhere — DB path is resolved relative to this file:
    python scripts/seed_policy_book.py

The script is idempotent: it truncates the policies table before inserting
so repeated runs always produce the same deterministic dataset (random.seed=42).
"""

import json
import random
import sqlite3
from pathlib import Path

random.seed(42)

DB_PATH = Path(__file__).resolve().parent.parent / "forge-local.db"

# ---------------------------------------------------------------------------
# State configuration
# ---------------------------------------------------------------------------

STATE_CONFIG = {
    "FL": {
        "weight": 0.45,
        "zip3s": ["330", "331", "332", "334", "335", "337", "338", "339",
                  "341", "342", "346", "349", "320"],
    },
    "TX": {
        "weight": 0.25,
        "zip3s": ["770", "774", "775", "776", "777", "778", "783", "784"],
    },
    "LA": {
        "weight": 0.15,
        "zip3s": ["703", "704", "705", "706", "707", "708", "714"],
    },
    "NC": {
        "weight": 0.15,
        "zip3s": ["275", "280", "281", "282", "283", "284", "285", "286",
                  "287", "289"],
    },
}

# Real ZIP3 geography — one anchor {state, county, city, lat, lon} per ZIP3
# prefix, sourced from USPS SCF tables + Census/Wikipedia (see
# lib/regulatory/zip3_geo.json). Each policy's lat/lon is jittered around its
# ZIP3's real anchor and its county is that anchor's real county, so every
# policy's (zip3, county, lat, lon) is mutually coherent and real — no more
# per-state Gaussian blob with an unrelated zip3 label.
ZIP3_GEO_PATH = (
    Path(__file__).resolve().parent.parent / "lib" / "regulatory" / "zip3_geo.json"
)
ZIP3_GEO = json.loads(ZIP3_GEO_PATH.read_text())

# Gaussian jitter (degrees) around a ZIP3's real centroid. ~0.06° ≈ 6-7 km —
# tight enough that a policy stays within its anchor city's county.
GEO_JITTER_SIG = 0.06
GEO_JITTER_MAX = 0.18

STATES = list(STATE_CONFIG.keys())
STATE_WEIGHTS = [STATE_CONFIG[s]["weight"] for s in STATES]

# Build type distribution (weights must sum to 1)
BUILD_TYPES = ["wood_frame", "masonry", "manufactured"]
BUILD_WEIGHTS = [0.55, 0.30, 0.15]

# Flood zone distribution (weights must sum to 1)
FLOOD_ZONES = ["X", "A", "AE", "VE"]
FLOOD_WEIGHTS = [0.55, 0.20, 0.20, 0.05]
ZONE_MULT = {"X": 0.9, "A": 1.2, "AE": 1.4, "VE": 1.8}

N_POLICIES = 10_000

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "lib" / "db" / "schema.sql"


def weighted_choice(population, weights):
    """Pick one element from population using the given weights."""
    return random.choices(population, weights=weights, k=1)[0]


def clamp(value, lo, hi):
    return max(lo, min(hi, value))


def generate_policy():
    state = weighted_choice(STATES, STATE_WEIGHTS)
    cfg = STATE_CONFIG[state]

    zip3 = random.choice(cfg["zip3s"])
    geo = ZIP3_GEO[zip3]
    county = geo["county"]  # real county of the ZIP3's anchor city

    # Lat/lon: small Gaussian jitter around the ZIP3's real centroid so the
    # policy's location is coherent with its zip3 and county. Exactly two
    # random.gauss calls — same as the old per-state sampling — so the random
    # stream (and thus tiv / build_type / cohorts) is byte-identical.
    lat = clamp(random.gauss(geo["lat"], GEO_JITTER_SIG),
                geo["lat"] - GEO_JITTER_MAX, geo["lat"] + GEO_JITTER_MAX)
    lon = clamp(random.gauss(geo["lon"], GEO_JITTER_SIG),
                geo["lon"] - GEO_JITTER_MAX, geo["lon"] + GEO_JITTER_MAX)

    # TIV: log-normal with mean ~$268k, plausible $100k–$3M range
    tiv = random.lognormvariate(12.5, 0.6)

    build_year = random.randint(1960, 2023)
    build_type = weighted_choice(BUILD_TYPES, BUILD_WEIGHTS)
    flood_zone = weighted_choice(FLOOD_ZONES, FLOOD_WEIGHTS)

    # Elevation: VE/AE zones tend to be lower-lying
    if flood_zone == "VE":
        elevation_m = random.uniform(0.0, 1.5)
    elif flood_zone in ("A", "AE"):
        elevation_m = random.uniform(0.5, 3.0)
    else:
        elevation_m = random.uniform(1.5, 6.0)

    zone_mult = ZONE_MULT[flood_zone]
    premium_annual = tiv * 0.015 * zone_mult

    return (
        state, zip3, county, lat, lon,
        tiv, build_year, build_type, flood_zone,
        elevation_m, premium_annual,
        # cv_features stays NULL on seed. Populating with `--mode mock` would
        # be dishonest — mock_chip() emits uniform-random uint16 noise per
        # band, and NDVI/NDWI/SWIR/edge-density band-math on that noise has
        # closed-form asymptotic means (NDVI mean = NDWI mean = 0, edges
        # saturate, hash mod 5 averages to 0.5), so populating mock features
        # writes the *same five band-math statistics of noise* into every
        # cohort and the drill-down would render those as if they were real
        # Sentinel-2 readings. CLAUDE.md "no fictional data": leave NULL,
        # let the drill-down's amber "CV head not run" callout surface the
        # honest state, and require `scripts/populate_cv_features.py
        # --mode {cached,real}` against real Sentinel-2 chips to fill it.
        None,
        1,  # synthetic — Task 15: tag demo data
    )


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Apply schema.sql to an empty DB so seed() works on a fresh tmp path.

    The TS migrate script (lib/db/migrate.ts) is the canonical migrator; this
    helper mirrors its behaviour for Python callers (tests, ad-hoc seeding)
    so seed() can target a brand-new sqlite file without depending on Node.

    Mirrors two quirks of migrate.ts:
      1. Statements that are pure ``--`` comments after split-on-``;`` are
         skipped (schema comments can contain semicolons that fragment the
         split).
      2. ``ALTER TABLE ... ADD COLUMN`` errors with ``duplicate column name``
         once the column exists; that one error is swallowed so the seeder
         can run against both fresh and pre-migrated DBs (Task P2.39).
    """
    schema = SCHEMA_PATH.read_text()
    stmts = [s.strip() for s in schema.split(";") if s.strip()]
    cur = conn.cursor()
    for stmt in stmts:
        # Strip leading "-- ..." comment lines.
        code = "\n".join(
            line for line in stmt.split("\n") if not line.lstrip().startswith("--")
        ).strip()
        if not code:
            continue
        try:
            cur.execute(code)
        except sqlite3.OperationalError as exc:
            is_alter = code.upper().startswith("ALTER TABLE")
            is_duplicate = "duplicate column name" in str(exc).lower()
            if not (is_alter and is_duplicate):
                raise
    conn.commit()


def seed(db_path: str, n: int = N_POLICIES) -> None:
    """Seed `n` deterministic synthetic policies into the sqlite file at `db_path`.

    Idempotent: clears the policies table before inserting. Tagging is
    `synthetic=1` for every row (Task 15) — the CSV upload path is the only
    source of `synthetic=0` rows.

    ``cv_features`` is left NULL on every row by design — populating it
    requires real Sentinel-2 chips (see ``scripts/populate_cv_features.py
    --mode {cached,real}``). The drill-down panel surfaces an honest amber
    "CV head not run" callout for the unpopulated state; running the
    populator in mock mode would write deterministic band-math statistics
    over uniform-noise chips, which CLAUDE.md "no fictional data" forbids.
    """
    conn = sqlite3.connect(db_path)
    _ensure_schema(conn)
    cur = conn.cursor()

    # Idempotency: truncate before seeding
    cur.execute("DELETE FROM policies")
    print(f"Cleared existing policies. Inserting {n:,} new records...")

    rows = [generate_policy() for _ in range(n)]

    cur.executemany(
        """
        INSERT INTO policies
            (state, zip3, county, lat, lon,
             tiv, build_year, build_type, flood_zone,
             elevation_m, premium_annual, cv_features, synthetic)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )

    conn.commit()

    # Summary stats (reuse the same connection)
    cur.execute("""
        SELECT
            COUNT(*) AS n,
            ROUND(AVG(tiv)) AS avg_tiv,
            ROUND(SUM(premium_annual)) AS total_premium
        FROM policies
    """)
    total, avg_tiv, total_premium = cur.fetchone()
    print("\nVerification:")
    print(f"  Total policies   : {total:,}")
    print(f"  Avg TIV ($)      : {avg_tiv:,.0f}")
    print(f"  Total premium ($): {total_premium:,.0f}")

    cur.execute("""
        SELECT state, COUNT(*) AS cnt
        FROM policies
        GROUP BY state
        ORDER BY cnt DESC
    """)
    print("\n  Policies by state:")
    for row in cur.fetchall():
        print(f"    {row[0]}: {row[1]:,}")

    conn.close()
    print("\nDone.")


def main():
    seed(str(DB_PATH), N_POLICIES)


if __name__ == "__main__":
    main()
