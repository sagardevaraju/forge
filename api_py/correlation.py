"""Task P2.4 — common-factor event-residual loss correlation.

Each cohort's loss within a single scenario is multiplied by a shared
event-residual factor ``(1 + β · ε)`` where ``ε ~ N(0, σ²)`` is drawn
**once per scenario** and re-used across every cohort.  This injects
the cheapest defensible chunk of inter-cohort tail dependence into an
otherwise independent per-cohort loss draw.

Why single-factor (and not a Gaussian copula)?  A copula on the cohort
vector is the textbook answer and the Phase 3 upgrade.  A single shared
shock is roughly 10× cheaper to implement and reason about, captures the
first-order "the storm hits the whole book or none of it" intuition, and
moves the credibility needle the most for the least code.

Calibration
-----------
The defaults ``β = 0.5`` and ``σ = 0.3`` are sensible starting literals.
A proper fit against NOAA Storm Events per-event residuals is a separate
analysis (tracked as a follow-up to P2.4).

Determinism
-----------
The function is pure and deterministic given ``(losses, β, σ, seed)``.
A fixed ``seed`` reproduces the same ε vector regardless of platform.
"""

from __future__ import annotations

import numpy as np

# Sensible defaults pending NOAA Storm Events calibration.
DEFAULT_BETA = 0.5
DEFAULT_SIGMA = 0.3


def apply_common_factor(
    losses: np.ndarray,
    beta: float = DEFAULT_BETA,
    sigma: float = DEFAULT_SIGMA,
    seed: int = 0,
) -> np.ndarray:
    """Apply shared event-residual to a (scenarios, cohorts) loss matrix.

    Transform::

        L'_{s,c} = L_{s,c} · (1 + β · ε_s)        ε_s ~ N(0, σ²)

    where one ε is drawn per scenario row and broadcast across cohort
    columns.  Resulting cohort losses share a common multiplicative
    factor within a scenario but the underlying per-cohort heterogeneity
    is preserved.

    Parameters
    ----------
    losses:
        2-D float array of shape ``(n_scenarios, n_cohorts)``.
    beta:
        Loading on the shared ε; 0 collapses to the identity transform.
    sigma:
        Standard deviation of the shared event-residual.
    seed:
        Deterministic seed for the ε draw.

    Returns
    -------
    np.ndarray
        Same shape as ``losses``, with the shared multiplier applied
        row-wise.
    """
    rng = np.random.default_rng(seed)
    eps = rng.normal(0.0, sigma, size=losses.shape[0])  # one ε per scenario
    multiplier = 1.0 + beta * eps  # shape: (n_scenarios,)
    return losses * multiplier[:, np.newaxis]  # broadcast over cohorts


__all__ = ["apply_common_factor", "DEFAULT_BETA", "DEFAULT_SIGMA"]
