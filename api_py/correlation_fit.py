"""Task AUDIT.1 — common-factor (β, σ) fitter from NOAA Storm Events.

Closes the deferral in ``api_py/correlation.py``: the literal defaults
``β = 0.5``, ``σ = 0.3`` were documented as "sensible starting literals
pending NOAA Storm Events calibration". This module ships the
calibration.

The model
---------
The simulation-loss generator (``api_py/sim_loss.py``) applies a single
per-scenario multiplicative perturbation::

    L'_{s,c} = L_{s,c} · (1 + β · ε_s),   ε_s ~ N(0, σ²)

drawn once per scenario and broadcast over every cohort. ``β`` is the
loading on a unit-variance latent shock; ``σ`` parameterises the shock
itself. The product ``β·σ`` controls the cross-event CoV of the
multiplier.

Why σ is fixed at 1.0 in the fit
--------------------------------
``β`` and ``σ`` are not separately identifiable from observational
damage data — only their product appears in the likelihood::

    Var( L'_{s,c} | L_{s,c} ) = L_{s,c}² · β² · σ²

The conventional resolution is to fix σ = 1 (unit-variance latent
shock) and let β alone parameterize the CoV. ``api_py/correlation.py``
keeps σ as a config knob so a future analyst with paired
forecast/realization data can re-parameterize; this fitter writes back
``β = CoV(episode_totals)`` and ``σ = 1.0`` under the convention.

The fit
-------
For every storm episode in the data, sum the per-county property
damage to get a total ``D_e``. Across N episodes the empirical
coefficient of variation is::

    β̂ = std(D_e) / mean(D_e)

This matches the model's predicted CoV ``β·σ`` under σ=1. Geometric
log-CoV is a defensible alternative — both reduce to the same scalar
under log-normal heavy tails — but the linear CoV is what the model
literally implements (the perturbation is ``(1 + β·ε)``, not
``exp(β·ε)``).

Minimum-sample gate
-------------------
The estimator is noisy below ~8 episodes. At fewer episodes,
``fit_common_factor_from_storm_events`` returns ``None`` with a
``reason`` so the caller (e.g. ``scripts.precompute_calibration``) can
emit an INSUFFICIENT_DATA marker rather than persist a low-confidence
β to the calibration artifact. The current `storm_events` table at
HEAD (2024 only, 4 storms across FL/TX/LA/NC) sits below this
threshold — the fitter ships now as a future-ready component;
enabling it requires extending the ingestion (see
``scripts/ingest_storm_events.py``) to multiple years.

Episode grouping
----------------
NOAA Storm Events CSVs carry an ``EPISODE_ID`` field that groups
related county-level reports into a single storm. Until that column
lands in the local schema, the fitter accepts a ``group_key`` callback
so the caller can fall back to ``(year, state, event_type)`` as a
coarse proxy.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from typing import TypedDict


# The smallest sample where the empirical CoV is more credible than the
# literal default. Setting this very high (e.g., 30) would be more
# defensible statistically but would block the fit on most demo
# corpora; setting it too low silently lets a 3-storm year drive the
# common-factor parameter. 8 is a compromise — at 8 episodes the
# standard error of the CoV is roughly 25% of the point estimate.
MIN_EPISODES_FOR_FIT = 8


class CommonFactorFit(TypedDict):
    """Output of a successful fit — drop straight into
    ``calibration.json`` under ``common_factor``."""

    beta: float
    sigma: float
    method: str
    n_episodes: int
    source: str


class InsufficientDataNote(TypedDict):
    """Returned when the fit doesn't have enough episodes to be honest
    about a β estimate."""

    fitted: bool
    reason: str
    n_episodes: int
    min_episodes: int


def fit_beta_from_episode_totals(totals: list[float]) -> float:
    """Fit β from a list of per-episode total damages.

    β̂ = std(totals, ddof=1) / mean(totals) under the σ=1 convention.

    Raises
    ------
    ValueError
        ``totals`` has fewer than 2 entries (variance undefined) or
        every total is non-positive (mean ≤ 0 would divide by zero or
        flip sign).
    """
    n = len(totals)
    if n < 2:
        raise ValueError(
            f"need at least 2 episode totals to fit β; got {n}"
        )
    mean = sum(totals) / n
    if mean <= 0:
        raise ValueError(
            f"episode totals have non-positive mean ({mean:.2f}); "
            "fit requires strictly positive damage observations"
        )
    var = sum((x - mean) ** 2 for x in totals) / (n - 1)
    std = math.sqrt(var)
    return std / mean


def fit_common_factor_from_storm_events(
    rows: Iterable[dict],
    *,
    group_key: Callable[[dict], tuple] | None = None,
    min_episodes: int = MIN_EPISODES_FOR_FIT,
) -> CommonFactorFit | InsufficientDataNote:
    """Fit ``(β, σ)`` from raw ``storm_events`` rows.

    Groups rows into episodes, sums ``damage_property`` per episode,
    then delegates to :func:`fit_beta_from_episode_totals`. Returns a
    :class:`CommonFactorFit` on success or an
    :class:`InsufficientDataNote` when the sample is too thin.

    Parameters
    ----------
    rows
        Iterable of dicts with at minimum keys ``damage_property``
        plus whatever fields ``group_key`` reads.
    group_key
        Callable mapping a row to a tuple key. Defaults to
        ``(year, state, event_type)`` which is the coarsest grouping
        the current schema supports. Once ``episode_id`` lands, the
        caller should pass ``lambda r: (r["episode_id"],)``.
    min_episodes
        Refuse to emit a fit with fewer than this many episodes.

    Notes
    -----
    Rows with ``damage_property is None`` are skipped — we can't sum
    a missing damage. Rows with ``damage_property == 0`` are included;
    a storm that struck but caused no reported damage is a real
    observation (low-loss tail).
    """
    if group_key is None:
        def group_key(r: dict) -> tuple:  # type: ignore[no-redef]
            return (r.get("year"), r.get("state"), r.get("event_type"))

    totals: dict[tuple, float] = {}
    for r in rows:
        damage = r.get("damage_property")
        if damage is None:
            continue
        key = group_key(r)
        totals[key] = totals.get(key, 0.0) + float(damage)

    # Drop pure-zero episodes — a storm with literally zero reported
    # damage everywhere yields a mean-dragging point that's almost
    # certainly an ingestion artifact rather than a real observation.
    episode_totals = [v for v in totals.values() if v > 0]

    n = len(episode_totals)
    if n < min_episodes:
        return {
            "fitted": False,
            "reason": (
                f"INSUFFICIENT_EPISODES ({n} < {min_episodes}); "
                "extend storm_events ingestion to multiple years or lower the gate"
            ),
            "n_episodes": n,
            "min_episodes": min_episodes,
        }

    try:
        beta = fit_beta_from_episode_totals(episode_totals)
    except ValueError as exc:
        return {
            "fitted": False,
            "reason": f"FIT_ERROR: {exc}",
            "n_episodes": n,
            "min_episodes": min_episodes,
        }

    return {
        "beta": beta,
        "sigma": 1.0,  # σ-1 convention — see module docstring
        "method": "cov_per_episode_total",
        "n_episodes": n,
        "source": "noaa_storm_events",
    }
