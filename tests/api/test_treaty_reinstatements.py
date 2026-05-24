"""Task P3.22 — reinstatement modeling (per-occurrence capacity).

Pins the math for:
  - initial_layer_capacity(att, exh, N) = (N + 1) · width
  - apply_loss_to_layer(loss, att, exh, remaining) = (ceded, new_remaining)
  - reinstatement_premium(loss_in_layer, width, orig_premium, factor) =
      (loss / width) · orig · factor

These surface in /treaty as MIP inputs (operator-visible) — NOT as
constraints (the precompute MIP does not enforce remaining_capacity as
an upper bound on cession). The plan's trade-off note is the design.
"""

from __future__ import annotations

import pytest

from api_py.treaty import (
    initial_layer_capacity,
    apply_loss_to_layer,
    reinstatement_premium,
)


# ── initial capacity ──────────────────────────────────────────────────────


def test_initial_capacity_with_no_reinstatements():
    """0 reinstatements ⇒ capacity = width (1 fire only)."""
    assert initial_layer_capacity(20_000_000, 60_000_000, 0) == 40_000_000


def test_initial_capacity_with_one_reinstatement():
    """1 reinstatement ⇒ capacity = 2 · width."""
    assert initial_layer_capacity(20_000_000, 60_000_000, 1) == 80_000_000


def test_initial_capacity_with_two_reinstatements():
    """2 reinstatements ⇒ capacity = 3 · width (cat XS standard)."""
    assert initial_layer_capacity(60_000_000, 120_000_000, 2) == 180_000_000


def test_initial_capacity_negative_reinstatements_clamped_to_zero():
    assert initial_layer_capacity(20_000_000, 60_000_000, -5) == 40_000_000


def test_initial_capacity_inverted_layer_returns_zero():
    """Degenerate: exhaustion < attachment ⇒ zero width ⇒ zero capacity."""
    assert initial_layer_capacity(60_000_000, 20_000_000, 2) == 0


# ── apply_loss_to_layer ───────────────────────────────────────────────────


def test_apply_loss_inside_layer_with_full_capacity():
    """First loss fully within capacity — reinsurer pays normally."""
    ceded, remaining = apply_loss_to_layer(
        loss=150_000_000,
        attachment=120_000_000,
        exhaustion=200_000_000,
        remaining_capacity=80_000_000,
    )
    # 150M in [120M, 200M] layer ⇒ 30M ceded; 50M of capacity remains.
    assert ceded == 30_000_000
    assert remaining == 50_000_000


def test_apply_loss_caps_at_remaining_capacity():
    """If the per-event cession would exceed remaining capacity,
    the ceded amount is capped at the remaining capacity."""
    ceded, remaining = apply_loss_to_layer(
        loss=300_000_000,    # busts the layer
        attachment=120_000_000,
        exhaustion=200_000_000,
        remaining_capacity=20_000_000,  # only $20M left
    )
    assert ceded == 20_000_000
    assert remaining == 0


def test_apply_loss_with_zero_remaining_pays_nothing():
    """Exhausted layer ⇒ no cession."""
    ceded, remaining = apply_loss_to_layer(
        loss=150_000_000,
        attachment=120_000_000,
        exhaustion=200_000_000,
        remaining_capacity=0,
    )
    assert ceded == 0
    assert remaining == 0


def test_apply_loss_below_attachment_doesnt_consume_capacity():
    """Loss never reaches the layer — no consumption."""
    ceded, remaining = apply_loss_to_layer(
        loss=50_000_000,
        attachment=120_000_000,
        exhaustion=200_000_000,
        remaining_capacity=80_000_000,
    )
    assert ceded == 0
    assert remaining == 80_000_000


def test_apply_loss_negative_remaining_clamped():
    ceded, remaining = apply_loss_to_layer(150_000_000, 120_000_000, 200_000_000, -50)
    assert ceded == 0
    assert remaining == 0


# ── reinstatement premium ─────────────────────────────────────────────────


def test_reinstatement_premium_100_at_100():
    """Standard cat-XS convention: '100% at 100%' — exhausting the
    layer costs the full original premium again."""
    # $40M loss-in-layer on $40M width ⇒ full reinstatement
    rp = reinstatement_premium(
        loss_paid_in_layer=40_000_000,
        layer_width=40_000_000,
        original_premium=4_000_000,
        reinstatement_factor=1.0,
    )
    assert rp == pytest.approx(4_000_000)


def test_reinstatement_premium_pro_rata():
    """Partial loss → pro-rata reinstatement premium."""
    # $10M of $40M layer consumed (25%) at 100% factor ⇒ 25% of orig premium
    rp = reinstatement_premium(10_000_000, 40_000_000, 4_000_000, 1.0)
    assert rp == pytest.approx(1_000_000)


def test_reinstatement_premium_discounted_factor():
    """100% at 50% (discounted reinstatement) ⇒ half the standard premium."""
    rp = reinstatement_premium(40_000_000, 40_000_000, 4_000_000, 0.5)
    assert rp == pytest.approx(2_000_000)


def test_reinstatement_premium_free_factor():
    """0.0 factor = free reinstatement."""
    assert reinstatement_premium(40_000_000, 40_000_000, 4_000_000, 0.0) == 0.0


def test_reinstatement_premium_zero_width_returns_zero():
    """Degenerate layer width ⇒ no premium (avoids div-by-zero)."""
    assert reinstatement_premium(0, 0, 4_000_000, 1.0) == 0.0


def test_reinstatement_premium_negative_inputs_clamped():
    """All inputs clamped non-negative."""
    assert reinstatement_premium(-1, 40_000_000, 4_000_000, 1.0) == 0.0
    assert reinstatement_premium(40_000_000, 40_000_000, -1, 1.0) == 0.0
    assert reinstatement_premium(40_000_000, 40_000_000, 4_000_000, -1) == 0.0
