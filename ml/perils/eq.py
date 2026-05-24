"""Task P3.16 — Earthquake peril Monte-Carlo generator.

Produces epicenter + Mw + MMI-VI footprint scenarios for use by the
multi-peril precompute pipeline. Calibrated against:

- **Gutenberg-Richter recurrence** — ``log10 N(≥ M) = a − b · M``. The
  regional b-value is empirically ≈ 1.0 in California
  (Hauksson 2011 *BSSA* — Southern California Seismic Network
  catalog), implying each +1.0 magnitude step drops event frequency by
  ≈ 10×. The plug-in samples Mw from a truncated exponential with rate
  ``ln(10) · b``, anchored at the Bakun-Wentworth zero-crossing
  ``Mw = 5.53`` (below which the MMI-VI shell has no physical extent).
- **Bakun-Wentworth (1997) MMI attenuation** — the same relation
  driving ``lib/sim/footprint.ts::mmiRadiusKm`` and the operator-side
  earthquake severity scale (research.md §2). MMI VI shell radius:

  ``r(km) = (1.68 · Mw − 3.29 − MMI) / 0.0206``

- **USGS NSHM 2023** — high-seismic zones cover California, the Pacific
  Northwest Cascadia subduction, the Intermountain West (Wasatch / NV /
  ID), New Madrid (Central US), and Alaska.
  https://www.usgs.gov/programs/earthquake-hazards/national-seismic-hazard-maps

Damage curve mirror invariant
-----------------------------
Every scenario carries ``peril = "earthquake"`` and a continuous
``severity = Mw`` that maps into:

- ``lib/sim/severity.ts`` ``PERIL_SCALES.earthquake`` —
  ``multiplier(Mw) = 0`` if Mw < 5.53 else ``1.0 + 0.45 · (Mw − 7.0)``.
- ``api_py/sim_loss.py`` ``_HAZUS_MATRIX[..]["earthquake"]`` (per-build-
  type severe-anchor row).

The 5.53 zero-crossing floor in the multiplier means the plug-in MUST
NOT emit scenarios below that — they would produce zero loss and bloat
the scenario count without contributing to TVaR. The truncated draw
enforces this at the generator level.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ml.perils.base import Peril, register_peril


# ── calibration constants ──────────────────────────────────────────────────

# Gutenberg-Richter b-value (Hauksson 2011 — Southern California catalog).
# Cited for regional consistency; the rest of the US ranges b ≈ 0.7-1.1
# (Cascadia b ≈ 0.7; New Madrid b ≈ 0.9; PNW + Intermountain ≈ 1.0).
_GR_B_VALUE = 1.0

# Mw bounds — lower is Bakun-Wentworth zero-crossing, upper is a soft
# cap above the Cascadia subduction maximum (M9.0 Cascadia paleo-event
# documented in Goldfinger et al. 2012, but rare enough to cap the
# truncated draw before it dominates).
_MW_MIN = 5.53
_MW_MAX = 8.0

# Bakun-Wentworth (1997) California MMI attenuation coefficients —
# mirrored from lib/sim/footprint.ts so the plug-in computes the same
# MMI VI radius as the operator-side severity scale.
_BW_MAGNITUDE_COEF = 1.68
_BW_CONSTANT = 3.29
_BW_DISTANCE_COEF = 0.0206

# US high-seismic zones (loosely composed from USGS NSHM 2023). Each
# entry is a bounding box + a weight reflecting the fraction of US
# M ≥ 6 events 1900-2024 that fell inside it (USGS COMCAT counts).
# v1 uses uniform-in-box positioning within a chosen region; a more
# realistic per-fault Poisson intensity is out of scope.
_SEISMIC_REGIONS: list[tuple[str, dict[str, float], float]] = [
    # California — San Andreas, Hayward, Garlock, ECSZ. ~70% of CONUS M6+
    ("california",
     {"lat_min": 32.5, "lat_max": 42.0, "lon_min": -125.0, "lon_max": -114.0},
     0.55),
    # Pacific Northwest — Cascadia subduction interface + crustal.
    ("pnw",
     {"lat_min": 41.0, "lat_max": 49.0, "lon_min": -125.0, "lon_max": -116.0},
     0.10),
    # Intermountain West — Wasatch (UT), Nevada Seismic Belt, central ID.
    ("intermountain",
     {"lat_min": 36.0, "lat_max": 46.0, "lon_min": -118.0, "lon_max": -109.0},
     0.10),
    # New Madrid — Central US sequence.
    ("new_madrid",
     {"lat_min": 35.0, "lat_max": 38.5, "lon_min": -91.5, "lon_max": -88.5},
     0.05),
    # Alaska — Aleutian subduction, Denali, Yakutat. Dominates global
    # M ≥ 7 frequency but is a US territory with very few exposures, so
    # weighted modestly so the draw stays mostly in CONUS-relevant
    # exposure regions.
    ("alaska",
     {"lat_min": 54.0, "lat_max": 65.0, "lon_min": -165.0, "lon_max": -130.0},
     0.20),
]
assert abs(sum(w for _, _, w in _SEISMIC_REGIONS) - 1.0) < 1e-9


# ── helpers ────────────────────────────────────────────────────────────────


def _scenario_seed(scenario_id: str) -> int:
    h = 0
    for c in scenario_id:
        h = (h * 1315423911) ^ ord(c)
        h &= 0xFFFFFFFF
    return h or 1


def _draw_magnitude(rng: np.random.Generator) -> float:
    """Truncated exponential draw from Gutenberg-Richter.

    GR: density ∝ 10^(−b·M). Inverse-transform: ``M = M_min − log10(U)/b``.
    The exponential is truncated at ``_MW_MAX`` via rejection.
    """
    rate_loge = math.log(10) * _GR_B_VALUE
    for _ in range(50):
        # Inverse-transform: U ~ U(0,1) → M = M_min − ln(U) / rate_loge
        u = float(rng.uniform(0.0, 1.0))
        if u <= 0:
            continue
        m = _MW_MIN - math.log(u) / rate_loge
        if m <= _MW_MAX:
            return round(m, 2)
    return _MW_MAX  # extremely unlikely fallback


def _draw_region(rng: np.random.Generator) -> tuple[str, dict[str, float]]:
    weights = np.array([w for _, _, w in _SEISMIC_REGIONS])
    idx = int(rng.choice(len(_SEISMIC_REGIONS), p=weights))
    name, bbox, _ = _SEISMIC_REGIONS[idx]
    return name, bbox


def _draw_epicenter(rng: np.random.Generator) -> tuple[str, dict[str, float]]:
    region_name, bbox = _draw_region(rng)
    lat = float(rng.uniform(bbox["lat_min"], bbox["lat_max"]))
    lon = float(rng.uniform(bbox["lon_min"], bbox["lon_max"]))
    return region_name, {"lat": round(lat, 4), "lon": round(lon, 4)}


def _mmi_radius_km(magnitude: float, mmi: float) -> float:
    """Bakun-Wentworth inverse — distance at which shaking decays to
    given MMI. Mirror of :func:`lib.sim.footprint.mmiRadiusKm`.
    """
    km = (_BW_MAGNITUDE_COEF * magnitude - _BW_CONSTANT - mmi) / _BW_DISTANCE_COEF
    return max(0.0, km)


def _mmi_radii_km(magnitude: float) -> dict[str, float]:
    radii: dict[str, float] = {}
    for mmi in (6, 7, 8):
        r = _mmi_radius_km(magnitude, mmi)
        if r > 0:
            radii[str(mmi)] = round(r, 2)
    return radii


def _circle_polygon(
    epicenter: dict[str, float],
    radius_km: float,
    nverts: int = 32,
) -> dict:
    """Build a circular Polygon around ``epicenter`` of given radius.

    Uses local lat-lon conversion (111 km / lat-deg; lon scaled by
    cos(lat)). 32-vertex circle is accurate to < 1% of a true geodesic
    buffer at these radii (≤ a few hundred km).
    """
    cos_lat = max(math.cos(math.radians(epicenter["lat"])), 0.1)
    r_lat_deg = radius_km / 111.0
    r_lon_deg = r_lat_deg / cos_lat
    ring: list[list[float]] = []
    for i in range(nverts):
        theta = 2.0 * math.pi * i / nverts
        dx = r_lon_deg * math.cos(theta)
        dy = r_lat_deg * math.sin(theta)
        ring.append([round(epicenter["lon"] + dx, 5), round(epicenter["lat"] + dy, 5)])
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def _legacy_intensity_for_magnitude(magnitude: float) -> str:
    """Bucket Mw into the legacy three-tier ``intensity`` label so
    footprints written to ``simulations.intensity`` NOT NULL column
    stay valid. Mirrors :func:`lib.sim.severity.legacyTier`."""
    mult = 1.0 + 0.45 * (magnitude - 7.0)
    if mult < 0.775:
        return "moderate"
    if mult < 1.225:
        return "severe"
    return "catastrophic"


# ── public API ─────────────────────────────────────────────────────────────


class EQPeril(Peril):
    """Earthquake peril — Monte-Carlo epicenter + Mw + MMI-VI footprint.

    Each scenario is an event drawn from a Gutenberg-Richter truncated
    distribution, placed inside a US high-seismic region per USGS
    NSHM weights, with a circular MMI-VI damage shell sized by the
    Bakun-Wentworth (1997) attenuation relation.

    The scenario carries ``peril = "earthquake"`` so the canonical
    earthquake damage curves
    (``PERIL_SCALES.earthquake`` / ``_HAZUS_MATRIX[..]["earthquake"]``)
    drive loss compute without modification.
    """

    peril_id = "earthquake"

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
            mw = _draw_magnitude(rng)
            region_name, epicenter = _draw_epicenter(rng)
            mmi_radii = _mmi_radii_km(mw)
            damage_radius_km = mmi_radii.get("6", 0.5)
            geom = _circle_polygon(epicenter, damage_radius_km)
            scenarios.append({
                "kind": self.peril_id,
                "id": f"{scenario_id}_{i + 1:04d}",
                "peril": "earthquake",                     # mirror invariant
                "severity": mw,                             # Mw
                "intensity": _legacy_intensity_for_magnitude(mw),
                "epicenter": epicenter,
                "centroid": epicenter,                      # alias for downstream geom consumers
                "region": region_name,
                "mmi_radii_km": mmi_radii,
                "geometry": geom,
                "prob": prob,
            })
        total = sum(s["prob"] for s in scenarios)
        if total > 0 and abs(total - 1.0) > 1e-9:
            for s in scenarios:
                s["prob"] = s["prob"] / total
        return scenarios


register_peril(EQPeril())


__all__ = ["EQPeril"]
