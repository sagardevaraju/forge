"""Task P3.17 — Freeze / Winter-Storm peril Monte-Carlo generator.

Produces regional freeze-event scenarios for use by the multi-peril
precompute pipeline. The plug-in id is ``"freeze"`` (the meteorological
cause — sustained hard-freeze events driving pipe burst, ice loading,
and HVAC failure); the *damage curve* it dispatches to is the canonical
``winter`` peril in ``lib/sim/severity.ts`` / ``api_py/sim_loss.py``
(which renders as **"Winter Storm"** in the operator UI per
research.md §6 and the peril-severity-calibration convention).

Calibrated against three real-world sources:

- **NOAA ERA5 freeze-event reanalysis** — identifies hard-freeze
  events (T < 0 °C for ≥ 3 consecutive hours) over CONUS for
  frequency calibration. The most damaging US events of the last
  decade (Polar Vortex 2014, Lake-effect Buffalo 2014, Polar Vortex
  Jan-Feb 2019, Winter Storm Uri Feb 2021, Buffalo Christmas 2022)
  all carry NWS WSSI ratings in the Major / Extreme tier.
  https://www.ecmwf.int/en/forecasts/dataset/ecmwf-reanalysis-v5
- **NWS Winter Storm Severity Index (WSSI)** — operational
  impact-based 5-tier scale (Limited / Minor / Moderate / Major /
  Extreme). Severity distribution among industry-loss-bearing events
  in the 2018-2023 WSSI archive: Limited 50%, Minor 30%, Moderate
  12%, Major 6%, Extreme 2%. https://www.weather.gov/wssi/
- **Texas Department of Insurance (2022)** — *Insured Losses
  Resulting from the February 2021 Winter Weather Event*. The Uri
  anchor: $11.2 B insured loss, 510,772 claims, ≈ 0.45 % statewide
  mean damage ratio; 5-15 % in worst-hit Houston / DFW ZIP3s. Pins
  the Extreme-tier multiplier of 1.0 (research.md §6b).
  https://www.tdi.texas.gov/reports/documents/feb2021-tx-winter-weather-summary-mar2022.pdf

Damage curve mirror invariant
-----------------------------
Every scenario carries ``peril = "winter"`` and a WSSI level id (one of
``"limited"`` / ``"minor"`` / ``"moderate"`` / ``"major"`` /
``"extreme"``) that maps directly into the canonical winter curves:

- ``lib/sim/severity.ts`` ``PERIL_SCALES.winter`` (multipliers 0.01 /
  0.04 / 0.15 / 0.40 / 1.00 — research.md §6b).
- ``api_py/sim_loss.py`` ``_HAZUS_MATRIX[..]["winter"]`` (per-build-
  type severe-anchor row).

Regional archetypes
-------------------
Three damaging-freeze archetypes drive the geographic draw:

- **polar_vortex** — Plains/Midwest/Texas cold-air intrusion. Largest
  spatial footprint (multi-state). Drives the Uri / Polar Vortex
  2019 type events.
- **lake_effect** — Great Lakes belt (NY / PA / OH / MI / IN / IL /
  WI). Smaller footprint, can carry Extreme rating locally
  (Buffalo Dec 2022).
- **ice_storm** — Southeast / Mid-Atlantic / mid-South. Drives most
  insured ice-damage claims by frequency (Insurance Information
  Institute baseline: $1.3 B/yr).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ml.perils.base import Peril, register_peril


# ── calibration constants ──────────────────────────────────────────────────

# WSSI category distribution among industry-loss-bearing freeze events
# (NWS WSSI archive 2018-2023, weighted by ≥ 1 commercial-loss-bearing
# event share — non-damaging Limited/Minor events dominate raw WSSI
# counts but contribute < 1 % of industry loss). Approximate; see
# research.md §6c.
_SEVERITY_DISTRIBUTION: list[tuple[str, float]] = [
    ("limited",  0.50),
    ("minor",    0.30),
    ("moderate", 0.12),
    ("major",    0.06),
    ("extreme",  0.02),
]
assert abs(sum(w for _, w in _SEVERITY_DISTRIBUTION) - 1.0) < 1e-9

# Regional archetype shares (NOAA ERA5 reanalysis 2014-2023 weighted by
# WSSI-tier severity counts). Polar Vortex dominates Major + Extreme
# tiers; ice storms dominate the frequency tail.
_REGION_DISTRIBUTION: list[tuple[str, float]] = [
    ("polar_vortex", 0.35),
    ("lake_effect",  0.25),
    ("ice_storm",    0.40),
]
assert abs(sum(w for _, w in _REGION_DISTRIBUTION) - 1.0) < 1e-9

# Per-archetype bounding boxes (degrees). These are the CENTROID draw
# bounds; the polygon extent around the centroid scales with severity.
_REGION_BBOX: dict[str, dict[str, float]] = {
    # Polar Vortex — Plains + Midwest + Texas + Mid-South. The dominant
    # cold-air intrusion track.
    "polar_vortex": {
        "lat_min": 28.0, "lat_max": 47.0,
        "lon_min": -105.0, "lon_max": -82.0,
    },
    # Lake-effect — Great Lakes belt.
    "lake_effect": {
        "lat_min": 40.0, "lat_max": 47.0,
        "lon_min": -90.0, "lon_max": -73.0,
    },
    # Ice storm — Southeast + Mid-Atlantic + lower Midwest.
    "ice_storm": {
        "lat_min": 30.0, "lat_max": 42.0,
        "lon_min": -95.0, "lon_max": -75.0,
    },
}

# Footprint half-axis in degrees per WSSI tier. Bigger events cover more
# area (Uri covered all of TX + OK + LA + most of MS / AR / TN). The
# extreme half-axis (~4°) corresponds to ~ 800 km × 800 km, matching
# Uri's reported affected area.
_SEVERITY_HALF_AXIS_DEG: dict[str, float] = {
    "limited":  0.6,    # county-cluster
    "minor":    1.2,    # small-multi-county
    "moderate": 2.0,    # multi-state corridor
    "major":    3.0,    # regional
    "extreme":  4.0,    # multi-state / continental
}


# ── helpers ────────────────────────────────────────────────────────────────


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


def _draw_region(rng: np.random.Generator) -> tuple[str, dict[str, float]]:
    weights = np.array([w for _, w in _REGION_DISTRIBUTION])
    idx = int(rng.choice(len(_REGION_DISTRIBUTION), p=weights))
    name = _REGION_DISTRIBUTION[idx][0]
    return name, _REGION_BBOX[name]


def _draw_centroid(rng: np.random.Generator, bbox: dict[str, float]) -> dict[str, float]:
    lat = float(rng.uniform(bbox["lat_min"], bbox["lat_max"]))
    lon = float(rng.uniform(bbox["lon_min"], bbox["lon_max"]))
    return {"lat": round(lat, 4), "lon": round(lon, 4)}


def _footprint_polygon(
    centroid: dict[str, float],
    severity: str,
    rng: np.random.Generator,
) -> dict:
    """Build an oblong elliptical Polygon around ``centroid`` whose half-
    axes scale with severity. 24-vertex base, per-vertex radial jitter
    so cold-front footprints don't all look identical. The major axis
    is rotated by a random bearing to capture both NE-SW (typical cold
    front) and NW-SE (lake-effect band) orientations.
    """
    base = _SEVERITY_HALF_AXIS_DEG[severity]
    # Aspect ratio: long axis ~1.5× short axis (cold-fronts are linear).
    a_deg = base * 1.5
    b_deg = base
    cos_lat = max(math.cos(math.radians(centroid["lat"])), 0.1)
    # Random bearing across full circle.
    theta_rot = float(rng.uniform(0.0, 2.0 * math.pi))
    cos_r, sin_r = math.cos(theta_rot), math.sin(theta_rot)
    nverts = 24
    ring: list[list[float]] = []
    for i in range(nverts):
        theta = 2.0 * math.pi * i / nverts
        # Per-vertex radial jitter (±15 %).
        jitter = float(rng.uniform(0.85, 1.15))
        x = a_deg * jitter * math.cos(theta)
        y = b_deg * jitter * math.sin(theta)
        # Rotate.
        xr = x * cos_r - y * sin_r
        yr = x * sin_r + y * cos_r
        # Lon scaled by cos(lat) so high-latitude polygons aren't stretched.
        ring.append([
            round(centroid["lon"] + xr / cos_lat, 5),
            round(centroid["lat"] + yr, 5),
        ])
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def _legacy_intensity_for_severity(severity: str) -> str:
    """Bucket WSSI tier into the legacy three-tier ``intensity`` label."""
    mult = {"limited": 0.01, "minor": 0.04, "moderate": 0.15,
            "major": 0.40, "extreme": 1.00}[severity]
    if mult < 0.775:
        return "moderate"
    if mult < 1.225:
        return "severe"
    return "catastrophic"


# ── public API ─────────────────────────────────────────────────────────────


class FreezePeril(Peril):
    """Freeze / Winter-Storm peril — Monte-Carlo regional-footprint generator.

    Each scenario draws a WSSI severity from the industry-loss-weighted
    distribution, a regional archetype (polar_vortex / lake_effect /
    ice_storm), an event centroid within the archetype's bbox, and an
    oblong elliptical footprint whose extent scales with severity.

    The scenario carries ``peril = "winter"`` so the canonical winter
    damage curves (``PERIL_SCALES.winter`` / ``_HAZUS_MATRIX[..]["winter"]``)
    drive loss compute without modification. Operator-facing label is
    **"Winter Storm"** (`PERIL_LABELS.winter`).
    """

    peril_id = "freeze"

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
            region_name, bbox = _draw_region(rng)
            centroid = _draw_centroid(rng, bbox)
            geom = _footprint_polygon(centroid, severity, rng)
            scenarios.append({
                "kind": self.peril_id,
                "id": f"{scenario_id}_{i + 1:04d}",
                "peril": "winter",                          # mirror invariant
                "severity": severity,                       # WSSI level id
                "intensity": _legacy_intensity_for_severity(severity),
                "region": region_name,
                "centroid": centroid,
                "geometry": geom,
                "prob": prob,
            })
        total = sum(s["prob"] for s in scenarios)
        if total > 0 and abs(total - 1.0) > 1e-9:
            for s in scenarios:
                s["prob"] = s["prob"] / total
        return scenarios


register_peril(FreezePeril())


__all__ = ["FreezePeril"]
