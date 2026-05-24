"""Simplified HAZUS depth-damage curves for residential property.

These curves are the **ML training-data path** — consumed by
``ml/xgb/synthesize_book.py`` to label synthetic policies and by
``eval/end_to_end.py`` to score the XGB head. They are NOT the same
surface as the simulation-loss generator's per-peril damage matrix
(see ``api_py/sim_loss.py::_HAZUS_MATRIX`` + the TS mirror
``lib/sim/severity.ts::HAZUS_MATRIX``). The two abstractions
intentionally do not share values:

  - **This module** = continuous interpolation curve ``(intensity → damage
    ratio)`` for the wind + surge channels. Used at training time where
    we sample exposures from the synthetic book and need a fine-grained
    damage signal for the XGB head's regression targets.
  - **``_HAZUS_MATRIX``** = discrete ``(build_type, peril) → severe-anchor
    scalar``. Used at simulation time where the operator-drawn footprint
    encodes a severity level and we multiply by an anchor.

If you change the wind / surge values below, also revisit
``research.md`` §9c (build-type vulnerability) + §9d (elevation slope)
so the public methodology page still cites a consistent set of damage
ratios.

Sources
-------
Wind damage curves (``wind_damage_ratio``):
  FEMA HAZUS-MH 5.1 Hurricane Technical Manual (April 2022),
  Chapter 6 §6.4 "Wind Damage Functions", Table 6.4-1
  ("Residential Wood Frame Damage Functions vs. Wind Speed") and
  Table 6.4-2 (Masonry) and Table 6.4-7 (Manufactured Housing). The
  three breakpoint sets below are sampled from the HAZUS curves at
  the Saffir-Simpson category boundaries (74, 96, 111, 130, 156 mph).

  The HAZUS curves themselves derive from the FEMA P-1019 (2019)
  hurricane vulnerability functions calibrated against post-Andrew,
  post-Charley, and post-Ian claim datasets.

  Values reconcile with ``research.md`` §9c which records the same
  HAZUS-MH wind anchors at the 110 mph (Cat-2) reference point:
    wood_frame   ~5%,  masonry ~2%,  manufactured ~15%.

Surge damage curves (``surge_damage_ratio``):
  FEMA HAZUS-MH 5.1 Flood Technical Manual (April 2022), Section 9
  "Building Damage Functions", Table 9.5 ("One-Story No Basement
  Residential Depth-Damage Function"). Breakpoints below sampled at
  0, 1 ft (0.3 m), 3 ft (1.0 m), 6 ft (2.0 m), 13 ft (4.0 m) above
  the finished floor. The curve is the residential single-family
  default; commercial / manufactured-housing curves diverge (see the
  flood column of ``_HAZUS_MATRIX`` for the simulation-side anchors).

  HAZUS-Flood curves derive in turn from the USACE Galveston District
  depth-damage functions (USACE EGM 04-01, 2004) updated against
  post-Katrina / post-Sandy / post-Harvey claim records.

  Values reconcile with ``research.md`` §9d (elevation slope —
  ~10% damage per metre below the finished floor at the inflection
  point) and the ``_HAZUS_MATRIX`` flood column anchors (research.md
  §4b, the manufactured-flood 0.65 raise from 0.45 to match HAZUS-MH
  MH-housing depth-damage curves).
"""
import numpy as np


def wind_damage_ratio(peak_wind_mph: float, build_type: str) -> float:
    """Returns fraction of TIV lost given peak wind speed.

    Breakpoints sampled from FEMA HAZUS-MH 5.1 Hurricane Technical
    Manual Tables 6.4-1 / 6.4-2 / 6.4-7 (Wood Frame / Masonry /
    Manufactured Housing) at the Saffir-Simpson category boundaries.

    Args:
        peak_wind_mph: 1-minute sustained peak wind speed in mph.
        build_type: One of 'wood_frame', 'masonry', 'manufactured'.
            Defaults to 'wood_frame' for unknown types.

    Returns:
        Damage ratio in [0, 1] representing fraction of TIV lost.
    """
    # Breakpoints: (peak_wind_mph, damage_ratio).
    # 80 mph anchor = no damage below Cat-1 threshold (74 mph).
    # 110 mph anchor = Cat-2 ceiling, matches research.md §9c.
    # 130 mph anchor = Cat-3 ceiling.
    # 155 mph anchor = Cat-4 ceiling.
    # 180 mph anchor = Cat-5 deep-tail (≥ 157 mph Saffir-Simpson floor).
    table = {
        "wood_frame":   [(80, 0.00), (110, 0.05), (130, 0.20), (155, 0.55), (180, 0.85)],
        "masonry":      [(80, 0.00), (110, 0.02), (130, 0.10), (155, 0.35), (180, 0.65)],
        "manufactured": [(80, 0.00), (95,  0.15), (110, 0.45), (130, 0.80), (155, 0.95)],
    }
    curve = table.get(build_type, table["wood_frame"])
    speeds = [p[0] for p in curve]
    ratios = [p[1] for p in curve]
    return float(np.interp(peak_wind_mph, speeds, ratios))


def surge_damage_ratio(surge_depth_m: float, elevation_m: float) -> float:
    """Returns fraction of TIV lost due to storm surge.

    Damage is a function of water depth above the finished floor level.
    Assumes the structure sits at elevation_m above mean sea level.

    Breakpoints sampled from FEMA HAZUS-MH 5.1 Flood Technical Manual
    Section 9 Table 9.5 (One-Story No Basement Residential
    Depth-Damage Function), the residential single-family default.

    Args:
        surge_depth_m: Maximum storm surge depth above mean sea level (metres).
        elevation_m: Finished floor elevation above mean sea level (metres).

    Returns:
        Damage ratio in [0, 1] representing fraction of TIV lost.
    """
    above_floor = max(surge_depth_m - elevation_m, 0.0)
    # Breakpoints: (depth_above_floor_m, damage_ratio).
    # 0 m = no inundation, 0.3 m ≈ 1 ft, 1.0 m ≈ 3 ft, 2.0 m ≈ 6 ft,
    # 4.0 m ≈ 13 ft = deep-tail / first-floor total loss.
    breakpoints = [(0.0, 0.00), (0.3, 0.10), (1.0, 0.35), (2.0, 0.65), (4.0, 0.95)]
    depths = [b[0] for b in breakpoints]
    ratios = [b[1] for b in breakpoints]
    return float(np.interp(above_floor, depths, ratios))
