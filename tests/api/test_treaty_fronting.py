"""Task P3.19 — fronting vehicle math.

Pins the contract for ``retained_fronting`` / ``ceded_fronting`` /
``fronting_fee``. The fronter keeps ``residual_retention_share · loss``
and cedes the rest to the underlying capital provider; the fronting fee
is a *premium* slice, separate from the loss retention.
"""

from __future__ import annotations

import pytest

from api_py.treaty import retained_fronting, ceded_fronting, fronting_fee


# ── retained / ceded loss split ────────────────────────────────────────────


def test_retained_plus_ceded_equals_loss():
    """retained + ceded = loss for any valid share."""
    L = 1_000_000
    for share in (0.0, 0.05, 0.10, 0.50, 0.95, 1.0):
        assert abs(retained_fronting(L, share) + ceded_fronting(L, share) - L) < 1e-9


def test_retained_at_typical_industry_share():
    """5% residual is a typical industry default (Aon Reinsurance Market
    Outlook 2024 §4.3 — fronting fees typically 3-8%, residual loss
    retention 5-10%)."""
    assert retained_fronting(1_000_000, 0.05) == pytest.approx(50_000)
    assert ceded_fronting(1_000_000, 0.05) == pytest.approx(950_000)


def test_retained_zero_share_is_pure_passthrough():
    """A 0% residual share is a pure-conduit arrangement (allowed in
    some jurisdictions for protected-cell captives)."""
    assert retained_fronting(1_000_000, 0.0) == 0.0
    assert ceded_fronting(1_000_000, 0.0) == 1_000_000


def test_retained_full_share_is_no_fronting():
    """A 100% residual share = no fronting at all (degenerate)."""
    assert retained_fronting(1_000_000, 1.0) == 1_000_000
    assert ceded_fronting(1_000_000, 1.0) == 0.0


def test_negative_loss_is_clipped_to_zero():
    """Negative inputs are clipped — the fronter doesn't `pay back`
    a negative loss."""
    assert retained_fronting(-100_000, 0.05) == 0.0
    assert ceded_fronting(-100_000, 0.05) == 0.0


@pytest.mark.parametrize("share", [-0.1, -1.0, 1.1, 2.0])
def test_out_of_range_share_is_clamped(share):
    """Out-of-range shares are clamped to [0, 1] rather than raising —
    the precompute + UI validate at write time so the hot math path
    stays dependency-free."""
    L = 100_000
    r = retained_fronting(L, share)
    c = ceded_fronting(L, share)
    assert 0.0 <= r <= L
    assert 0.0 <= c <= L
    assert abs(r + c - L) < 1e-9


# ── fronting fee (premium slice) ───────────────────────────────────────────


def test_fronting_fee_at_typical_industry_rate():
    """6% fee on $10M premium = $600k."""
    assert fronting_fee(10_000_000, 0.06) == pytest.approx(600_000)


def test_fronting_fee_zero_premium():
    assert fronting_fee(0, 0.06) == 0.0


def test_fronting_fee_negative_premium_clipped():
    assert fronting_fee(-100_000, 0.06) == 0.0


@pytest.mark.parametrize("share", [-0.1, 1.1])
def test_fronting_fee_share_clamped(share):
    P = 1_000_000
    fee = fronting_fee(P, share)
    assert 0.0 <= fee <= P


# ── interaction: fee + loss retention are independent ─────────────────────


def test_fee_and_retention_are_independent():
    """A 0% loss retention can still carry a non-zero fronting fee —
    the fronter is paid for paper regardless of loss share."""
    assert retained_fronting(1_000_000, 0.0) == 0.0
    assert fronting_fee(10_000_000, 0.06) == pytest.approx(600_000)
