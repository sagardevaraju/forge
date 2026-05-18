"""Task SIM.6 — K=1000 cohort loss generator for simulated catastrophe events.

Given a SimulationFootprint and the policy book, produces a numpy array of
shape (n_cohorts, K) — per-cohort lognormal-ish loss draws with peril-specific
perturbations on the footprint geometry. Output is parquet-ready; the
precompute_portfolio_optimization.py script reads it back and concatenates
column-wise onto the hurricane scenario set for joint TVaR-99.

Severity model:
    loss(policy, draw) = TIV
                       × damage_ratio[peril][build_type]
                       × intensity_scale[intensity]
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
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
from shapely.geometry import Point, Polygon, shape

# Re-implements lib/sim/severity.ts: keep numbers in sync. v2 = lift to JSON.
_HAZUS_MATRIX: dict[str, dict[str, float]] = {
    "wood_frame":  {"tornado": 0.42, "flood": 0.55, "hail": 0.18, "wildfire": 0.92, "earthquake": 0.35, "winter": 0.08},
    "masonry":     {"tornado": 0.28, "flood": 0.62, "hail": 0.10, "wildfire": 0.85, "earthquake": 0.22, "winter": 0.06},
    "mobile_home": {"tornado": 0.85, "flood": 0.45, "hail": 0.32, "wildfire": 0.95, "earthquake": 0.55, "winter": 0.18},
    "commercial":  {"tornado": 0.30, "flood": 0.48, "hail": 0.12, "wildfire": 0.78, "earthquake": 0.28, "winter": 0.05},
}
_INTENSITY_SCALE = {"moderate": 0.55, "severe": 1.0, "catastrophic": 1.45}

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


def _damage_ratio(peril: str, build_type: str, intensity: str) -> float:
    row = _HAZUS_MATRIX.get(build_type) or _HAZUS_MATRIX["wood_frame"]
    base = row.get(peril, 0.0)
    scaled = base * _INTENSITY_SCALE.get(intensity, 1.0)
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
    """Read (β, σ) from artifacts/calibration.json. Returns (0.2, 0.4) as a
    last-resort default if the calibration artifact is missing — that's the
    same default `api_py.correlation` ships."""
    root = artifacts_root or Path(__file__).resolve().parent.parent / "artifacts"
    p = root / "calibration.json"
    try:
        data = json.loads(p.read_text())
        beta = float(data.get("common_factor", {}).get("beta", 0.2))
        sigma = float(data.get("common_factor", {}).get("sigma", 0.4))
        return beta, sigma
    except Exception:
        return 0.2, 0.4


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

    for k in range(K):
        # Step 1: perturb geometry.
        poly = _perturbed_polygon(base_geom, sigma_deg, rng)
        # Step 2: common-factor residual ε for this draw.
        epsilon = rng.normal(0.0, sigma)
        factor_residual = 1.0 + beta * epsilon
        # Step 3: per-policy loss inside the perturbed polygon.
        for p in policy_list:
            pid, lat, lon, tiv, build_type, _zip3 = p
            point = Point(lon, lat)
            if not poly.contains(point):
                continue
            # Distance-based decay — only meaningful for tornado / hail.
            d_km = 0.0
            if peril in ("tornado", "hail"):
                d_km = poly.exterior.distance(point) * 111.0  # deg → km approx
            decay = peril_decay(peril, distance_km=d_km, width_km=(width_km or inner_radius_km))
            dr = _damage_ratio(peril, build_type, intensity)
            loss = tiv * dr * decay * max(0.0, factor_residual)
            row = key_to_idx[cohort_keyer(p)]
            losses[row, k] += loss

    return {
        "K": K,
        "cohort_keys": keys_in_order,
        "losses": losses,
        "meta": {"sim_id": sim_id, "peril": peril, "intensity": intensity,
                 "beta": beta, "sigma": sigma},
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

        result = generate_sim_losses(
            sim_id=sim_id,
            footprint=footprint,
            policies=[tuple(p) for p in policies],
            cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
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
