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

import functools
import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np

# ── NHC OFCL forecast-error climatology (AUDIT.3 Phase 2a) ────────────────
#
# Track-error and intensity-error σs are no longer hand-coded.  They are
# loaded on first call from the committed climatology artifacts at
# ``artifacts/nhc/{track_error,intensity_error}.json`` (produced by
# ``scripts/fetch_nhc_errors.py``).  See
# ``docs/scoping/audit-3-nhc-track-error-usgs-ned.md`` §4 Phase 2.
#
# Track σ is derived from the empirical cone radius via the 2D-Gaussian
# 67%-containment inverse-cdf — by construction, scenarios drawn with
# this σ reconstruct the NHC cone of uncertainty.  Concretely, for a 2D
# isotropic Gaussian, P(r < σ·c) = 1 - exp(-c²/2) = 0.67 ⇒
# c = sqrt(-2·ln(0.33)) ≈ 1.4824.  So σ = r67 / 1.4824.

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TRACK_ERROR_JSON = _REPO_ROOT / "artifacts" / "nhc" / "track_error.json"
_INTENSITY_ERROR_JSON = _REPO_ROOT / "artifacts" / "nhc" / "intensity_error.json"

# 67-percentile to Gaussian-σ conversion (see derivation above).
_R67_TO_SIGMA = 1.0 / math.sqrt(-2.0 * math.log(0.33))  # ≈ 0.6745

# 1 nautical mile = 1.150779 statute miles (NIST).
_KT_TO_MPH = 1.150779
# 1 nautical mile = 1/60 degree of latitude (great-circle definition).
_NM_PER_DEG_LAT = 60.0

# NHC publishes σ at these forecast hours; matches FORECAST_HOURS_PRIMARY
# in ``scripts/fetch_nhc_errors.py``.
_NHC_FORECAST_HOURS = (12, 24, 36, 48, 60, 72, 96, 120)

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

# ── basin-aware seed tracks from HURDAT2 (AUDIT.3 Phase 2b) ────────────────
#
# Previous implementation hand-tabulated three 21-waypoint Cat-4 composites
# (``_DEMO_TRACK_FL``, ``_DEMO_TRACK_CARIBBEAN``, ``_DEMO_TRACK_ATLANTIC_CANADA``).
# Per the no-fictional-data contract and the AUDIT.3 Phase 2 scoping doc,
# each basin's seed track is now sampled from the committed HURDAT2
# best-track parquet at ``artifacts/hurdat2/best_track.parquet`` (PR #20
# / Task P2.10), using a landmark major-hurricane landfall per region:
#
#   us_atlantic      — AL092022  Hurricane Ian   (Cat-4, SW Florida landfall)
#   caribbean        — AL152017  Hurricane Maria (Cat-4 at PR landfall)
#   atlantic_canada  — AL072022  Hurricane Fiona (Cat-2 at Nova Scotia landfall)
#
# All three are public-domain, well-documented, recent storms that produce
# clean 21-waypoint 6-hour-cadence tracks in HURDAT2.  ``seed_storm_id=``
# overrides the landmark default for callers that want a different storm.

_LANDMARK_STORM_BY_BASIN: dict[str, str] = {
    "us_atlantic": "AL092022",      # Hurricane Ian (2022)
    "caribbean": "AL152017",        # Hurricane Maria (2017)
    "atlantic_canada": "AL072022",  # Hurricane Fiona (2022)
}

# HURDAT2 records track points at standard 6-hour synoptic times (00, 06,
# 12, 18 UTC) plus intermediate "special advisories" near landfall with
# off-cadence timestamps (e.g., 19:05 UTC).  We filter to standard times
# so the 21-row slice has uniform 6-hour spacing.
_HURDAT2_STANDARD_HOURS = (0, 6, 12, 18)

_KT_TO_MPH_FACTOR = 1.150779  # NIST conversion (1 nm = 1.150779 stat mi).


@functools.lru_cache(maxsize=None)
def sample_basin_seed_track(
    basin: str,
    *,
    seed_storm_id: str | None = None,
) -> list[dict[str, float]]:
    """Return a 21-waypoint 6-hour-spacing track sampled from HURDAT2.

    Replaces the hand-tabulated ``_DEMO_TRACK_*`` literals removed in
    AUDIT.3 Phase 2b.  By default each basin maps to a landmark
    major-hurricane landfall (Ian / Maria / Fiona); pass ``seed_storm_id=``
    to override with any HURDAT2 storm id (e.g., ``"AL142016"`` for
    Hurricane Matthew).

    Deterministic for a given ``(basin, seed_storm_id)`` pair — the
    function is ``@lru_cache``-memoized on its inputs.

    Parameters
    ----------
    basin:
        One of ``"us_atlantic"``, ``"caribbean"``, ``"atlantic_canada"``.
    seed_storm_id:
        Optional HURDAT2 storm id (e.g., ``"AL092022"``); when ``None``
        uses the basin's landmark default.

    Returns
    -------
    list[dict]
        21 waypoints, each ``{"lat", "lon", "hours_from_now", "peak_wind"}``.
        Hour 0 is the first standard-cadence row of the storm's HURDAT2
        record; peak_wind is converted from knots to mph using the NIST
        factor 1.150779.

    Raises
    ------
    ValueError
        Unknown basin.
    RuntimeError
        Storm not in HURDAT2 parquet, or storm has < 21 standard-cadence
        rows (would be a data-integrity surprise — every landmark default
        has been verified to have ≥ 21 such rows).
    """
    if basin not in _LANDMARK_STORM_BY_BASIN:
        raise ValueError(
            f"unknown basin {basin!r}; expected one of "
            f"{sorted(_LANDMARK_STORM_BY_BASIN)}")
    storm_id = seed_storm_id or _LANDMARK_STORM_BY_BASIN[basin]

    # Imported lazily so test fixtures that don't need HURDAT2 don't
    # pay the parquet-load cost on import of this module.
    from ml.scenarios.hurdat2 import parse_hurdat2  # noqa: PLC0415
    df = parse_hurdat2()
    rows = df[df["storm_id"] == storm_id].sort_values("timestamp")
    if rows.empty:
        raise RuntimeError(
            f"storm {storm_id!r} not in HURDAT2 parquet at "
            f"artifacts/hurdat2/best_track.parquet")

    # Keep only standard 6-hour synoptic-time rows.
    standard_mask = (
        (rows["timestamp"].dt.minute == 0)
        & (rows["timestamp"].dt.hour.isin(_HURDAT2_STANDARD_HOURS))
    )
    rows = rows[standard_mask]
    if len(rows) < 21:
        raise RuntimeError(
            f"storm {storm_id!r} has only {len(rows)} standard-cadence "
            f"rows in HURDAT2; need ≥ 21 for a 5-day seed window")
    rows = rows.iloc[:21]

    t0 = rows.iloc[0]["timestamp"]
    track: list[dict[str, float]] = []
    for _, r in rows.iterrows():
        hours_from_now = int((r["timestamp"] - t0).total_seconds() // 3600)
        track.append({
            "lat": float(r["lat"]),
            "lon": float(r["lon"]),
            "hours_from_now": hours_from_now,
            "peak_wind": round(
                float(r["max_wind_kts"]) * _KT_TO_MPH_FACTOR, 1),
        })
    return track

# ── coastal ZIP3 catalog (AUDIT.3 Phase 4) ────────────────────────────────
#
# Previously a hand-coded 15-ZIP3 literal with eyeball-estimated lat/lon
# and elevation.  Replaced by ``artifacts/coastal_zip3s.json`` —
# regenerable from real data via ``scripts/precompute_coastal_zip3s.py``:
#
#   - Each ZIP3's centroid (lat, lon) is the AVG over all policies in
#     that ZIP3 in the policy table (filtered to coastal-state set).
#   - Each elevation comes from USGS NED 1/3-arcsec via the EPQS
#     endpoint at the centroid.
#
# The catalog covers ~38 ZIP3s across FL/TX/LA/AL/MS/GA/SC/NC instead
# of the original cherry-picked 15 — broader coverage is harmless
# because the surge model's exponential distance decay zeroes the
# contribution for any ZIP3 the storm doesn't approach.

_COASTAL_ZIP3S_ARTIFACT = (
    _REPO_ROOT / "artifacts" / "coastal_zip3s.json")


@functools.lru_cache(maxsize=1)
def _load_coastal_zip3_catalog() -> dict[str, dict[str, float]]:
    """Return ``{zip3: {"lat", "lon", "elev_m"}}`` keyed by 3-digit
    ZIP3 string.  Reads ``artifacts/coastal_zip3s.json`` lazily on
    first call and memoizes for the lifetime of the process."""
    if not _COASTAL_ZIP3S_ARTIFACT.exists():
        raise RuntimeError(
            f"coastal ZIP3 catalog missing at "
            f"{_COASTAL_ZIP3S_ARTIFACT.relative_to(_REPO_ROOT)}; "
            f"run `python -m scripts.precompute_coastal_zip3s` "
            f"to regenerate it from the policy book")
    payload = json.loads(_COASTAL_ZIP3S_ARTIFACT.read_text())
    # The committed JSON is a dict-of-dicts; strip the n_policies
    # bookkeeping field that scenario code doesn't need.
    return {
        zip3: {
            "lat": float(entry["lat"]),
            "lon": float(entry["lon"]),
            "elev_m": float(entry["elev_m"]),
        }
        for zip3, entry in payload["catalog"].items()
    }


# ── NHC climatology loader (AUDIT.3 Phase 2a) ──────────────────────────────


@functools.lru_cache(maxsize=1)
def _load_nhc_climatology() -> tuple[dict[int, float], dict[int, float]]:
    """Return ``(track_sigma_nm_by_hour, wind_sigma_kt_by_hour)``.

    Both tables include an explicit ``{0: 0.0}`` entry — the verification
    error at lead zero is zero by definition.

    Track σ at each forecast hour is derived from the *empirical*
    OFCL total-track cone radius (the 67th percentile of historical
    total-track errors over the rolling 5-year window).  Scenarios
    drawn with this σ on lat and lon independently reconstruct the
    NHC cone-of-uncertainty by construction.

    Wind σ is the sample standard deviation of OFCL signed
    peak-wind error over the same window.

    Cached after first call — the JSON artifacts are read-only at
    runtime and don't change between scenario draws.
    """
    track_json = json.loads(_TRACK_ERROR_JSON.read_text())
    intensity_json = json.loads(_INTENSITY_ERROR_JSON.read_text())

    cone_by_hour = track_json["cone_radii_empirical"]["by_hour"]
    track_sigma: dict[int, float] = {0: 0.0}
    for hour in _NHC_FORECAST_HOURS:
        r67 = cone_by_hour[str(hour)]["cone_radius_p67_nm"]
        track_sigma[hour] = r67 * _R67_TO_SIGMA

    rolling = intensity_json["climatology"]["rolling_window"]["by_hour"]
    wind_sigma: dict[int, float] = {0: 0.0}
    for hour in _NHC_FORECAST_HOURS:
        wind_sigma[hour] = rolling[str(hour)]["peak_wind_sigma_kt"]

    return track_sigma, wind_sigma


def _interpolate_at_hour(table: dict[int, float], hour: float) -> float:
    """Piecewise-linear interpolation; clamps to endpoints outside the
    fitted hour range (e.g., hour > 120 clamps to the 120h σ)."""
    keys = sorted(table.keys())
    if hour <= keys[0]:
        return table[keys[0]]
    if hour >= keys[-1]:
        return table[keys[-1]]
    for i in range(len(keys) - 1):
        if keys[i] <= hour <= keys[i + 1]:
            x0, x1 = keys[i], keys[i + 1]
            y0, y1 = table[x0], table[x1]
            frac = (hour - x0) / (x1 - x0)
            return y0 + frac * (y1 - y0)
    # Unreachable given the endpoint clamps above, but keep mypy happy.
    return table[keys[-1]]  # pragma: no cover


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
        for zip3, meta in _load_coastal_zip3_catalog().items():
            dist_km = _min_distance_to_track_km(meta["lat"], meta["lon"], path)
            surge_grid[zip3] = _surge_depth(dist_km, peak_wind, meta["elev_m"])
        scenario: dict = {
            "kind": "hurricane",
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
    importance_buckets: list[dict] | None = None,
    hurdat2_path: Path | None = None,
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
    importance_buckets:
        Optional list of stratified IS draws from
        :func:`ml.scenarios.importance.stratified_sample`.  Each dict
        carries ``bucket``, ``weight``, and (typically) ``peak_wind_mph``
        and ``category``.  Task P2.5 plumbing — when supplied, each
        scenario inherits the bucket label + uncorrected weight as
        metadata so IS-corrected TVaR computations (P2.6 / P2.7) can
        apply the ``p_bucket / n_per_bucket`` Horvitz-Thompson factor at
        evaluation time.  The actual perturbation math is unchanged.
    hurdat2_path:
        Optional path to the HURDAT2 parquet cache (typically
        ``artifacts/hurdat2/best_track.parquet``).  Task P2.10 plumbing —
        accepted as a kwarg so downstream consumers can wire a
        HURDAT2-anchored log-likelihood without changing this function's
        signature.  The Phase-1 (state, peak-wind bucket) log-lik
        consumer was never wired upstream of this function, so P2.10
        only plumbs the kwarg through; replacing the log-lik is a
        follow-up that must coordinate with P2.6 / P2.7 IS-corrected
        TVaR consumers.

    Returns
    -------
    list[dict]
        ``n`` scenario dicts.  Probability weights sum to 1.  When the
        ensemble path is used each scenario additionally carries a
        ``member_id`` key identifying its source ensemble member.
    """
    if n <= 0:
        return []

    # P2.10 plumbing — kwarg accepted but no consumer is wired here yet.
    # The HURDAT2-anchored log-lik replacement coordinates with P2.6 /
    # P2.7 IS-corrected TVaR; see ml/scenarios/hurdat2.py.
    _ = hurdat2_path

    # Task P2.38 — when a non-empty ensemble is supplied, resample from
    # it.  Empty / None ⇒ parametric path (backward compat).
    if ensemble:
        return _scenarios_from_ensemble(storm_id, n, list(ensemble), regime, correlation)

    track = (
        seed_track if seed_track is not None
        else sample_basin_seed_track("us_atlantic")
    )
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

    # Per-waypoint perturbation σ from the NHC OFCL climatology.
    # AUDIT.3 Phase 2a — the old hand-coded "2.5° linear ramp" was
    # within 10% of the right magnitude by luck; this calibrated path
    # reproduces the published cone of uncertainty by construction at
    # every forecast hour, not just at the endpoint.
    track_sigma_table, wind_sigma_table = _load_nhc_climatology()
    horizons = np.array([float(p["hours_from_now"]) for p in track])
    # Track σ in nm, converted to degrees of latitude (1 nm = 1/60° lat).
    track_sigma_nm = np.array(
        [_interpolate_at_hour(track_sigma_table, float(h)) for h in horizons])
    track_sigma_lat_deg = track_sigma_nm / _NM_PER_DEG_LAT
    # Longitudinal degrees shrink with latitude, so σ_lon in degrees
    # grows with cos(lat).  Reference latitude is the seed-track mean —
    # accurate enough for the scale of an Atlantic basin track.
    lat_ref_rad = math.radians(float(np.mean([p["lat"] for p in track])))
    track_sigma_lon_deg = track_sigma_nm / (
        _NM_PER_DEG_LAT * max(0.1, math.cos(lat_ref_rad)))
    # Wind σ.  Old code applied a single 15 mph draw per scenario
    # regardless of when peak intensity occurred; we preserve that
    # "single per-scenario wind perturbation" semantics but anchor the
    # σ at the 120h horizon (consistent with treating peak-wind
    # uncertainty as the 5-day forecast intensity error).
    wind_sigma_kt = _interpolate_at_hour(wind_sigma_table, float(_HORIZON_H))
    wind_sigma_mph = wind_sigma_kt * _KT_TO_MPH

    scenarios: list[dict] = []
    prob = 1.0 / n

    for i in range(n):
        # Track perturbation: independent Gaussian on each waypoint.
        # σ depends on the waypoint's lead time (NHC error grows from
        # 0 nm at hour 0 to ~223 nm at hour 120).
        lat_noise = rng.normal(0.0, track_sigma_lat_deg)
        lon_noise = rng.normal(0.0, track_sigma_lon_deg)

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
        peak_wind = float(rng.normal(seed_peak, wind_sigma_mph))
        # Clamp to physically plausible: TS-floor 35 mph, hard cap 215 mph
        peak_wind = max(35.0, min(215.0, peak_wind))
        peak_wind = round(peak_wind, 1)

        # Per-ZIP3 surge depth grid.
        surge_grid: dict[str, float] = {}
        for zip3, meta in _load_coastal_zip3_catalog().items():
            dist_km = _min_distance_to_track_km(meta["lat"], meta["lon"], path)
            surge_grid[zip3] = _surge_depth(dist_km, peak_wind, meta["elev_m"])

        scenario = {
            "kind": "hurricane",
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
        if importance_buckets is not None and i < len(importance_buckets):
            # P2.5 plumbing — bucket label + uncorrected weight ride along
            # as metadata.  Downstream IS-corrected TVaR (P2.6 / P2.7) uses
            # the bucket to look up ATLANTIC_BASIN_FREQUENCIES and apply
            # the p_bucket / n_per_bucket Horvitz-Thompson factor.  The
            # underlying perturbation math is unchanged here.
            sample = importance_buckets[i]
            scenario["bucket"] = sample["bucket"]
            scenario["weight"] = sample["weight"]
        scenarios.append(scenario)

    # Normalise (handles n where 1/n isn't exactly representable in float).
    total = sum(s["prob"] for s in scenarios)
    if total > 0 and abs(total - 1.0) > 1e-9:
        for s in scenarios:
            s["prob"] = s["prob"] / total

    return scenarios


__all__ = [
    "generate_scenarios",
    "sample_basin_seed_track",
]
