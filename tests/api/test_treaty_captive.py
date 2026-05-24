"""Task P3.20 — captive vehicle trapped vs free capital.

Pins ``captive_state(total, reserves, collateral, upr)`` math.
"""

from __future__ import annotations

import pytest

from api_py.treaty import captive_state


def test_captive_state_typical_5pct_free():
    """Industry-typical captive: 60% reserves, 25% collateral, 10% UPR,
    5% free."""
    s = captive_state(
        total_capital_usd=100_000_000,
        outstanding_reserves_usd=60_000_000,
        collateral_pledged_usd=25_000_000,
        unearned_premium_reserve_usd=10_000_000,
    )
    assert s["total"] == 100_000_000
    assert s["trapped"] == 95_000_000
    assert s["free"] == 5_000_000
    assert s["trapped_share"] == pytest.approx(0.95)


def test_captive_state_fully_unconstrained():
    """No reserves / no collateral / no UPR ⇒ everything is free."""
    s = captive_state(100, 0, 0, 0)
    assert s["total"] == 100
    assert s["trapped"] == 0
    assert s["free"] == 100
    assert s["trapped_share"] == 0.0


def test_captive_state_over_reserved():
    """Trapped > total: free = 0; share capped at 1.0."""
    s = captive_state(
        total_capital_usd=100,
        outstanding_reserves_usd=80,
        collateral_pledged_usd=30,
        unearned_premium_reserve_usd=10,
    )
    assert s["trapped"] == 120
    assert s["free"] == 0  # cannot be negative
    assert s["trapped_share"] == 1.0  # capped


def test_captive_state_zero_total_is_safe():
    """Empty captive: no division-by-zero; everything 0."""
    s = captive_state(0, 0, 0, 0)
    assert s["total"] == 0
    assert s["trapped_share"] == 0.0
    assert s["free"] == 0
    assert s["trapped"] == 0


def test_captive_state_negative_inputs_clipped():
    """Negative components clipped at 0 — defensive."""
    s = captive_state(100, -50, -10, -5)
    assert s["trapped"] == 0
    assert s["free"] == 100
    assert s["trapped_share"] == 0.0


def test_captive_state_components_sum_to_trapped():
    """trapped = reserves + collateral + upr (after clipping)."""
    reserves, collateral, upr = 12.5, 7.0, 2.5
    s = captive_state(100, reserves, collateral, upr)
    assert s["trapped"] == pytest.approx(reserves + collateral + upr)
    assert s["free"] == pytest.approx(100 - s["trapped"])
