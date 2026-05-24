"""Per-state per-peril additional AAL (annual average loss) overlay.

The existing :func:`scripts.precompute_portfolio_optimization._cohort_loss_quantiles`
gives each cohort a hurricane-anchored lognormal prior (PRIOR_SIGMA = 0.85,
calibrated to FL HO industry; see research.md §9). That prior is *implicitly*
hurricane-dominated because its calibration target is the Citizens FL 2024
loss ratio, which is a hurricane-tail signal.

This module adds *named-peril* contributions on top of that prior:

* **SCS (hail/wind)** — meaningful for TX (eastern fringe of Hail Alley);
  small for LA/NC; trace for FL.
* **Winter storm** — meaningful for TX (Uri 2021 lesson); modest for NC/LA;
  trace for FL.
* **Wildfire** — near-zero for the FORGE book (TX/LA/NC/FL coastal SE; no
  CA/PNW/Mountain-West exposure).
* **Earthquake** — near-zero for the FORGE book (no CA/PNW exposure).

Each contribution is sampled as an *independent* lognormal per peril and
summed onto the cohort's loss-scenarios array. The K = 1000 draws produce
a JOINT multi-peril TVaR-99 in the precompute artifact downstream.

The hurricane prior stays in the existing module (no double-counting).
This module's name "additional_*" reflects that.

Calibration sources
-------------------

**SCS (hail/wind) — per-state AAL rate (fraction of TIV per year)**

- Smith & Katz (2013, *Nat Hazards* 67) Table 3 + Figure 3: severe convective
  storms = 26 of 133 US billion-dollar weather disasters 1980-2011 (~20%),
  with annual US insured losses ~$15-25B/year (NICB 2019 catastrophe trend).
- Brooks et al. (2003, *Wea. Forecast.* 18) Fig. 5: SCS hail frequency
  concentrated over TX/OK/KS/NE/IA/MO/SD ("Hail Alley"). TX is the eastern
  edge with ~half the per-area frequency of central Plains.
- Allen et al. (2017, *J. Clim* 30) Table 2: TX has the highest insured
  hail losses among states by absolute $ amount; per-policy AAL ~$180/yr
  on $250k TIV ≈ 0.072% TIV. Less in southern TX than panhandle.
- LA/NC/FL: largely outside Hail Alley but get occasional convective hail;
  AAL ~0.02-0.05% TIV/yr.

**Winter storm — per-state AAL rate (fraction of TIV per year)**

- TDI 2022 *Uri Final Report*: $19B insured losses on $4.4T TX TIV ≈
  0.43% one-time. AAL-equivalent assuming 1-in-30-year recurrence: ~0.014%.
  But Uri-class events are anchored higher in 2026 climatology (recurrent
  Arctic intrusions); use 0.025% AAL TIV/yr for TX (conservative).
- Karen Clark & Co. (2022): NC + LA winter exposure ~0.02% TIV/yr from
  ice-storm + freeze-damage modeling.
- FL: essentially zero (no freeze exposure for HO-3 lines outside ag).

**Wildfire — per-state AAL rate (fraction of TIV per year)**

- Headwaters Economics (2024) US Wildfire AAL Maps: TX/LA/NC/FL are all
  in the lowest "trace" exposure bin (< 0.005% AAL TIV/yr). Coastal SE
  is humid; large fires are rare and small.

**Earthquake — per-state AAL rate (fraction of TIV per year)**

- USGS NSHM 2023 + FEMA HAZUS-MH EQ TM: TX/LA/NC/FL are all in the
  lowest national seismic hazard tier. EQ AAL on standard HO-3
  (with-EQ-rider) policies < 0.001% TIV/yr. Without rider: zero.

**Per-peril sigma (heavy-tail width)**

- Hurricane: σ = 0.85 (in existing prior; PML/AAL ≈ 7×)
- SCS: σ = 0.70 (hail is heavy-tailed but less so than hurricane;
  per-event losses are more uniformly distributed once you control for
  geography)
- Winter: σ = 1.20 (very heavy tail — Uri-class events are 10-30× normal
  winter losses; high recurrence variance)
- Wildfire: σ = 1.00 (heavy-tailed but contribution is so small to TX/FL
  book that the σ barely matters)
- Earthquake: σ = 1.50 (heaviest-tail peril; great variance between
  M5 nuisance and M7+ catastrophic; minimal contribution here)

References
----------

See research.md for full citations + the OpenFEMA / NICB / Karen Clark
queries used to anchor the per-state numbers above.
"""

from __future__ import annotations

import math
from typing import Final

import numpy as np

# ── per-state per-peril AAL rates ──────────────────────────────────────────
#
# Layout: PERIL_AAL_BY_STATE[peril_id][USPS_state_code] = fraction of TIV/yr.
# Hurricane is NOT in this table — it's already in the existing
# hurricane-anchored lognormal prior. This module adds *additional* perils on
# top to make the precompute's joint TVaR-99 truly multi-peril.
#
# Keys cover the 4 FORGE-book states (TX/LA/NC/FL) plus 'default' for any
# out-of-book state that might appear via a future seed extension. Numbers
# are conservative; they're meant to push the joint TVaR-99 modestly above
# the hurricane-only baseline, not double the book's expected loss.

PERIL_AAL_BY_STATE: Final[dict[str, dict[str, float]]] = {
    "scs": {
        "TX": 0.00072,   # 0.072% — Allen et al. 2017 TX hail AAL
        "LA": 0.00025,
        "NC": 0.00020,
        "FL": 0.00018,
        "default": 0.00010,
    },
    "winter": {
        "TX": 0.00025,   # 0.025% — TDI 2022 Uri 1-in-30 anchored higher in 2026
        "LA": 0.00012,
        "NC": 0.00020,
        "FL": 0.00002,
        "default": 0.00008,
    },
    "wildfire": {
        "TX": 0.00003,   # Headwaters Economics 2024 — trace
        "LA": 0.00002,
        "NC": 0.00002,
        "FL": 0.00002,
        "default": 0.00002,
    },
    "earthquake": {
        "TX": 0.000005,  # USGS NSHM 2023 — lowest tier; effectively zero
        "LA": 0.000005,
        "NC": 0.000008,  # Eastern TN seismic halo bumps NC slightly
        "FL": 0.000003,
        "default": 0.000005,
    },
}

# Per-peril lognormal sigma (tail width). Hurricane (σ=0.85) is in the
# existing module. The others reflect peril-specific tail characteristics.
PERIL_SIGMA: Final[dict[str, float]] = {
    "scs": 0.70,
    "winter": 1.20,
    "wildfire": 1.00,
    "earthquake": 1.50,
}

# Per-peril build-type vulnerability multipliers — relative to wood_frame=1.0.
# Sourced from lib/sim/severity.ts HAZUS_MATRIX:
#   * SCS / hail: manufactured roofing fails first (3.0×); masonry similar
#     to wood for hail (0.85).
#   * Winter: manufactured pipe-burst risk much higher (2.5×); masonry
#     slightly worse than wood due to interior plumbing in exterior walls
#     (1.1×).
#   * Wildfire: manufactured catastrophic-loss-prone (2.2×); masonry better
#     (0.55× — non-combustible envelope).
#   * EQ: manufactured collapse risk (3.5×); masonry brittle (2.0× — URM is
#     the dominant EQ-loss building type in HAZUS curves).
PERIL_BUILD_VULNERABILITY: Final[dict[str, dict[str, float]]] = {
    "scs": {"wood_frame": 1.00, "masonry": 0.85, "manufactured": 3.00},
    "winter": {"wood_frame": 1.00, "masonry": 1.10, "manufactured": 2.50},
    "wildfire": {"wood_frame": 1.00, "masonry": 0.55, "manufactured": 2.20},
    "earthquake": {"wood_frame": 1.00, "masonry": 2.00, "manufactured": 3.50},
}

PERIL_IDS: Final[tuple[str, ...]] = ("scs", "winter", "wildfire", "earthquake")


def _aal_rate(peril_id: str, state: str) -> float:
    """Look up the AAL rate for ``peril_id`` in ``state``.

    Falls back to the 'default' entry if state is unknown (e.g. an
    out-of-book ZIP3 from a future seed extension). Unknown perils raise.
    """
    if peril_id not in PERIL_AAL_BY_STATE:
        raise KeyError(f"Unknown peril '{peril_id}'. Known: {list(PERIL_AAL_BY_STATE)}")
    table = PERIL_AAL_BY_STATE[peril_id]
    return table.get(state, table["default"])


def _build_vuln(peril_id: str, build_type: str) -> float:
    """Look up the per-peril vulnerability multiplier for ``build_type``.

    Falls back to 1.0 for unknown build types (defensive — the seed book
    constrains build_type to {wood_frame, masonry, manufactured}).
    """
    if peril_id not in PERIL_BUILD_VULNERABILITY:
        raise KeyError(f"Unknown peril '{peril_id}'.")
    return PERIL_BUILD_VULNERABILITY[peril_id].get(build_type, 1.0)


def additional_peril_scenarios(
    total_tiv: float,
    state: str,
    build_type: str,
    cohort_key: str,
    n: int = 1000,
) -> dict[str, np.ndarray]:
    """Sample K=``n`` per-peril additional loss scenarios for one cohort.

    Returns
    -------
    dict[str, np.ndarray]
        Maps each of :data:`PERIL_IDS` (``"scs"``, ``"winter"``,
        ``"wildfire"``, ``"earthquake"``) to a length-``n`` array of
        non-negative additional loss draws. Each peril's draws are
        independent (within-year independence assumption per HAZUS
        Annual Loss aggregation guidance).

    Notes
    -----
    The hurricane contribution is NOT in this output — it stays in the
    existing prior. Callers should sum each peril's array onto the
    cohort's existing ``loss_scenarios`` to get the joint distribution.

    Seeds derive from ``hash((cohort_key, peril_id))`` so the artifact is
    deterministic within a single precompute run.
    """
    out: dict[str, np.ndarray] = {}
    for peril_id in PERIL_IDS:
        aal_rate = _aal_rate(peril_id, state)
        build_factor = _build_vuln(peril_id, build_type)
        aal = total_tiv * aal_rate * build_factor
        if aal <= 0:
            out[peril_id] = np.zeros(n, dtype=float)
            continue
        sigma = PERIL_SIGMA[peril_id]
        # AAL = E[X] for X ~ Lognormal(μ, σ²): E[X] = exp(μ + σ²/2)
        # ⇒ μ = log(AAL) - σ²/2
        mu = math.log(aal) - 0.5 * sigma * sigma
        seed = hash((cohort_key, peril_id)) & 0xFFFFFFFF
        rng = np.random.default_rng(seed=seed)
        out[peril_id] = rng.lognormal(mean=mu, sigma=sigma, size=n)
    return out


__all__ = [
    "PERIL_AAL_BY_STATE",
    "PERIL_SIGMA",
    "PERIL_BUILD_VULNERABILITY",
    "PERIL_IDS",
    "additional_peril_scenarios",
]
