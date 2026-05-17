"""Tasks P2.1 + P2.2 — calibration utilities for quantile forecasts.

P2.1 — ``crps_from_quantiles``: true continuous CRPS via PCHIP-spline
CDF + adaptive numerical quadrature. CRPS is the calibration metric an
actuary will actually accept for a probabilistic loss forecast. The
3-point pinball proxy we ship from ``ml/xgb/train.py`` is fine as a
training signal but a poor reporting metric: it tells you nothing about
the *shape* of the distribution between the quantile heads.

P2.2 — ``reliability_curve`` + ``pit_histogram``: data primitives behind
the P2.16 ``/calibration`` view. ``reliability_curve`` bins forecasts by
predicted-quantile value and reports the empirical exceedance frequency
per bin; ``pit_histogram`` returns bin counts for the probability
integral transform (a flat histogram = perfectly calibrated forecast).

This module is a **library** (no ``handler`` class, no Vercel route) and
follows the same import convention as ``api_py.optimize_portfolio``.
Callers: the precompute scripts and ``ml/xgb/train.py``'s eval block.

Cost: ~10 ms per cohort for CRPS (PCHIP build + 1 adaptive-quadrature
integral) vs ~10 µs for pinball. On a 570-cohort book that's ~6 s extra
in the nightly recompute — trivial. ``reliability_curve`` /
``pit_histogram`` are pure-numpy and run in microseconds.
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


def reliability_curve(
    forecasts: np.ndarray,
    observations: np.ndarray,
    target_prob: float,
    n_bins: int = 10,
) -> list[dict]:
    """Bin forecasts by predicted-quantile value, return (forecast, observed) pairs.

    For a target probability ``q`` (e.g. 0.9 for the p90 head), a
    well-calibrated forecast should have ``observations <= forecasts``
    in roughly ``q`` fraction of cases. This function slices the forecast
    range into ``n_bins`` equal-width bins and reports the empirical
    exceedance frequency inside each bin alongside the bin's mid-forecast.

    The plot at the call site (P2.16) overlays the resulting ``(mid,
    observed_freq)`` curve against the horizontal line ``y = target_prob``
    — divergence between the two is mis-calibration.

    Args:
        forecasts: 1-D array of predicted quantile values.
        observations: 1-D array of ground-truth observations (same length).
        target_prob: Probability level the forecasts were trained against
            (e.g. ``0.9`` for the p90 head). Echoed back in every output
            pair so callers don't need to thread it separately.
        n_bins: Number of equal-width bins to slice the forecast range into.

    Returns:
        A list of ``{forecast_prob, observed_freq, forecast_value_mid, n}``
        dicts, one per non-empty bin. Empty bins are dropped (the front-end
        can't plot a NaN).
    """
    bins = np.linspace(forecasts.min(), forecasts.max(), n_bins + 1)
    bin_idx = np.digitize(forecasts, bins) - 1
    out: list[dict] = []
    for b in range(n_bins):
        mask = bin_idx == b
        if mask.sum() == 0:
            continue
        out.append(
            {
                "forecast_prob": float(target_prob),
                "observed_freq": float((observations[mask] <= forecasts[mask]).mean()),
                "forecast_value_mid": float(forecasts[mask].mean()),
                "n": int(mask.sum()),
            }
        )
    return out


def pit_histogram(samples: np.ndarray, n_bins: int = 10) -> list[int]:
    """Bin probability-integral-transform samples into a histogram.

    The PIT of a probabilistic forecast is uniform on [0, 1] if and only
    if the forecast is perfectly calibrated. A U-shaped histogram signals
    under-dispersion (forecasts too narrow); a hump-shaped one signals
    over-dispersion (forecasts too wide).

    Args:
        samples: 1-D array of PIT values in [0, 1].
        n_bins: Number of equal-width bins on [0, 1].

    Returns:
        A list of ``n_bins`` integer counts. ``sum(counts) == len(samples)``
        provided every sample lies inside [0, 1].
    """
    counts, _ = np.histogram(samples, bins=np.linspace(0, 1, n_bins + 1))
    return counts.tolist()
