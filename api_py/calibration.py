"""Task P2.1 — true continuous CRPS via quantile spline + numerical quadrature.

CRPS (Continuous Ranked Probability Score) is the calibration metric an
actuary will actually accept for a probabilistic loss forecast. The
3-point pinball proxy we ship from ``ml/xgb/train.py`` is fine as a
training signal but a poor reporting metric: it tells you nothing about
the *shape* of the distribution between the quantile heads.

This module is a **library** (no ``handler`` class, no Vercel route) and
follows the same import convention as ``api_py.optimize_portfolio``.
Callers: the precompute scripts and ``ml/xgb/train.py``'s eval block.

Cost: ~10 ms per cohort (PCHIP build + 1 adaptive-quadrature integral)
vs ~10 µs for pinball. On a 570-cohort book that's ~6 s extra in the
nightly recompute — trivial.
"""

from __future__ import annotations

import numpy as np
from scipy import interpolate
from scipy.integrate import quad


def crps_from_quantiles(y_true: float, quantiles: dict[float, float]) -> float:
    """True continuous CRPS via numerical integration over a spline interpolant.

    Builds a CDF interpolant from the supplied (probability, value) pairs,
    integrates ``(F(x) - 1{x >= y_true})^2`` over the support.
    ``scipy.integrate.quad``'s adaptive Gauss-Kronrod quadrature converges
    quickly for these inputs; ``limit=100`` caps the adaptive subdivision
    budget.

    Args:
        y_true: The observed value to score.
        quantiles: Mapping of probability level -> predicted quantile value
            (e.g. ``{0.1: q10, 0.5: q50, 0.9: q90}``).

    Returns:
        The CRPS as a non-negative float (0.0 == perfect calibration).
    """
    if len(quantiles) < 2:
        raise ValueError(
            "crps_from_quantiles requires at least 2 (probability, value) pairs; "
            f"got {len(quantiles)}."
        )
    probs = sorted(quantiles.keys())
    values = [quantiles[p] for p in probs]
    # Build CDF F(x): a monotone interpolation of (value, prob) pairs.
    # PCHIP preserves monotonicity, which is required for a valid CDF.
    cdf = interpolate.PchipInterpolator(values, probs, extrapolate=True)
    span = values[-1] - values[0]
    lo, hi = values[0] - 5 * span, values[-1] + 5 * span

    def integrand(x: float) -> float:
        # np.clip pins extrapolated CDF values into [0, 1] in the tails.
        return (np.clip(cdf(x), 0.0, 1.0) - (1.0 if x >= y_true else 0.0)) ** 2

    crps, _ = quad(integrand, lo, hi, limit=100)
    return float(crps)
