"""Task SIM.6 — K=1000 cohort loss generator for simulated catastrophe events.

Given a SimulationFootprint and the policy book, produces a numpy array of
shape (n_cohorts, K) — per-cohort lognormal-ish loss draws with peril-specific
perturbations on the footprint geometry. Output is parquet-ready; the
precompute_portfolio_optimization.py script reads it back and concatenates
column-wise onto the hurricane scenario set for joint TVaR-99.

Severity model:
    loss(policy, draw) = TIV
                       × damage_ratio[peril][build_type]
                       × damage_multiplier[peril][severity]
                       × decay(distance_to_reference)
                       × (1 + β · ε_draw)

The (β, σ) common-factor pair is loaded from artifacts/calibration.json so
sims sit on the same residual axis as hurricane scenarios. See
docs/superpowers/specs/2026-05-18-simulate-tab-design.md §5.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
import shapely
from shapely.geometry import Point, Polygon, shape

# Re-implements lib/sim/severity.ts: keep numbers in sync. v2 = lift to JSON.
# Keys match the policy book's `build_type` vocabulary (scripts/seed_policy_book.py
# BUILD_TYPES, lib/book/csv.ts ALLOWED_BUILD_TYPES). "manufactured" is FEMA HAZUS's
# "Manufactured Housing" (MH) — historically aliased as "mobile_home" in research
# papers. Using the seed vocabulary directly prevents the silent
# manufactured→wood_frame fallback that under-modelled ~15 % of the book.
# manufactured.flood was 0.45 (i.e. *less* flood-vulnerable than wood frame).
# That inverts reality: HAZUS Flood Technical Manual 4.0 manufactured-housing
# depth-damage curves at ~4 ft inundation sit at 0.55-0.65, ABOVE wood frame —
# MH sits lower, has weaker floor systems, and is more easily moved by
# floodwater. Raised to 0.65 to match the upper end of the HAZUS MH curve.
_HAZUS_MATRIX: dict[str, dict[str, float]] = {
    "wood_frame":   {"tornado": 0.42, "flood": 0.55, "hail": 0.18, "wildfire": 0.92, "earthquake": 0.35, "winter": 0.08},
    "masonry":      {"tornado": 0.28, "flood": 0.62, "hail": 0.10, "wildfire": 0.85, "earthquake": 0.22, "winter": 0.06},
    "manufactured": {"tornado": 0.85, "flood": 0.65, "hail": 0.32, "wildfire": 0.95, "earthquake": 0.55, "winter": 0.18},
    "commercial":   {"tornado": 0.30, "flood": 0.48, "hail": 0.12, "wildfire": 0.78, "earthquake": 0.28, "winter": 0.05},
}
_INTENSITY_SCALE = {"moderate": 0.55, "severe": 1.0, "catastrophic": 1.45}

# Mirrors lib/sim/severity.ts PERIL_SCALES discrete multipliers — keep in sync.
# Tornado and winter remain spine-anchored. Flood and wildfire are recalibrated
# off the spine (research.md §4b, §5b):
#   - Flood NWS Minor/Moderate/Major map to inundation-depth severity, not to
#     a 1:1 INTENSITY_SCALE relabel; minor is nuisance flooding (≈ 0.25), major
#     is multi-floor / pile-supported (≈ 1.20).
#   - Wildfire dNBR Low/Moderate/High: dNBR low has minimal structural impact
#     (≈ 0.10), dNBR high is HAZUS-severe total loss (≈ 1.00).
# Earlier 1:1 spine map produced "low burn severity → 50 % wood-frame damage"
# and "minor flood → 30 % wood-frame damage", both HAZUS-severe-territory
# damage from sub-threshold events.
_PERIL_LEVEL_MULT: dict[str, dict[str, float]] = {
    "tornado":  {"ef0": 0.325, "ef1": 0.55, "ef2": 0.775, "ef3": 1.0, "ef4": 1.225, "ef5": 1.45},
    "flood":    {"minor": 0.25, "moderate": 0.70, "major": 1.20},
    "wildfire": {"low": 0.10, "moderate": 0.40, "high": 1.00},
    # Winter recalibrated to NWS WSSI operational definitions + industry loss
    # data (TX 2021 Uri $11.2B / 510k claims, Buffalo 2022 $5.4B, I.I.I. $1.3B
    # baseline). Previous 1:1 spine map put "Minor" — NWS-defined as "minor
    # inconveniences" — at multiplier 0.55, producing 4.9 % mean DR
    # (= $21M on a 1,362-policy FL triangle). Real Minor events produce
    # ≈ 0.2-0.5 % mean DR. Extreme anchors at HAZUS-severe (1.0) matching
    # Uri/Buffalo worst-hit-ZIP mean DRs of 5-15 %. See research.md §6b.
    "winter":   {"limited": 0.01, "minor": 0.04, "moderate": 0.15, "major": 0.40, "extreme": 1.00},
}


def _damage_multiplier(peril: str, severity) -> float:
    """Per-peril damage multiplier — mirrors lib/sim/severity.ts damageMultiplier.

    `severity` is a number for continuous perils (earthquake Mw, hail stone
    diameter mm) and a level id for discrete perils. A legacy tier string
    ('moderate' | 'severe' | 'catastrophic') falls back to _INTENSITY_SCALE so
    footprints stored before the per-peril scales still resolve. Numbers trace
    to research.md (S2c earthquake, S3b hail, S1c/S6b discrete)."""
    if peril == "earthquake":
        if isinstance(severity, (int, float)) and not isinstance(severity, bool):
            # 5.53 = Bakun-Wentworth zero-crossing: MMI VI radius = 0 ⇒
            # (1.68·Mw − 3.29 − 6) / 0.0206 = 0 ⇒ Mw ≈ 5.53. Below that the
            # MMI VI shell has no physical extent so damage is honestly zero —
            # the previous `max(0.05, …)` floor produced phantom 3.5 %
            # wood-frame damage at M5.0 even though M5.0 quakes produce
            # essentially no filed claims in real-world catalogues. Mirror of
            # lib/sim/severity.ts PERIL_SCALES.earthquake.multiplier.
            if severity < 5.53:
                return 0.0
            return 1.0 + 0.45 * (severity - 7.0)
        return _INTENSITY_SCALE.get(severity, 1.0)
    if peril == "hail":
        if isinstance(severity, (int, float)) and not isinstance(severity, bool):
            # Calibrated to real-world hail damage thresholds — mirrors
            # lib/sim/severity.ts. Anchors: 20 mm = 0 (damage threshold,
            # below NWS "significant severe" cutoff at 25 mm), 45 mm = 1.0
            # (severe). No 0.05 floor — sub-threshold hail honestly returns 0.
            return max(0.0, 0.04 * (severity - 20.0))
        return _INTENSITY_SCALE.get(severity, 1.0)
    levels = _PERIL_LEVEL_MULT.get(peril, {})
    if severity in levels:
        return levels[severity]
    return _INTENSITY_SCALE.get(severity, 1.0)


# K=1000 perturbation σ — see spec §5.
_PERTURB: dict[str, dict[str, float]] = {
    "tornado":    {"vertex_deg": 0.005, "width_pct": 0.15},
    "flood":      {"vertex_deg": 0.003},
    "hail":       {"vertex_deg": 0.003},
    "wildfire":   {"vertex_deg": 0.003},
    "winter":     {"vertex_deg": 0.003},
    "earthquake": {"epicenter_deg": 0.01, "magnitude": 0.15},
}


def perturbation_sigmas(peril: str) -> dict[str, float]:
    """Per-peril perturbation parameters used by the K=1000 generator."""
    return dict(_PERTURB.get(peril, {"vertex_deg": 0.003}))


# Track unknown build_types we've already warned about so a corrupted seed
# doesn't spam stderr per policy iteration across K draws.
_warned_unknown_build_types: set[str] = set()


def _damage_ratio(peril: str, build_type: str, severity) -> float:
    row = _HAZUS_MATRIX.get(build_type)
    if row is None:
        # No silent fallback — that's how "manufactured" was being modelled as
        # wood_frame and under-estimating tornado/hail/earthquake loss by
        # 50–100 % on ~15 % of the book. Surface the miss, contribute zero
        # loss, and let the operator/test catch it.
        if build_type not in _warned_unknown_build_types:
            _warned_unknown_build_types.add(build_type)
            import sys
            print(
                f'[_damage_ratio] unknown build_type "{build_type}" — contributing 0 to '
                "gross loss. Add it to _HAZUS_MATRIX in api_py/sim_loss.py "
                "(and mirror in lib/sim/severity.ts).",
                file=sys.stderr,
            )
        return 0.0
    base = row.get(peril, 0.0)
    scaled = base * _damage_multiplier(peril, severity)
    return max(0.0, min(1.0, scaled))


def _sim_seed(sim_id: str) -> int:
    """Deterministic 32-bit seed derived from sim_id (same shape as
    ml.scenarios.generate._storm_seed). Bit-identical across runs."""
    h = int(hashlib.sha256(sim_id.encode("utf-8")).hexdigest()[:8], 16)
    return h or 1


def peril_decay(peril: str, *, distance_km: float, width_km: float = 0.0) -> float:
    """Severity decay multiplier as a function of distance from the
    peril's reference geometry. Polygon-bounded perils (flood, wildfire,
    winter) return 1.0 inside / 0 outside, and are filtered by the
    point-in-polygon check upstream — so this function is called only on
    inside points and returns 1.0 for them."""
    if peril in ("flood", "wildfire", "winter"):
        return 1.0
    if peril == "tornado":
        if width_km <= 0:
            return 1.0
        return math.exp(-distance_km / (width_km / 2.0))
    if peril == "hail":
        # 1.0 inside the inner core, 0.6·exp(-(d-r)/r) outside.
        # Caller passes width_km = inner-core radius (or 0 when no core).
        if width_km <= 0:
            return 1.0
        if distance_km <= width_km:
            return 1.0
        return 0.6 * math.exp(-(distance_km - width_km) / width_km)
    if peril == "earthquake":
        # Step function from MMI radii; caller passes the MMI lookup as
        # a Polygon-equivalent. Distance-based decay here is the residual
        # smoothing inside an MMI shell.
        return max(0.0, 1.0 - distance_km / max(1.0, width_km))
    return 1.0


def _perturbed_polygon(
    geom: dict, sigma_deg: float, rng: np.random.Generator,
) -> Polygon:
    """Jitter every vertex of a Polygon by an isotropic Gaussian."""
    base = shape(geom)
    if base.geom_type != "Polygon":
        return base
    ring = list(base.exterior.coords)
    noise = rng.normal(0.0, sigma_deg, size=(len(ring), 2))
    perturbed = [(x + dx, y + dy) for (x, y), (dx, dy) in zip(ring, noise)]
    # Re-close the ring.
    if perturbed[0] != perturbed[-1]:
        perturbed[-1] = perturbed[0]
    try:
        p = Polygon(perturbed)
        if not p.is_valid:
            return base  # fall back to base on degenerate jitter
        return p
    except Exception:
        return base


def _load_correlation(artifacts_root: Path | None = None) -> tuple[float, float]:
    """Read (β, σ) from artifacts/calibration.json.

    Falls back to the canonical defaults in ``api_py.correlation``
    (DEFAULT_BETA, DEFAULT_SIGMA) when the calibration artifact is
    missing — a prior version of this fallback returned ``(0.2, 0.4)``
    inline, which silently diverged from ``api_py.correlation``'s
    ``(0.5, 0.3)`` and produced materially different tail-heaviness
    depending on which code path the caller hit. Single source of
    truth now.
    """
    # Local import to avoid a circular dependency between sim_loss and
    # correlation modules at module-load time.
    from api_py.correlation import DEFAULT_BETA, DEFAULT_SIGMA  # noqa: PLC0415

    root = artifacts_root or Path(__file__).resolve().parent.parent / "artifacts"
    p = root / "calibration.json"
    try:
        data = json.loads(p.read_text())
        beta = float(data.get("common_factor", {}).get("beta", DEFAULT_BETA))
        sigma = float(data.get("common_factor", {}).get("sigma", DEFAULT_SIGMA))
        return beta, sigma
    except Exception:
        return DEFAULT_BETA, DEFAULT_SIGMA


def generate_sim_losses(
    sim_id: str,
    footprint: dict[str, Any],
    policies: Iterable[tuple[int, float, float, float, str, str]],
    *,
    cohort_keyer: Callable[[tuple[int, float, float, float, str, str]], str],
    K: int = 1000,
    artifacts_root: Path | None = None,
) -> dict[str, Any]:
    """Produce K perturbed cohort losses for one simulated event.

    Parameters
    ----------
    sim_id
        The simulation id. Used as RNG seed; same id → bit-identical output.
    footprint
        SimulationFootprint dict (see spec §4). At minimum: peril,
        intensity, geometry (Polygon), and the peril-specific extras.
    policies
        Iterable of (id, lat, lon, tiv, build_type, zip3). Pulled from
        the `policies` table upstream.
    cohort_keyer
        Function mapping a policy tuple to its cohort key. Production uses
        `{zip3}_{build_type}_q{quintile}`; tests use the (zip3, build_type)
        prefix.
    K
        Number of perturbed draws. Defaults to 1000 (the same K as the
        hurricane scenario set).

    Returns
    -------
    dict with keys:
        - K: the K used
        - cohort_keys: sorted list of cohort keys in row order
        - losses: numpy array of shape (n_cohorts, K)
        - meta: peril, intensity, sim_id, beta, sigma
    """
    rng = np.random.default_rng(_sim_seed(sim_id))
    peril = footprint["peril"]
    intensity = footprint["intensity"]
    # Canonical per-peril severity; legacy footprints carry only `intensity`.
    severity = footprint.get("severity", intensity)
    perturb = perturbation_sigmas(peril)
    base_geom = footprint["geometry"]
    inner_radius_km = 0.0
    width_km = 0.0
    if peril == "tornado":
        width_km = (footprint.get("width_m") or 200) / 1000.0
    if peril == "hail" and footprint.get("inner_geometry"):
        # Approximate inner core radius from its bounding box.
        inner = shape(footprint["inner_geometry"])
        bx = inner.bounds  # (minx, miny, maxx, maxy)
        inner_radius_km = max(bx[2] - bx[0], bx[3] - bx[1]) * 55.0  # ~ deg → km equatorial
    beta, sigma = _load_correlation(artifacts_root)

    # Materialize policies once.
    policy_list = list(policies)

    # Pre-bucket cohorts by deterministic order.
    keys_in_order: list[str] = []
    key_to_idx: dict[str, int] = {}
    for p in policy_list:
        k = cohort_keyer(p)
        if k not in key_to_idx:
            key_to_idx[k] = len(keys_in_order)
            keys_in_order.append(k)
    n_cohorts = len(keys_in_order)

    losses = np.zeros((n_cohorts, K), dtype=float)
    if n_cohorts == 0 or len(policy_list) == 0:
        return {"K": K, "cohort_keys": keys_in_order, "losses": losses,
                "meta": {"sim_id": sim_id, "peril": peril, "intensity": intensity,
                         "beta": beta, "sigma": sigma}}

    sigma_deg = perturb.get("vertex_deg", 0.003)

    # Pre-compute per-policy arrays for vectorized inner loop (Task SIM.11 perf).
    lons_arr = np.array([p[2] for p in policy_list], dtype=float)
    lats_arr = np.array([p[1] for p in policy_list], dtype=float)
    tivs_arr = np.array([p[3] for p in policy_list], dtype=float)
    cohort_row_arr = np.array([key_to_idx[cohort_keyer(p)] for p in policy_list], dtype=int)
    dr_arr = np.array([_damage_ratio(peril, p[4], severity) for p in policy_list], dtype=float)
    # Effective peril width used for decay (zero → uniform 1.0 for all perils except tornado/hail-with-core).
    _decay_width = width_km or inner_radius_km

    for k in range(K):
        # Step 1: perturb geometry — same RNG call as original scalar loop.
        poly = _perturbed_polygon(base_geom, sigma_deg, rng)
        # Step 2: common-factor residual ε — same RNG call order as original.
        epsilon = rng.normal(0.0, sigma)
        factor_residual = max(0.0, 1.0 + beta * epsilon)

        # Step 3: vectorized point-in-polygon via shapely 2.x contains_xy.
        inside_mask = shapely.contains_xy(poly, lons_arr, lats_arr)
        if not inside_mask.any():
            continue

        # Distance-based decay — only tornado / hail with a non-zero width need it.
        if peril in ("tornado", "hail") and _decay_width > 0.0:
            inside_idx = np.where(inside_mask)[0]
            decay_vals = np.array([
                peril_decay(peril,
                            distance_km=poly.exterior.distance(Point(lons_arr[i], lats_arr[i])) * 111.0,
                            width_km=_decay_width)
                for i in inside_idx
            ], dtype=float)
        else:
            inside_idx = np.where(inside_mask)[0]
            decay_vals = np.ones(inside_idx.size, dtype=float)

        loss_vals = tivs_arr[inside_idx] * dr_arr[inside_idx] * decay_vals * factor_residual
        np.add.at(losses[:, k], cohort_row_arr[inside_idx], loss_vals)

    return {
        "K": K,
        "cohort_keys": keys_in_order,
        "losses": losses,
        "meta": {"sim_id": sim_id, "peril": peril, "intensity": intensity,
                 "beta": beta, "sigma": sigma},
    }


def _summarize(result: dict[str, Any], bins: int = 30) -> dict[str, Any]:
    """Reduce the (n_cohorts, K) loss matrix to a client-renderable
    distribution: a histogram of the K portfolio-level scenario totals plus
    tail summary stats. Computed here (numpy) so the client never re-derives
    the tail. TVaR-99 is the mean of the worst 1% of scenario totals."""
    losses = result["losses"]
    K = int(result["K"])
    totals = losses.sum(axis=0) if getattr(losses, "size", 0) else np.zeros(K)
    counts, edges = np.histogram(totals, bins=bins)
    q99 = float(np.quantile(totals, 0.99)) if totals.size else 0.0
    tail = totals[totals >= q99]
    return {
        "histogram": {
            "bin_edges": [float(x) for x in edges],
            "counts": [int(c) for c in counts],
        },
        "summary": {
            "mean": float(totals.mean()) if totals.size else 0.0,
            "p50": float(np.quantile(totals, 0.50)) if totals.size else 0.0,
            "p90": float(np.quantile(totals, 0.90)) if totals.size else 0.0,
            "p99": q99,
            "tvar99": float(tail.mean()) if tail.size else 0.0,
            "min": float(totals.min()) if totals.size else 0.0,
            "max": float(totals.max()) if totals.size else 0.0,
        },
    }


def write_artifact(
    sim_id: str,
    result: dict[str, Any],
    artifacts_root: Path | None = None,
) -> tuple[Path, Path]:
    """Write the (n_cohorts, K) loss matrix to a parquet file and a
    companion meta.json. Returns the two paths."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    root = artifacts_root or Path(__file__).resolve().parent.parent / "artifacts" / "simulations"
    root.mkdir(parents=True, exist_ok=True)
    parquet_path = root / f"{sim_id}.parquet"
    meta_path = root / f"{sim_id}.meta.json"

    table = pa.table({
        "cohort_key": result["cohort_keys"],
        **{f"k{i:04d}": result["losses"][:, i] for i in range(result["K"])},
    })
    pq.write_table(table, parquet_path)
    meta_path.write_text(json.dumps({
        "sim_id": sim_id,
        "K": result["K"],
        "cohort_keys": result["cohort_keys"],
        **result["meta"],
    }))
    return parquet_path, meta_path


# ── Vercel HTTP handler ─────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    """POST /api/sim/promote — body: {sim_id, footprint, policies, K}."""

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON body"})
            return

        sim_id = payload.get("sim_id")
        footprint = payload.get("footprint")
        policies = payload.get("policies") or []
        K = int(payload.get("K") or 1000)
        if not sim_id or not footprint:
            self._send_json(400, {"error": "sim_id and footprint required"})
            return

        policy_tuples = [tuple(p) for p in policies]
        # Build book-wide quintile lookup so keys match the MIP cohort store.
        from api_py.cohort_keys import cohort_key as _cohort_key, policy_quintile_lookup
        quintile_by_id = policy_quintile_lookup(policy_tuples)
        result = generate_sim_losses(
            sim_id=sim_id,
            footprint=footprint,
            policies=policy_tuples,
            cohort_keyer=lambda p: _cohort_key(p, quintile_by_id[int(p[0])]),
            K=K,
        )
        parquet_path, _ = write_artifact(sim_id, result)
        self._send_json(200, {
            "sim_id": sim_id,
            "K": result["K"],
            "n_cohorts": len(result["cohort_keys"]),
            "artifact_path": str(parquet_path.relative_to(parquet_path.parent.parent.parent)),
        })

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
