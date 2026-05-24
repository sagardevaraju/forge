"""Task P3.15 — Wildfire peril Monte-Carlo generator.

Produces burn-perimeter scenarios for use by the multi-peril precompute
pipeline. Calibrated against three real-world sources:

- **NIFC fire size class (A–G)** — National Interagency Fire Center
  annual statistics. https://www.nifc.gov/fire-information/statistics
  Most US wildfires are Class A–C (< 100 acres) and cause no insurable
  damage; this module restricts the per-event distribution to **Class
  E and larger (≥ 300 acres)** — the damaging tail.
- **dNBR burn severity** — USGS / Cal Fire post-fire RAVG (Rapid
  Assessment of Vegetation condition after wildfire) classifies
  burned-area pixels as Low / Moderate / High. The severity
  distribution among **DAMAGING** wildfires (those that destroyed at
  least one structure per CA-DINS) is roughly Low 20% / Moderate 55% /
  High 25%.
- **CA-DINS (Cal Fire Damage Inspection)** — per-structure damage
  records from California wildfires. Source for the severity-among-
  damaging-fires distribution above. Public records:
  https://www.fire.ca.gov/incidents/

- **Headwaters Economics** — *Building Wildfire Resilience into Western
  Communities* + WUI statistics. Anchors the geographic distribution to
  the Western US Wildland-Urban Interface.
  https://headwaterseconomics.org/natural-hazards/wildfire/

Damage curve mirror invariant
-----------------------------
Every scenario carries ``peril = "wildfire"`` and a discrete dNBR
``severity`` level (``"low"`` / ``"moderate"`` / ``"high"``) that maps
directly into the canonical wildfire curves:

- ``lib/sim/severity.ts`` ``PERIL_SCALES.wildfire`` (multipliers 0.10 /
  0.40 / 1.00 — research.md §5b).
- ``api_py/sim_loss.py`` ``_HAZUS_MATRIX[..]["wildfire"]`` (per-build-
  type severe-anchor row).

The size distribution is heavy-tailed (mega-fires dominate insured loss)
but is sampled separately from the dNBR severity — bigger fires carry
the same severity menu, just over a wider area. v1 treats each fire as
uniform-severity inside its perimeter; per-pixel dNBR mosaicking is out
of scope.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ml.perils.base import Peril, register_peril


# ── calibration constants ──────────────────────────────────────────────────

# dNBR severity distribution among DAMAGING wildfires (CA-DINS records,
# Cal Fire incidents 2017-2023 with ≥ 1 destroyed structure). Approximate
# anchors — see module docstring for source.
_SEVERITY_DISTRIBUTION: list[tuple[str, float]] = [
    ("low",      0.20),
    ("moderate", 0.55),
    ("high",     0.25),
]
assert abs(sum(w for _, w in _SEVERITY_DISTRIBUTION) - 1.0) < 1e-9

# Fire-size distribution among DAMAGING wildfires (Class E and larger,
# 300+ acres). Log-normal anchor: median ≈ 2000 acres; p95 ≈ 100,000
# acres (mega-fire tail dominated by 2017+ Western US event sequence —
# Tubbs, Camp, Carr, August Complex, Dixie, etc.). σ = 1.6 in natural
# log produces a p95/p50 ≈ 13.7×, matching the empirical NIFC tail.
_SIZE_LOG_MEDIAN_ACRES = math.log(2000.0)
_SIZE_LOG_SIGMA = 1.6
_SIZE_MIN_ACRES = 300.0   # NWCG Class E floor
_SIZE_MAX_ACRES = 1_000_000.0  # August Complex 2020 = 1,032,648 acres (cap)

# Headwaters Economics / USFS WHP — damaging wildfires cluster in the
# Western US WUI. Bounding box covers CA, OR, WA, ID, MT, WY, CO, UT,
# AZ, NM. Per-state intensities are out of scope for v1.
_WESTERN_WUI_BBOX = {
    "lat_min": 31.0, "lat_max": 49.0,
    "lon_min": -124.0, "lon_max": -103.0,
}


def _scenario_seed(scenario_id: str) -> int:
    h = 0
    for c in scenario_id:
        h = (h * 1315423911) ^ ord(c)
        h &= 0xFFFFFFFF
    return h or 1


def _draw_severity(rng: np.random.Generator) -> str:
    weights = np.array([w for _, w in _SEVERITY_DISTRIBUTION])
    idx = int(rng.choice(len(_SEVERITY_DISTRIBUTION), p=weights))
    return _SEVERITY_DISTRIBUTION[idx][0]


def _draw_acres(rng: np.random.Generator) -> float:
    """Log-normal draw from the Class E+ damaging-fire size distribution."""
    raw = float(rng.lognormal(mean=_SIZE_LOG_MEDIAN_ACRES, sigma=_SIZE_LOG_SIGMA))
    return float(max(_SIZE_MIN_ACRES, min(_SIZE_MAX_ACRES, raw)))


def _draw_centroid(rng: np.random.Generator) -> dict[str, float]:
    lat = float(rng.uniform(_WESTERN_WUI_BBOX["lat_min"], _WESTERN_WUI_BBOX["lat_max"]))
    lon = float(rng.uniform(_WESTERN_WUI_BBOX["lon_min"], _WESTERN_WUI_BBOX["lon_max"]))
    return {"lat": round(lat, 4), "lon": round(lon, 4)}


def _acres_to_radius_deg(acres: float, lat_deg: float) -> float:
    """Approximate the perimeter as a circle of equivalent area.

    1 acre = 4046.86 m². Area in m² → radius in m → radius in deg lat.
    Latitude scaling is exact (1° lat ≈ 111 km); longitude scaling
    depends on cos(lat) but we use lat-deg as the symmetric radius and
    let the polygon be irregular (next step jitters the ring).
    """
    area_m2 = acres * 4046.86
    radius_m = math.sqrt(area_m2 / math.pi)
    radius_km = radius_m / 1000.0
    return radius_km / 111.0


def _perimeter_polygon(
    centroid: dict[str, float],
    acres: float,
    rng: np.random.Generator,
) -> dict:
    """Build an irregular ~circular Polygon around ``centroid`` with
    area approximating ``acres``. 16-sided base polygon with per-vertex
    radial jitter so real perimeters don't all look identical.
    """
    r_deg = _acres_to_radius_deg(acres, centroid["lat"])
    # Latitude→longitude correction so polygons don't smear EW near the
    # poles; CA-OR-WA latitudes give a ~1.25-1.35 stretch factor.
    cos_lat = math.cos(math.radians(centroid["lat"]))
    nverts = 16
    ring: list[list[float]] = []
    for i in range(nverts):
        theta = 2.0 * math.pi * i / nverts
        # Per-vertex jitter: ±25% of base radius, lognormal so we get the
        # finger-of-fire effect typical of wind-driven wildfires.
        jitter = float(rng.uniform(0.75, 1.25))
        r = r_deg * jitter
        dy = r * math.sin(theta)
        dx = r * math.cos(theta) / max(cos_lat, 0.1)
        ring.append([round(centroid["lon"] + dx, 5), round(centroid["lat"] + dy, 5)])
    ring.append(ring[0])  # close
    return {"type": "Polygon", "coordinates": [ring]}


def _legacy_intensity_for_severity(severity: str) -> str:
    """Bucket a dNBR level into the legacy three-tier ``intensity``
    label so footprints written to ``simulations.intensity`` NOT NULL
    column stay valid. Mirrors :func:`lib.sim.severity.legacyTier`
    (mult 0.10/0.40/1.00 → moderate/moderate/severe; 'high' caps below
    the catastrophic-spine threshold of 1.225 by the same recalibration
    convention documented in research.md §5b).
    """
    mult = {"low": 0.10, "moderate": 0.40, "high": 1.00}[severity]
    if mult < 0.775:
        return "moderate"
    if mult < 1.225:
        return "severe"
    return "catastrophic"


# ── public API ─────────────────────────────────────────────────────────────


class WildfirePeril(Peril):
    """Wildfire peril — Monte-Carlo burn-perimeter generator.

    Each scenario is a Class E+ wildfire placed inside the Western US
    WUI with dNBR severity drawn from the CA-DINS damaging-fire
    distribution and a perimeter polygon sized to log-normal NIFC acres.

    The scenario carries ``peril = "wildfire"`` so the canonical
    wildfire damage curves (``PERIL_SCALES.wildfire`` /
    ``_HAZUS_MATRIX[..]["wildfire"]``) drive loss compute without
    modification.
    """

    peril_id = "wildfire"

    def generate_scenarios(
        self,
        scenario_id: str,
        n: int = 1000,
        **kwargs: Any,
    ) -> list[dict]:
        if n <= 0:
            return []
        rng = np.random.default_rng(_scenario_seed(scenario_id))
        scenarios: list[dict] = []
        prob = 1.0 / n
        for i in range(n):
            severity = _draw_severity(rng)
            acres = _draw_acres(rng)
            centroid = _draw_centroid(rng)
            geom = _perimeter_polygon(centroid, acres, rng)
            scenarios.append({
                "kind": self.peril_id,
                "id": f"{scenario_id}_{i + 1:04d}",
                "peril": "wildfire",                       # mirror invariant
                "severity": severity,                       # dNBR level id
                "intensity": _legacy_intensity_for_severity(severity),
                "acres_burned": round(acres, 1),
                "centroid": centroid,
                "geometry": geom,
                "prob": prob,
            })
        total = sum(s["prob"] for s in scenarios)
        if total > 0 and abs(total - 1.0) > 1e-9:
            for s in scenarios:
                s["prob"] = s["prob"] / total
        return scenarios


register_peril(WildfirePeril())


__all__ = ["WildfirePeril"]
