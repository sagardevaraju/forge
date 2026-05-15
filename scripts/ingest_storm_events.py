"""Ingest NOAA Storm Events CSVs into the storm_events table.

Downloads gzipped CSV files directly from NOAA's public HTTPS server,
streams + filters them in memory, and upserts hurricane / tropical-storm
events for FL, TX, LA, NC into the local SQLite DB.

Usage:
    python scripts/ingest_storm_events.py --years 2024
    python scripts/ingest_storm_events.py --years 2018-2024
    python scripts/ingest_storm_events.py --years 2020,2022,2024

The script is idempotent: event_id has a UNIQUE constraint and inserts
use INSERT OR IGNORE, so re-running the same year is safe.
"""

import argparse
import csv
import gzip
import re
import sqlite3
import sys
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DB_PATH = Path(__file__).resolve().parent.parent / "forge-local.db"

NOAA_DIR_URL = (
    "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
)

# States we care about (NOAA uses full upper-case names)
TARGET_STATES = {
    "FLORIDA": "FL",
    "TEXAS": "TX",
    "LOUISIANA": "LA",
    "NORTH CAROLINA": "NC",
}

# Event types that qualify as hurricane / tropical activity
TARGET_EVENT_TYPES = {
    "Hurricane (Typhoon)",
    "Hurricane",
    "Tropical Storm",
    "Tropical Depression",
}

REQUEST_TIMEOUT = 60  # seconds

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_years(years_arg: str) -> list[int]:
    """Parse --years value: single year, range Y1-Y2, or comma list."""
    years_arg = years_arg.strip()
    if "," in years_arg:
        return [int(y.strip()) for y in years_arg.split(",")]
    if "-" in years_arg:
        parts = years_arg.split("-")
        if len(parts) == 2:
            start, end = int(parts[0]), int(parts[1])
            return list(range(start, end + 1))
    return [int(years_arg)]


def parse_damage_property(value: str) -> float | None:
    """Convert NOAA damage string to a float in dollars.

    Examples:
        "5.00M"  -> 5_000_000
        "300K"   -> 300_000
        "1.5B"   -> 1_500_000_000
        "0.00K"  -> 0
        ""       -> None
    """
    if not value or value.strip() == "":
        return None
    value = value.strip().upper()
    multipliers = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}
    if value[-1] in multipliers:
        try:
            return float(value[:-1]) * multipliers[value[-1]]
        except ValueError:
            return None
    try:
        return float(value)
    except ValueError:
        return None


def discover_filename(year: int, session: requests.Session) -> str | None:
    """Fetch the NOAA directory listing and return the details filename for year."""
    resp = session.get(NOAA_DIR_URL, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    pattern = re.compile(
        rf"StormEvents_details-ftp_v1\.0_d{year}_c\d{{8}}\.csv\.gz"
    )
    matches = pattern.findall(resp.text)
    if not matches:
        return None
    # Use the last match (most recent release if there are multiple)
    return matches[-1]


BATCH_SIZE = 500


def stream_year(year: int, session: requests.Session) -> tuple[int, int, int]:
    """Download, filter, and insert storm events for one year.

    Returns (fetched_rows, kept_rows, inserted_rows).

    Streams the gzipped CSV row by row — memory footprint is flat
    regardless of file size. Rows are batched and inserted with
    executemany every BATCH_SIZE filtered rows.
    """
    filename = discover_filename(year, session)
    if filename is None:
        print(f"{year}: no file found in NOAA directory — skipping")
        return 0, 0, 0

    url = NOAA_DIR_URL + filename
    resp = session.get(url, stream=True, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    # Ensure the underlying socket yields raw gzipped bytes (not
    # auto-decoded by urllib3's content-encoding handling).
    resp.raw.decode_content = False

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    fetched = 0
    kept = 0
    inserted = 0
    batch: list[tuple] = []

    def flush(batch: list[tuple]) -> int:
        if not batch:
            return 0
        before = conn.total_changes
        cur.executemany(
            """
            INSERT OR IGNORE INTO storm_events
                (event_id, year, state, county, event_type,
                 peak_wind, damage_property, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            batch,
        )
        return conn.total_changes - before

    try:
        with gzip.open(resp.raw, mode="rt", encoding="latin-1", errors="replace") as gz:
            reader = csv.DictReader(gz)
            for row in reader:
                fetched += 1
                state_full = row.get("STATE", "").strip().upper()
                event_type = row.get("EVENT_TYPE", "").strip()

                if state_full not in TARGET_STATES:
                    continue
                if event_type not in TARGET_EVENT_TYPES:
                    continue

                kept += 1
                state_code = TARGET_STATES[state_full]
                event_id = row.get("EVENT_ID", "").strip()
                row_year = row.get("YEAR", "").strip()
                county = row.get("CZ_NAME", "").strip()
                peak_wind_raw = row.get("MAGNITUDE", "").strip()
                damage_raw = row.get("DAMAGE_PROPERTY", "").strip()

                try:
                    peak_wind = float(peak_wind_raw) if peak_wind_raw else None
                except ValueError:
                    peak_wind = None

                damage_property = parse_damage_property(damage_raw)

                batch.append((
                    event_id,
                    int(row_year) if row_year else year,
                    state_code,
                    county,
                    event_type,
                    peak_wind,
                    damage_property,
                    "NOAA Storm Events",
                ))

                if len(batch) >= BATCH_SIZE:
                    inserted += flush(batch)
                    batch.clear()

        inserted += flush(batch)
        conn.commit()
    finally:
        conn.close()
        resp.close()

    return fetched, kept, inserted


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest NOAA Storm Events into forge-local.db"
    )
    parser.add_argument(
        "--years",
        required=True,
        help="Year(s) to ingest: single (2024), range (2018-2024), or comma list (2020,2022,2024)",
    )
    args = parser.parse_args()

    years = parse_years(args.years)

    session = requests.Session()
    session.headers.update({"User-Agent": "FORGE-ingest/1.0 (research)"})

    skipped: list[int] = []
    for year in years:
        try:
            fetched, kept, inserted = stream_year(year, session)
            print(f"{year}: fetched {fetched} rows, kept {kept}, inserted {inserted}")
        except requests.exceptions.RequestException as exc:
            print(f"  {year}: SKIPPED (network error: {exc})", file=sys.stderr)
            skipped.append(year)
            continue

    session.close()
    if skipped:
        print(f"Done. Skipped years: {skipped}")
    else:
        print("Done.")


if __name__ == "__main__":
    main()
