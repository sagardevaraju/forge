"""Task P2.1 — unit tests for the continuous-CRPS calibration utility.

CRPS (Continuous Ranked Probability Score) is the actuary-grade calibration
metric for quantile forecasts. The closed form for a N(0,1) forecast at
``y=0`` is ``2/sqrt(2*pi) - 1/sqrt(pi)`` which numerically evaluates to
≈ 0.2337 (matching the 0.234 tolerance below). We sample that distribution
at the (p10, p50, p90) heads our XGBoost models emit and verify the
spline-from-quantiles integrand recovers the analytical value within a
generous tolerance.
"""

from __future__ import annotations

from api_py.calibration import crps_from_quantiles


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
