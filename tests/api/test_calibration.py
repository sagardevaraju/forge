"""Tasks P2.1 + P2.2 — unit tests for the calibration utility module.

P2.1: CRPS (Continuous Ranked Probability Score) is the actuary-grade
calibration metric for quantile forecasts. The closed form for a N(0,1)
forecast at ``y=0`` is ``2/sqrt(2*pi) - 1/sqrt(pi)`` which numerically
evaluates to ≈ 0.2337 (matching the 0.234 tolerance below). We sample
that distribution at the (p10, p50, p90) heads our XGBoost models emit
and verify the spline-from-quantiles integrand recovers the analytical
value within a generous tolerance.

P2.2: Reliability diagram + PIT histogram. ``reliability_curve`` bins
forecasts by predicted-quantile value and returns ``(forecast,
observed)`` pairs; ``pit_histogram`` returns counts of probability
integral transforms across equally spaced bins. A uniform PIT histogram
is the signature of a perfectly calibrated forecast.
"""

from __future__ import annotations

import numpy as np

from api_py.calibration import crps_from_quantiles, pit_histogram, reliability_curve


def test_crps_from_quantiles_matches_closed_form_for_normal() -> None:
    # For a N(0,1) target at y=0, CRPS has a closed form ~= 0.2334.
    quantiles = {0.1: -1.282, 0.5: 0.0, 0.9: 1.282}
    crps = crps_from_quantiles(y_true=0.0, quantiles=quantiles)
    assert abs(crps - 0.234) < 0.05


def test_crps_from_quantiles_nonzero_y_true_has_positive_indicator_term() -> None:
    """Sanity check the indicator term ``1{x >= y_true}``.

    The symmetric ``y_true=0`` case in the first test cannot detect a sign
    flip on the indicator (the integrand is symmetric about 0). Evaluating
    at ``y_true=0.5`` with the same N(0,1)-shaped quantiles must produce a
    finite, positive value bounded loosely above and below — anything
    outside ``(0.1, 0.6)`` would indicate the indicator term is wrong.
    """
    quantiles = {0.1: -1.282, 0.5: 0.0, 0.9: 1.282}
    crps = crps_from_quantiles(y_true=0.5, quantiles=quantiles)
    assert 0.1 < crps < 0.6, f"CRPS at y_true=0.5 out of expected band: {crps}"


# ---------------------------------------------------------------------------
# Task P2.2 — reliability_curve + pit_histogram
# ---------------------------------------------------------------------------


def test_reliability_curve_returns_calibration_pairs() -> None:
    forecasts_p90 = np.array([10, 12, 15, 18, 22])
    observations = np.array([8, 13, 17, 16, 25])
    pairs = reliability_curve(forecasts_p90, observations, target_prob=0.9, n_bins=5)
    assert all(isinstance(p, dict) for p in pairs)
    assert all("forecast_prob" in p and "observed_freq" in p for p in pairs)


def test_pit_histogram_returns_counts() -> None:
    # Seed deterministically — uniform draws at the bin boundary can give a
    # max-min spread close to 100, which would make the bound flaky with an
    # unseeded RNG. ``default_rng(0)`` lands well inside the envelope.
    rng = np.random.default_rng(0)
    samples = rng.uniform(0, 1, 1000)
    counts = pit_histogram(samples, n_bins=10)
    assert sum(counts) == 1000
    # roughly uniform
    assert max(counts) - min(counts) < 100


def test_reliability_curve_recovers_known_calibrated_median() -> None:
    """A perfectly calibrated p=0.5 forecast: half of observations below.

    Build forecasts spanning ``[0, 100)`` so the bin slicing is meaningful,
    then construct observations such that exactly half of them sit below
    the corresponding forecast. With ``n_bins=4`` and 100 samples, each
    bin contains 25 forecasts and exactly 12 or 13 of the matching
    observations should fall below — i.e. the bin-level ``observed_freq``
    should be ~0.5 (within ±0.04 to allow for the 12 vs 13 rounding).

    Catches sign errors in the ``<=`` comparison and bin-index off-by-one
    bugs that the structural test would not.
    """
    forecasts = np.arange(100, dtype=float)
    # Alternate observations: even index -> below forecast, odd -> above.
    observations = np.where(
        np.arange(100) % 2 == 0,
        forecasts - 1.0,
        forecasts + 1.0,
    )
    pairs = reliability_curve(forecasts, observations, target_prob=0.5, n_bins=4)
    assert len(pairs) == 4
    for p in pairs:
        assert p["forecast_prob"] == 0.5
        assert abs(p["observed_freq"] - 0.5) < 0.05, (
            f"observed_freq drifted from 0.5: {p['observed_freq']}"
        )
