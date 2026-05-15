"""Simplified HAZUS depth-damage curves for residential property.
Source: FEMA HAZUS-MH Hurricane Technical Manual, Table 6.1.
"""
import numpy as np


def wind_damage_ratio(peak_wind_mph: float, build_type: str) -> float:
    """Returns fraction of TIV lost given peak wind speed.

    Args:
        peak_wind_mph: 1-minute sustained peak wind speed in mph.
        build_type: One of 'wood_frame', 'masonry', 'manufactured'.
            Defaults to 'wood_frame' for unknown types.

    Returns:
        Damage ratio in [0, 1] representing fraction of TIV lost.
    """
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

    Args:
        surge_depth_m: Maximum storm surge depth above mean sea level (metres).
        elevation_m: Finished floor elevation above mean sea level (metres).

    Returns:
        Damage ratio in [0, 1] representing fraction of TIV lost.
    """
    above_floor = max(surge_depth_m - elevation_m, 0.0)
    breakpoints = [(0.0, 0.00), (0.3, 0.10), (1.0, 0.35), (2.0, 0.65), (4.0, 0.95)]
    depths = [b[0] for b in breakpoints]
    ratios = [b[1] for b in breakpoints]
    return float(np.interp(above_floor, depths, ratios))
