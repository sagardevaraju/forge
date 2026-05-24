"""Task P3.21 — ILS / cat-bond layer math (indemnity trigger v1).

Indemnity-triggered cat-bonds behave like XS treaties on the loss side
(sponsor retains everything outside the layer, bond principal pays
losses inside the layer); the difference is the counterparty
(capital-markets investors via an SPV) + capital-markets economics
(coupon paid to investors instead of RoL).
"""

from __future__ import annotations

import pytest

from api_py.treaty import (
    retained_ils,
    ceded_ils,
    retained_xs,
    ils_annual_coupon,
)


def test_indemnity_ils_matches_xs_math():
    """Indemnity trigger ⇒ no basis risk ⇒ identical math to XS."""
    L = 150_000_000
    att = 120_000_000
    exh = 200_000_000
    assert retained_ils(L, att, exh) == retained_xs(L, att, exh)


def test_indemnity_ils_loss_below_attachment_unchanged():
    """Loss never reaches the cat-bond layer."""
    assert retained_ils(50_000_000, 120_000_000, 200_000_000) == 50_000_000
    assert ceded_ils(50_000_000, 120_000_000, 200_000_000) == 0


def test_indemnity_ils_loss_inside_layer():
    """Bond pays the slice above attachment."""
    # 150M loss in [120M, 200M] layer ⇒ bond pays 30M.
    assert ceded_ils(150_000_000, 120_000_000, 200_000_000) == 30_000_000
    assert retained_ils(150_000_000, 120_000_000, 200_000_000) == 120_000_000


def test_indemnity_ils_layer_busted():
    """250M loss ⇒ bond pays full layer (80M); sponsor eats the bust."""
    assert ceded_ils(250_000_000, 120_000_000, 200_000_000) == 80_000_000
    assert retained_ils(250_000_000, 120_000_000, 200_000_000) == 170_000_000


def test_ils_annual_coupon_at_industry_rate():
    """Artemis Q4-2024 multi-peril US wind/quake median ROL ≈ 8.5%."""
    # $80M principal at 8.5% coupon = $6.8M/yr.
    assert ils_annual_coupon(80_000_000, 0.085) == pytest.approx(6_800_000)


def test_ils_annual_coupon_zero_principal():
    assert ils_annual_coupon(0, 0.085) == 0.0


def test_ils_annual_coupon_negative_inputs_clamped():
    assert ils_annual_coupon(-1_000_000, 0.085) == 0.0
    assert ils_annual_coupon(80_000_000, -0.05) == 0.0
