"""Seed 10,000 synthetic residential policies across FL, TX, LA, NC.

Run from anywhere — DB path is resolved relative to this file:
    python scripts/seed_policy_book.py

The script is idempotent: it truncates the policies table before inserting
so repeated runs always produce the same deterministic dataset (random.seed=42).
"""

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
        "lat_mu": 28.0, "lat_sig": 1.5, "lat_min": 24.5, "lat_max": 30.5,
        "lon_mu": -82.0, "lon_sig": 1.5, "lon_min": -87.5, "lon_max": -80.0,
    },
    "TX": {
        "weight": 0.25,
        "zip3s": ["770", "774", "775", "776", "777", "778", "783", "784"],
        "lat_mu": 29.5, "lat_sig": 0.8, "lat_min": 25.8, "lat_max": 30.5,
        "lon_mu": -95.0, "lon_sig": 1.5, "lon_min": -97.5, "lon_max": -93.5,
    },
    "LA": {
        "weight": 0.15,
        "zip3s": ["703", "704", "705", "706", "707", "708", "714"],
        "lat_mu": 30.0, "lat_sig": 0.6, "lat_min": 28.9, "lat_max": 31.2,
        "lon_mu": -91.0, "lon_sig": 1.0, "lon_min": -93.9, "lon_max": -88.8,
    },
    "NC": {
        "weight": 0.15,
        "zip3s": ["275", "280", "281", "282", "283", "284", "285", "286",
                  "287", "289"],
        "lat_mu": 34.5, "lat_sig": 0.8, "lat_min": 33.8, "lat_max": 36.6,
        "lon_mu": -77.5, "lon_sig": 1.2, "lon_min": -79.0, "lon_max": -75.4,
    },
}

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
    county = f"{state}-{zip3}"

    # Lat/lon sampled from per-state Gaussian, clipped to coastal bounding box
    lat = clamp(random.gauss(cfg["lat_mu"], cfg["lat_sig"]),
                cfg["lat_min"], cfg["lat_max"])
    lon = clamp(random.gauss(cfg["lon_mu"], cfg["lon_sig"]),
                cfg["lon_min"], cfg["lon_max"])

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
        None,  # cv_features — populated by Task 9
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
