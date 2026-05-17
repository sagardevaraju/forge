"""Task 12 — Monte Carlo scenario generator for FORGE.

Produces the shared scenario set consumed by the portfolio MIP, VRP, and
claims pre-flagger.  For a given ``storm_id``, returns ``n`` perturbed
realisations of a synthetic Cat-4 Gulf hurricane bearing on the Florida
west coast.  Each scenario carries:

    * a 21-point 5-day track (6-hour spacing)
    * a perturbed peak wind in mph
    * a per-ZIP3 surge depth grid in metres
    * an equal probability weight (1/n)

Task P2.38 — the generator now accepts an optional ``ensemble`` argument
holding the real GEFS ensemble members served by ``fetch_nhc_cone``.
When provided, each scenario is seeded from one ensemble member
(resampled uniformly to reach the requested ``n``), so the output
distribution reflects the real forecast uncertainty rather than a
parametric Gaussian assumption.  When ``ensemble`` is None or empty,
the historical parametric path runs unchanged — existing callers see
bit-exactly the same draws.

Real-path data source
---------------------
NHC publishes the GEFS ensemble publicly via the AIDS a-deck:

    https://ftp.nhc.noaa.gov/atcf/aid_public/a<basin><NN><YYYY>.dat

``fetch_nhc_cone`` (TypeScript) parses the ATCF rows and filters to
GEFS ensemble tech codes (AC01..AC20, AP01..AP20). The ``ensemble=``
kwarg is currently a library-only API — the ``/api/scenarios`` HTTP
route does not yet forward ensemble members from the TS proxy, so
end-to-end live wiring is a follow-up. Unit + ensemble-path tests
cover the library contract.
"""

from __future__ import annotations

import math
from typing import Iterable

import numpy as np

# ── physical / calibration constants ───────────────────────────────────────

# Approximate 5-day NHC track-error std in degrees (≈175 statute miles).
# 1° lat ≈ 69 mi, so 2.5° ≈ 173 mi.  We grow σ linearly with hours.
_TRACK_SIGMA_AT_120H_DEG = 2.5

# Peak-wind perturbation grows from 0 mph at t=0 to ~15 mph at t=120h.
_WIND_SIGMA_AT_120H_MPH = 15.0

# Forecast horizon in hours.
_HORIZON_H = 120
_STEP_H = 6  # 6-hour spacing → 21 waypoints including hour 0.

# Surge model — distance-decay e-fold scale (km).  Within ~30 km of the
# track, surge is at its peak; it decays exponentially beyond.
_SURGE_DECAY_KM = 30.0

# Reference peak surge depth (m) when peak wind is at _SURGE_REF_WIND mph
# and the policy sits right on the track.
_SURGE_REF_DEPTH_M = 4.0
_SURGE_REF_WIND_MPH = 140.0

# ── demo seed track (Cat-4 FL-west-coast landfall) ─────────────────────────
#
# 21 waypoints (hours 0, 6, 12, …, 120).  Starts west of the Florida
# Keys, recurves NNW into the Big Bend, makes landfall near hour 60,
# and weakens inland over GA.

_DEMO_TRACK_FL: list[dict[str, float]] = [
    {"lat": 24.0, "lon": -83.0, "hours_from_now": 0,   "peak_wind": 110.0},
    {"lat": 24.5, "lon": -83.3, "hours_from_now": 6,   "peak_wind": 115.0},
    {"lat": 25.1, "lon": -83.6, "hours_from_now": 12,  "peak_wind": 120.0},
    {"lat": 25.8, "lon": -83.9, "hours_from_now": 18,  "peak_wind": 125.0},
    {"lat": 26.5, "lon": -84.0, "hours_from_now": 24,  "peak_wind": 128.0},
    {"lat": 27.1, "lon": -84.0, "hours_from_now": 30,  "peak_wind": 132.0},
    {"lat": 27.7, "lon": -83.9, "hours_from_now": 36,  "peak_wind": 135.0},
    {"lat": 28.2, "lon": -83.6, "hours_from_now": 42,  "peak_wind": 138.0},
    {"lat": 28.6, "lon": -83.2, "hours_from_now": 48,  "peak_wind": 140.0},
    {"lat": 29.0, "lon": -82.7, "hours_from_now": 54,  "peak_wind": 140.0},
    {"lat": 29.3, "lon": -82.1, "hours_from_now": 60,  "peak_wind": 140.0},  # landfall
    {"lat": 29.7, "lon": -81.6, "hours_from_now": 66,  "peak_wind": 120.0},
    {"lat": 30.1, "lon": -81.2, "hours_from_now": 72,  "peak_wind": 100.0},
    {"lat": 30.6, "lon": -80.9, "hours_from_now": 78,  "peak_wind":  85.0},
    {"lat": 31.1, "lon": -80.6, "hours_from_now": 84,  "peak_wind":  75.0},
    {"lat": 31.6, "lon": -80.4, "hours_from_now": 90,  "peak_wind":  65.0},
    {"lat": 32.1, "lon": -80.3, "hours_from_now": 96,  "peak_wind":  55.0},
    {"lat": 32.6, "lon": -80.2, "hours_from_now": 102, "peak_wind":  50.0},
    {"lat": 33.1, "lon": -80.1, "hours_from_now": 108, "peak_wind":  45.0},
    {"lat": 33.6, "lon": -80.0, "hours_from_now": 114, "peak_wind":  40.0},
    {"lat": 34.1, "lon":  -79.9, "hours_from_now": 120, "peak_wind":  35.0},
]
assert len(_DEMO_TRACK_FL) == 21, "demo seed track must be 21 waypoints"

# ── coastal ZIP3 catalog (Gulf + South-Atlantic exposure) ──────────────────
#
# Representative coastal ZIP3 centroids and approximate ground elevations
# (m above MSL) for the FORGE book.  Keys are 3-digit ZIP prefixes as
# strings (matching ``policies.zip3``).  This is intentionally small: the
# Cat-4 demo storm exposes ~15 ZIP3s across FL, GA, SC, AL, MS, LA.

_COASTAL_ZIP3S: dict[str, dict[str, float]] = {
    # Florida west coast
    "335": {"lat": 27.95, "lon": -82.46, "elev_m": 3.0},   # Tampa
    "337": {"lat": 27.77, "lon": -82.64, "elev_m": 2.0},   # St. Petersburg
    "339": {"lat": 26.64, "lon": -81.87, "elev_m": 4.0},   # Fort Myers
    "341": {"lat": 26.14, "lon": -81.79, "elev_m": 2.0},   # Naples
    "342": {"lat": 27.34, "lon": -82.53, "elev_m": 3.0},   # Sarasota
    "344": {"lat": 29.65, "lon": -82.33, "elev_m": 14.0},  # Gainesville (inland)
    "346": {"lat": 28.78, "lon": -82.04, "elev_m": 8.0},   # Brooksville
    # Florida east coast & panhandle
    "320": {"lat": 30.33, "lon": -81.65, "elev_m": 5.0},   # Jacksonville
    "325": {"lat": 30.44, "lon": -84.28, "elev_m": 19.0},  # Tallahassee
    "326": {"lat": 29.19, "lon": -82.13, "elev_m": 12.0},  # Ocala
    # Georgia / SC coast
    "314": {"lat": 32.08, "lon": -81.09, "elev_m": 12.0},  # Savannah
    "294": {"lat": 32.78, "lon": -79.93, "elev_m": 6.0},   # Charleston
    # Gulf coast — AL/MS/LA
    "365": {"lat": 30.69, "lon": -88.04, "elev_m": 3.0},   # Mobile
    "395": {"lat": 30.40, "lon": -88.89, "elev_m": 2.0},   # Gulfport
    "704": {"lat": 29.95, "lon": -90.07, "elev_m": 1.0},   # New Orleans
}


# ── helpers ────────────────────────────────────────────────────────────────


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2.0) ** 2
    c = 2.0 * math.asin(min(1.0, math.sqrt(a)))
    return r * c


def _min_distance_to_track_km(
    lat: float,
    lon: float,
    path: Iterable[dict[str, float]],
) -> float:
    """Minimum great-circle distance (km) from (lat, lon) to any track point.

    A real implementation would interpolate between waypoints; with 6-hour
    spacing the difference is small enough that nearest-vertex is fine for
    a per-ZIP3 surge proxy.
    """
    return min(_haversine_km(lat, lon, p["lat"], p["lon"]) for p in path)


def _surge_depth(
    distance_km: float,
    peak_wind_mph: float,
    elevation_m: float,
) -> float:
    """Simple surge model: exponential decay with track distance,
    scaled by (wind / reference wind)², minus ground elevation.

    Returns surge depth (m) at the ZIP3 centroid, clipped at 0.
    """
    wind_scale = (peak_wind_mph / _SURGE_REF_WIND_MPH) ** 2
    raw = _SURGE_REF_DEPTH_M * wind_scale * math.exp(-distance_km / _SURGE_DECAY_KM)
    depth = raw - elevation_m * 0.25  # elevation knocks down inundation
    return max(0.0, round(depth, 3))


def _storm_seed(storm_id: str) -> int:
    """Stable 32-bit seed derived from ``storm_id`` for reproducibility."""
    # Python's hash() is salted across runs; use a deterministic hash.
    h = 0
    for c in storm_id:
        h = (h * 1315423911) ^ ord(c)
        h &= 0xFFFFFFFF
    return h or 1


# ── public API ─────────────────────────────────────────────────────────────


def _scenarios_from_ensemble(
    storm_id: str,
    n: int,
    ensemble: list[dict],
    regime: dict | None,
    correlation: dict | None = None,
) -> list[dict]:
    """Build ``n`` scenarios by resampling the GEFS ensemble members.

    Each output scenario is seeded from one member's forecast track,
    translated into the canonical scenario schema (``path`` uses
    ``lon``/``hours_from_now``, while the input ensemble uses
    ``lng``/``t_hours`` per the TS tool contract).  We sample members
    deterministically (round-robin starting from a storm-seeded offset)
    so the resampling is reproducible without drawing from numpy's RNG —
    that keeps the parametric path's RNG sequence intact.

    Task P2.38.
    """
    rng = np.random.default_rng(_storm_seed(storm_id))
    # Round-robin assignment with a storm-seeded jitter so two storms
    # with the same N pick different starting members; within one storm
    # the assignment is reproducible.
    offset = int(rng.integers(0, max(1, len(ensemble))))
    scenarios: list[dict] = []
    prob = 1.0 / n
    for i in range(n):
        member = ensemble[(offset + i) % len(ensemble)]
        member_id = str(member.get("member_id", f"M{(offset + i) % len(ensemble):02d}"))
        raw_track = member.get("track") or []
        # Normalise track schema: the TS tool emits {lat, lng, t_hours,
        # peak_wind}; downstream we expose {lat, lon, hours_from_now}.
        path: list[dict[str, float]] = []
        member_peak = 0.0
        for pt in raw_track:
            lat = float(pt.get("lat", 0.0))
            lon = float(pt.get("lon", pt.get("lng", 0.0)))
            t_h = int(pt.get("hours_from_now", pt.get("t_hours", 0)))
            pw = float(pt.get("peak_wind", 0.0))
            if pw > member_peak:
                member_peak = pw
            path.append({"lat": round(lat, 4), "lon": round(lon, 4), "hours_from_now": t_h})
        # Empty member track ⇒ defensive: synthesize a single point at
        # the FL demo start so the scenario shape is still well-formed.
        if not path:
            path.append({"lat": 24.0, "lon": -83.0, "hours_from_now": 0})
            member_peak = 130.0
        peak_wind = round(max(35.0, min(215.0, member_peak)), 1)
        # Per-ZIP3 surge grid identical to the parametric path's model.
        surge_grid: dict[str, float] = {}
        for zip3, meta in _COASTAL_ZIP3S.items():
            dist_km = _min_distance_to_track_km(meta["lat"], meta["lon"], path)
            surge_grid[zip3] = _surge_depth(dist_km, peak_wind, meta["elev_m"])
        scenario: dict = {
            "id": f"{storm_id}_{i + 1:04d}",
            "path": path,
            "peak_wind": peak_wind,
            "surge_grid": surge_grid,
            "prob": prob,
            "member_id": member_id,
        }
        if regime is not None:
            scenario["regime"] = regime
        if correlation is not None:
            # P2.4 plumbing — common-factor (β, σ) ride along as metadata.
            scenario["correlation"] = correlation
        scenarios.append(scenario)
    # Normalise (handles n where 1/n isn't exactly representable in float).
    total = sum(s["prob"] for s in scenarios)
    if total > 0 and abs(total - 1.0) > 1e-9:
        for s in scenarios:
            s["prob"] = s["prob"] / total
    return scenarios


def generate_scenarios(
    storm_id: str,
    n: int = 1000,
    seed_track: list[dict] | None = None,
    regime: dict | None = None,
    ensemble: list[dict] | None = None,
    correlation: dict | None = None,
) -> list[dict]:
    """Generate ``n`` Monte-Carlo scenarios for ``storm_id``.

    Parameters
    ----------
    storm_id:
        Opaque storm identifier (e.g. ``"AL092024"``).  Used as the RNG
        seed and embedded in each scenario id (e.g. ``"AL092024_0001"``).
    n:
        Number of perturbed scenarios to draw.  Defaults to 1000.
    seed_track:
        Optional list of 21 dicts at 6-hour spacing.  Each dict must
        contain ``lat``, ``lon``, ``hours_from_now``, and optionally
        ``peak_wind``.  If omitted, a built-in Cat-4 Florida-bound seed
        is used.
    regime:
        Optional AMO/ENSO regime label (typically the return value of
        :func:`ml.scenarios.regime.regime_label`).  Task P2.3 plumbing —
        attached to every scenario as metadata so downstream consumers
        can see the conditioning context.  P2.4+ will use this to bias
        the scenario draws; for now it is pass-through.
    ensemble:
        Optional list of GEFS ensemble member dicts as returned by the
        ``fetch_nhc_cone`` TS tool.  Each member must shape as
        ``{"member_id": str, "track": [{"lat", "lng", "t_hours",
        "peak_wind"}, …]}``.  When provided and non-empty, scenarios
        are resampled from these members (one member per scenario,
        round-robin to reach ``n``) rather than drawn from the
        parametric Gaussian perturbation.  ``None`` or ``[]`` falls
        back to the parametric path so existing callers are unaffected.
        Task P2.38.
    correlation:
        Optional ``{"beta": float, "sigma": float}`` dict for the
        common-factor event-residual loss correlation (Task P2.4).
        Pass-through metadata only — the actual multiplication happens
        downstream at loss-realization time via
        :func:`api_py.correlation.apply_common_factor` (wired into the
        per-cohort loss draw in P2.6 / P2.7).

    Returns
    -------
    list[dict]
        ``n`` scenario dicts.  Probability weights sum to 1.  When the
        ensemble path is used each scenario additionally carries a
        ``member_id`` key identifying its source ensemble member.
    """
    if n <= 0:
        return []

    # Task P2.38 — when a non-empty ensemble is supplied, resample from
    # it.  Empty / None ⇒ parametric path (backward compat).
    if ensemble:
        return _scenarios_from_ensemble(storm_id, n, list(ensemble), regime, correlation)

    track = seed_track if seed_track is not None else _DEMO_TRACK_FL
    if len(track) < 2:
        raise ValueError("seed_track must have at least 2 waypoints")

    # Anchor peak-wind to a derived "seed peak" for the storm.  If the
    # track waypoints carry per-step wind, use the max; otherwise default
    # to 130 mph (a Cat-4).
    seed_peak_winds = [float(p.get("peak_wind", float("nan"))) for p in track]
    if any(not math.isnan(w) for w in seed_peak_winds):
        seed_peak = max(w for w in seed_peak_winds if not math.isnan(w))
    else:
        seed_peak = 130.0

    rng = np.random.default_rng(_storm_seed(storm_id))

    # Pre-compute per-waypoint perturbation σ.  Track-error σ scales
    # linearly with hours_from_now, hitting 2.5° at hour 120.
    horizons = np.array([float(p["hours_from_now"]) for p in track])
    track_sigmas = _TRACK_SIGMA_AT_120H_DEG * horizons / _HORIZON_H  # deg
    # Wind-perturbation σ same linear ramp, but capped at 15 mph.
    wind_sigma = _WIND_SIGMA_AT_120H_MPH  # applied as a single per-scenario draw

    scenarios: list[dict] = []
    prob = 1.0 / n

    for i in range(n):
        # Track perturbation: independent Gaussian on each waypoint.
        # A more sophisticated model would correlate consecutive
        # perturbations along a smooth bias; for FORGE the independent
        # draw still produces realistic endpoint dispersion.
        lat_noise = rng.normal(0.0, track_sigmas)
        lon_noise = rng.normal(0.0, track_sigmas)

        path = [
            {
                "lat": round(float(p["lat"] + lat_noise[k]), 4),
                "lon": round(float(p["lon"] + lon_noise[k]), 4),
                "hours_from_now": int(p["hours_from_now"]),
            }
            for k, p in enumerate(track)
        ]

        # Peak-wind perturbation.  Single per-scenario draw so the entire
        # track shifts intensity coherently.
        peak_wind = float(rng.normal(seed_peak, wind_sigma))
        # Clamp to physically plausible: TS-floor 35 mph, hard cap 215 mph
        peak_wind = max(35.0, min(215.0, peak_wind))
        peak_wind = round(peak_wind, 1)

        # Per-ZIP3 surge depth grid.
        surge_grid: dict[str, float] = {}
        for zip3, meta in _COASTAL_ZIP3S.items():
            dist_km = _min_distance_to_track_km(meta["lat"], meta["lon"], path)
            surge_grid[zip3] = _surge_depth(dist_km, peak_wind, meta["elev_m"])

        scenario = {
            "id": f"{storm_id}_{i + 1:04d}",
            "path": path,
            "peak_wind": peak_wind,
            "surge_grid": surge_grid,
            "prob": prob,
        }
        if regime is not None:
            # P2.3 plumbing — regime label rides along as scenario metadata.
            # P2.4+ will branch the draw math on this; for now it is opaque.
            scenario["regime"] = regime
        if correlation is not None:
            # P2.4 plumbing — common-factor (β, σ) ride along as metadata.
            # The actual L'_{s,c} = L_{s,c}·(1 + β·ε_s) multiplication is
            # applied downstream via api_py.correlation.apply_common_factor
            # when per-cohort losses are materialized (P2.6 / P2.7).
            scenario["correlation"] = correlation
        scenarios.append(scenario)

    # Normalise (handles n where 1/n isn't exactly representable in float).
    total = sum(s["prob"] for s in scenarios)
    if total > 0 and abs(total - 1.0) > 1e-9:
        for s in scenarios:
            s["prob"] = s["prob"] / total

    return scenarios


__all__ = ["generate_scenarios"]
