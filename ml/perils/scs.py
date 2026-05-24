"""Task P3.14 — SCS (Severe Convective Storm) Monte-Carlo peril.

SCS is the SPC umbrella for thunderstorm-driven severe weather: hail
≥ 1″ diameter, straight-line winds ≥ 58 mph, or tornadoes. This module
models the **hail** component — the dominant US property-loss driver
per Smith & Katz (2013) Figure 3 (severe convective storm events as the
plurality of US billion-dollar disasters by event count, 1980-2011).

Damage curve mirror invariant
-----------------------------
Every generated scenario carries ``peril = "hail"``, so the existing
canonical hail curves drive the loss compute without any switch on
``kind``:

  * ``lib/sim/severity.ts`` ``PERIL_SCALES.hail`` — continuous
    multiplier ``max(0, 0.04 · (Ø − 20))`` anchored at 45 mm = 1.0.
  * ``api_py/sim_loss.py`` ``_HAZUS_MATRIX[…]["hail"]`` — per-build-type
    severe-anchor row.

The SCS peril id (``"scs"``) is **family-level** metadata; ``peril``
(``"hail"``) is what drives the damage curve. This decouples adding the
SCS scenario distribution from any change to PERIL_SCALES.

Data sources (cited inline + research.md §3, §10):

- **Stone-diameter distribution** — TORRO Hailstorm Intensity Scale
  frequencies among severe (≥ 25 mm) events. Webb (1986); reproduced
  in Brooks et al. (2003) Table 2.
- **Annual SCS climatology** — Smith & Katz (2013) "U.S. Billion-dollar
  Weather and Climate Disasters" Table 3 + Figure 3 (NOAA NCEI).
  https://doi.org/10.1007/s11069-013-0566-5
- **Geographic distribution** — Brooks, Doswell & Kay (2003) Fig. 5,
  "Climatological estimates of local daily tornado probability for the
  United States", *Weather and Forecasting* 18, 626-640. The SCS hail
  maximum extends from Texas through the southern Great Plains into the
  upper Midwest ("Hail Alley").
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ml.perils.base import Peril, register_peril


# ── calibration constants ──────────────────────────────────────────────────

# Smith & Katz (2013) Table 3: severe convective storm = 26 of 133 (≈ 20%)
# billion-dollar US disasters 1980-2011. Cited for completeness; the SCS
# annual frequency is set elsewhere (the precompute pipeline picks the
# total event count, this module only shapes the per-event distribution).
_SMITH_KATZ_2013_SCS_SHARE = 0.20  # fraction of billion-dollar events

# TORRO stone-diameter distribution among severe-hail events (≥ 25 mm).
# (lower_mm_inclusive, upper_mm_exclusive, fraction). Sums to 1.0.
# Source: TORRO H-scale frequencies (Webb 1986), reproduced in Brooks
# et al. (2003) Table 2. The right tail (≥ 100 mm) is rare — typical
# SPC report years show < 1% of severe-hail reports above the softball
# threshold (Allen et al. 2017, J. Clim 30).
_STONE_DIAMETER_BINS: list[tuple[float, float, float]] = [
    (25.0,  35.0, 0.55),  # quarter to nickel — most common severe
    (35.0,  50.0, 0.25),  # nickel to golf ball — severe anchor (45 mm)
    (50.0,  70.0, 0.13),  # golf ball to tennis ball
    (70.0, 100.0, 0.06),  # tennis ball to baseball — catastrophic
    (100.0, 120.0, 0.01), # softball — rare; manufactured housing total loss
]
assert abs(sum(w for _, _, w in _STONE_DIAMETER_BINS) - 1.0) < 1e-9, (
    "TORRO stone-diameter bin weights must sum to 1.0"
)

# Brooks et al. (2003) Fig. 5 — peak SCS hail frequency over the southern
# Great Plains. The bounding box below is intentionally broad (covers TX
# / OK / KS / NE / SD / IA / IL / MO / MS / TN / KY); per-state Poisson
# intensities are out of scope for the v1 plug-in.
_HAIL_ALLEY_BBOX = {
    "lat_min": 28.0, "lat_max": 47.0,
    "lon_min": -105.0, "lon_max": -86.0,
}

# Hail-swath polygon shape: kite-shaped quadrilateral with major axis along
# storm motion (typically NE in the southern Plains per Brooks et al. 2003
# storm-motion vector composites). Half-axis lengths in degrees scale with
# stone diameter — bigger stones → bigger updrafts → bigger swaths. Anchors:
#   45 mm (severe) → 0.25° major × 0.05° minor (≈ 28 km × 5.5 km)
#   matches typical reported SPC severe-hail swath dimensions.
def _swath_axes_deg(stone_diameter_mm: float) -> tuple[float, float]:
    base_major = 0.25
    base_minor = 0.05
    scale = max(0.4, min(2.0, stone_diameter_mm / 45.0))
    return base_major * scale, base_minor * scale


def _scenario_seed(scenario_id: str) -> int:
    """Deterministic 32-bit RNG seed — matches the convention used by
    :func:`ml.scenarios.generate._storm_seed`.
    """
    h = 0
    for c in scenario_id:
        h = (h * 1315423911) ^ ord(c)
        h &= 0xFFFFFFFF
    return h or 1


def _draw_stone_diameter(rng: np.random.Generator) -> float:
    """Draw one stone diameter (mm) from the TORRO distribution.

    Samples a bin per its weight, then samples uniformly within the bin.
    Quantises to 1 mm — matches the integer-mm precision of SPC reports.
    """
    weights = np.array([w for _, _, w in _STONE_DIAMETER_BINS])
    idx = int(rng.choice(len(_STONE_DIAMETER_BINS), p=weights))
    lo, hi, _ = _STONE_DIAMETER_BINS[idx]
    return float(round(rng.uniform(lo, hi)))


def _draw_centroid(rng: np.random.Generator) -> dict[str, float]:
    """Uniform draw inside the Hail Alley bbox (Brooks et al. 2003 Fig. 5).

    Uniform-in-box is an over-simplification — the real distribution peaks
    over central OK / north TX / KS — but matches the resolution of the
    plug-in (per-state Poisson intensities are out of scope).
    """
    lat = float(rng.uniform(_HAIL_ALLEY_BBOX["lat_min"], _HAIL_ALLEY_BBOX["lat_max"]))
    lon = float(rng.uniform(_HAIL_ALLEY_BBOX["lon_min"], _HAIL_ALLEY_BBOX["lon_max"]))
    return {"lat": round(lat, 4), "lon": round(lon, 4)}


def _swath_polygon(
    centroid: dict[str, float],
    stone_diameter_mm: float,
    rng: np.random.Generator,
) -> dict:
    """Build a kite-shaped Polygon around ``centroid``, oriented by a
    random storm-motion bearing in [225°, 045°] (southern-Plains
    composite per Brooks et al. 2003). Returns a GeoJSON Polygon dict.
    """
    a_deg, b_deg = _swath_axes_deg(stone_diameter_mm)
    # Storm-motion bearing — typical southern-Plains SCS storms move NE
    # (315°-045°) or SE in cold-season setups. Pick from a wide arc.
    theta = float(rng.uniform(math.radians(-45.0), math.radians(135.0)))
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    # Four kite vertices (front, right, back, left) in axis-aligned frame:
    # extend the major axis 2× forward of the centroid to give the swath
    # a teardrop bias — most damage concentrates downwind of the updraft.
    local = [
        ( 2.0 * a_deg,  0.0),       # nose (downwind)
        ( 0.0,         -b_deg),     # right flank
        (-1.0 * a_deg,  0.0),       # tail (upwind)
        ( 0.0,          b_deg),     # left flank
    ]
    # Rotate into geographic frame and translate to centroid.
    ring: list[list[float]] = []
    for x, y in local:
        rx = x * cos_t - y * sin_t
        ry = x * sin_t + y * cos_t
        ring.append([round(centroid["lon"] + rx, 5), round(centroid["lat"] + ry, 5)])
    ring.append(ring[0])  # close
    return {"type": "Polygon", "coordinates": [ring]}


def _legacy_intensity_for_diameter(stone_diameter_mm: float) -> str:
    """Bucket a stone diameter into the legacy three-tier ``intensity``
    label so footprints written to the ``simulations.intensity`` NOT NULL
    column stay valid. Anchors match
    :func:`lib.sim.severity.legacyTier` thresholds (multiplier 0.775 /
    1.225) via the hail curve ``max(0, 0.04 · (Ø − 20))``.
    """
    mult = max(0.0, 0.04 * (stone_diameter_mm - 20.0))
    if mult < 0.775:
        return "moderate"
    if mult < 1.225:
        return "severe"
    return "catastrophic"


# ── public API ─────────────────────────────────────────────────────────────


class SCSPeril(Peril):
    """Severe Convective Storm peril — Monte-Carlo hail-swath generator.

    Each scenario is a hail event placed inside Brooks et al. (2003) Hail
    Alley with stone diameter drawn from the TORRO distribution, and a
    kite-shaped swath polygon oriented by storm-motion bearing.

    The scenario carries ``peril = "hail"`` so the canonical hail damage
    curves (PERIL_SCALES.hail / _HAZUS_MATRIX[..]["hail"]) drive loss
    compute without modification.
    """

    peril_id = "scs"

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
            stone_d = _draw_stone_diameter(rng)
            centroid = _draw_centroid(rng)
            geom = _swath_polygon(centroid, stone_d, rng)
            scenarios.append({
                "kind": self.peril_id,
                "id": f"{scenario_id}_{i + 1:04d}",
                "peril": "hail",                     # mirror invariant
                "severity": stone_d,                  # mm — feeds PERIL_SCALES.hail
                "intensity": _legacy_intensity_for_diameter(stone_d),
                "centroid": centroid,
                "geometry": geom,
                "prob": prob,
            })
        # Re-normalise — 1/n may not be exactly representable in float.
        total = sum(s["prob"] for s in scenarios)
        if total > 0 and abs(total - 1.0) > 1e-9:
            for s in scenarios:
                s["prob"] = s["prob"] / total
        return scenarios


register_peril(SCSPeril())


__all__ = ["SCSPeril"]
