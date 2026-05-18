"""Task P2.4 — common-factor event-residual loss correlation tests.

A single-factor shared shock ``ε ~ N(0, σ²)`` is multiplied across every
cohort within a scenario.  This is the cheapest defensible step away
from inter-cohort independence and the primary correlation knob in the
Phase 2 stack.  A full Gaussian copula would be the Phase 3 upgrade.
"""

from __future__ import annotations

import numpy as np

from api_py.correlation import apply_common_factor


def test_apply_common_factor_changes_correlation() -> None:
    """Plan-mandated structural test: shared shock raises mean pairwise ρ.

    Note on parameters: the plan listed ``sigma=1`` for the lognormal cohort
    draw, but at that dispersion each cohort's per-scenario CV is ~120% —
    which dwarfs the ``β·σ = 0.15`` shared shock and the induced cross-
    cohort correlation comes in around 0.01, well below the ``+0.1`` bar
    the plan asserts.  We dial cohort σ down to 0.2 (a realistic per-event
    cohort dispersion) so the +0.1 threshold faithfully detects the
    shared-shock signal the test was written to detect.
    """
    rng = np.random.default_rng(0)
    cohort_losses = rng.lognormal(mean=10, sigma=0.2, size=(100, 50))  # 100 scenarios, 50 cohorts
    correlated = apply_common_factor(cohort_losses, beta=0.5, sigma=0.3, seed=0)
    # Average pairwise correlation should be materially higher after the transform.
    rho_pre = np.corrcoef(cohort_losses.T).mean()
    rho_post = np.corrcoef(correlated.T).mean()
    assert rho_post > rho_pre + 0.1


def test_apply_common_factor_is_deterministic() -> None:
    """Same inputs + seed must yield bit-identical outputs."""
    rng = np.random.default_rng(42)
    losses = rng.lognormal(mean=9, sigma=0.5, size=(50, 20))
    out_a = apply_common_factor(losses, beta=0.4, sigma=0.25, seed=7)
    out_b = apply_common_factor(losses, beta=0.4, sigma=0.25, seed=7)
    np.testing.assert_array_equal(out_a, out_b)


def test_apply_common_factor_no_op_when_beta_zero() -> None:
    """β=0 collapses the multiplier to 1.0 and must leave losses untouched."""
    rng = np.random.default_rng(1)
    losses = rng.lognormal(mean=8, sigma=0.7, size=(30, 15))
    out = apply_common_factor(losses, beta=0.0, sigma=0.3, seed=0)
    np.testing.assert_allclose(out, losses, rtol=0, atol=1e-12)


def test_apply_common_factor_epsilon_is_centered() -> None:
    """ε is mean-zero, so the multiplier vector must straddle 1.0 (both >1 and <1)."""
    rng = np.random.default_rng(0)
    losses = rng.lognormal(mean=10, sigma=1, size=(200, 10))
    correlated = apply_common_factor(losses, beta=0.5, sigma=0.3, seed=0)
    # Implied multiplier per scenario: ratio of correlated/original (any cohort, since
    # all share the same scalar).  Use the first cohort.
    multiplier = correlated[:, 0] / losses[:, 0]
    assert (multiplier > 1.0).any(), "expected at least one ε > 0 (inflation)"
    assert (multiplier < 1.0).any(), "expected at least one ε < 0 (deflation)"


def test_generate_scenarios_threads_correlation_metadata() -> None:
    """generate_scenarios should accept a correlation kwarg and surface it."""
    from ml.scenarios.generate import generate_scenarios

    correlation = {"beta": 0.5, "sigma": 0.3}
    scs = generate_scenarios(storm_id="AL092024", n=4, correlation=correlation)
    assert len(scs) == 4
    for s in scs:
        assert s.get("correlation") == correlation
