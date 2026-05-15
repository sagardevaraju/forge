"""Task 10 — HAZUS loss synthesis for XGBoost training data.

For each (policy, storm_event) pair where the policy's state matches the
storm event's state, generate a synthetic training row using HAZUS wind and
surge damage curves.  Saves output to artifacts/xgb_training.parquet.
"""

from __future__ import annotations

import json
import pathlib
import sqlite3

import numpy as np
import pandas as pd

from ml.xgb.hazus_curves import surge_damage_ratio, wind_damage_ratio

# ── constants ──────────────────────────────────────────────────────────────
DB_PATH = pathlib.Path("forge-local.db")
ARTIFACTS_DIR = pathlib.Path("artifacts")
OUT_PATH = ARTIFACTS_DIR / "xgb_training.parquet"

COASTAL_FLOOD_ZONES = {"VE", "AE"}

# Per-event-type peak-wind sampling distributions (mean, std) in mph
WIND_DIST: dict[str, tuple[float, float]] = {
    "Hurricane (Typhoon)": (120.0, 25.0),
    "Tropical Storm": (70.0, 15.0),
    "Tropical Depression": (40.0, 10.0),
}
DEFAULT_WIND_DIST = (70.0, 15.0)  # fallback

# Event-type one-hot keys (keep insertion order)
EVENT_TYPE_KEYS = [
    "Hurricane (Typhoon)",
    "Tropical Storm",
    "Tropical Depression",
]

FLOOD_ZONE_KEYS = ["X", "AE", "A", "VE"]  # X is default/reference

# ── helpers ────────────────────────────────────────────────────────────────

RNG = np.random.default_rng(seed=42)


def sample_peak_wind(event_type: str, peak_wind_in_db: float | None) -> float:
    """Return a peak wind speed in mph for the event."""
    if peak_wind_in_db is not None and not np.isnan(peak_wind_in_db):
        return float(peak_wind_in_db)
    mu, sigma = WIND_DIST.get(event_type, DEFAULT_WIND_DIST)
    # Clip to sensible range: never below 20 mph
    return float(max(20.0, RNG.normal(mu, sigma)))


def sample_distance_from_track() -> float:
    """Sample distance (km) from storm track centerline.

    Uses a Pareto-like distribution: most properties are within 50 km of the
    track, with a fat tail out to several hundred km.  Equivalent to sampling
    a log-normal with median ~30 km.
    """
    return float(np.exp(RNG.normal(loc=np.log(30.0), scale=1.2)))


def wind_at_property(peak_wind: float, distance_km: float) -> float:
    """Exponential decay of peak wind with distance from track (in km).

    wind = peak_wind * exp(-distance / 80.5)
    (80.5 km ≈ 50 miles — the e-folding distance used in the spec)
    """
    return float(peak_wind * np.exp(-distance_km / 80.5))


def sample_surge_depth(peak_wind: float) -> float:
    """Synthetic surge depth above MSL (metres), scaled by wind speed.

    Only used for coastal flood-zone policies (VE, AE).
    Higher wind → higher surge, log-normal noise.
    """
    base = (peak_wind / 100.0) * 3.0  # up to ~3.6 m at Cat-4
    return float(max(0.0, base * np.exp(RNG.normal(0.0, 0.4))))


# ── load data ──────────────────────────────────────────────────────────────

def load_policies(conn: sqlite3.Connection) -> pd.DataFrame:
    df = pd.read_sql_query(
        "SELECT id, state, tiv, build_year, build_type, flood_zone, "
        "elevation_m, cv_features FROM policies",
        conn,
    )
    # Parse cv_features JSON string → 8 float columns
    cv_matrix = np.array(
        [json.loads(row) for row in df["cv_features"]],
        dtype=np.float32,
    )
    for i in range(cv_matrix.shape[1]):
        df[f"cv_{i}"] = cv_matrix[:, i]
    df.drop(columns=["cv_features"], inplace=True)

    # One-hot flood_zone
    for z in FLOOD_ZONE_KEYS[1:]:  # X is dropped (reference)
        df[f"fz_{z}"] = (df["flood_zone"] == z).astype(np.float32)

    # Numeric elevation — fill nulls with 0
    df["elevation_m"] = df["elevation_m"].fillna(0.0).astype(np.float32)
    df["build_year"] = df["build_year"].fillna(1990).astype(np.float32)
    df["tiv"] = df["tiv"].astype(np.float32)
    return df


def load_events(conn: sqlite3.Connection) -> pd.DataFrame:
    df = pd.read_sql_query(
        "SELECT id AS event_id_int, event_type, state, year, peak_wind "
        "FROM storm_events",
        conn,
    )
    # One-hot event_type
    for et in EVENT_TYPE_KEYS[1:]:  # Hurricane is reference
        df[f"et_{et.replace(' ', '_').replace('(', '').replace(')', '')}"] = (
            df["event_type"] == et
        ).astype(np.float32)
    df["year"] = df["year"].astype(np.float32)
    return df


# ── synthesis loop ─────────────────────────────────────────────────────────

def synthesize(policies: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """Generate one training row per (policy, storm_event) pair in same state."""
    rows: list[dict] = []

    # Index policies by state for fast lookup
    state_groups = {state: grp for state, grp in policies.groupby("state")}

    for _, ev in events.iterrows():
        state = ev["state"]
        if state not in state_groups:
            continue
        state_pols = state_groups[state]

        pk_wind_db = ev["peak_wind"]
        event_type = ev["event_type"]

        # One peak-wind sample per event (same storm, different distances per property)
        ev_peak_wind = sample_peak_wind(event_type, pk_wind_db)

        for _, pol in state_pols.iterrows():
            dist_km = sample_distance_from_track()
            wind_prop = wind_at_property(ev_peak_wind, dist_km)

            is_coastal = pol["flood_zone"] in COASTAL_FLOOD_ZONES
            if is_coastal:
                surge_d = sample_surge_depth(ev_peak_wind)
            else:
                surge_d = 0.0

            elev = float(pol["elevation_m"])
            build_type = pol["build_type"] if pol["build_type"] in (
                "wood_frame", "masonry", "manufactured"
            ) else "wood_frame"

            dr_wind = wind_damage_ratio(wind_prop, build_type)
            dr_surge = surge_damage_ratio(surge_d, elev) if is_coastal else 0.0
            loss_ratio = max(dr_wind, dr_surge)

            tiv = float(pol["tiv"])
            noise = float(RNG.normal(0.0, 0.05)) * tiv
            loss_dollars = float(np.clip(loss_ratio * tiv + noise, 0.0, tiv))

            row: dict = {
                # Policy features
                "tiv": tiv,
                "build_year": float(pol["build_year"]),
                "elevation_m": elev,
                # cv features (8 dims)
                **{f"cv_{i}": float(pol[f"cv_{i}"]) for i in range(8)},
                # flood-zone one-hots
                **{f"fz_{z}": float(pol[f"fz_{z}"]) for z in FLOOD_ZONE_KEYS[1:]},
                # Event features
                "event_peak_wind": ev_peak_wind,
                "year": float(ev["year"]),
                # Event-type one-hots
                **{
                    f"et_{et.replace(' ', '_').replace('(', '').replace(')', '')}": float(ev.get(
                        f"et_{et.replace(' ', '_').replace('(', '').replace(')', '')}", 0.0
                    ))
                    for et in EVENT_TYPE_KEYS[1:]
                },
                # Scenario features
                "wind_at_property": wind_prop,
                "distance_from_track_km": dist_km,
                "surge_depth_m": surge_d,
                # Target
                "loss_dollars": loss_dollars,
            }
            rows.append(row)

    return pd.DataFrame(rows)


# ── main ───────────────────────────────────────────────────────────────────

def main() -> None:
    ARTIFACTS_DIR.mkdir(exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    print("Loading policies …")
    policies = load_policies(conn)
    print(f"  {len(policies):,} policies loaded")

    print("Loading storm events …")
    events = load_events(conn)
    print(f"  {len(events):,} storm events loaded")
    conn.close()

    print("Synthesizing training pairs …")
    df = synthesize(policies, events)
    print(f"  {len(df):,} training rows generated")

    print(f"Saving to {OUT_PATH} …")
    df.to_parquet(OUT_PATH, index=False)

    # Quick distribution summary
    ld = df["loss_dollars"]
    print(f"\nloss_dollars summary:")
    print(f"  min={ld.min():.2f}  p05={ld.quantile(0.05):.2f}  "
          f"p50={ld.quantile(0.50):.2f}  p95={ld.quantile(0.95):.2f}  "
          f"max={ld.max():.2f}")
    zeros = (ld == 0.0).sum()
    print(f"  exact zeros: {zeros:,} ({100*zeros/len(ld):.1f}%)")
    import os
    sz = os.path.getsize(OUT_PATH)
    print(f"  file size: {sz/1e6:.1f} MB")
    print("Done.")


if __name__ == "__main__":
    main()
