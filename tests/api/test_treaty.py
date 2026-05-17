"""Task P2.7 — unit tests for the XS treaty layer math.

The ``retained_xs(loss, attachment, exhaustion)`` function answers a single
question: under an excess-of-loss reinsurance treaty whose layer is
[attachment, exhaustion], how much of a single-event loss does the insurer
*retain* (i.e. pay out of pocket)?

The cedant retains:
- everything below the attachment (the treaty hasn't kicked in),
- nothing inside the layer (the reinsurer pays),
- everything above the exhaustion (the layer is busted).

These tests pin down the contract for that function at every interesting
boundary so a future refactor (e.g. P3.22 reinstatements, P2.17 per-cohort
treaty config) doesn't silently drift.
"""

from __future__ import annotations

from api_py.treaty import retained_xs


def test_retained_loss_xs_layer() -> None:
    """Plan-verbatim case: 250k loss, 100k attachment, 200k exhaustion.

    The insurer retains 100k below the attachment plus 50k above the
    exhaustion = 150k total. The 100k layer in between is the reinsurer's
    problem.
    """
    L = 250_000
    attachment = 100_000
    exhaustion = 200_000
    assert retained_xs(L, attachment, exhaustion) == 100_000 + 50_000


def test_retained_loss_below_attachment() -> None:
    """Loss never reaches the treaty layer — the insurer retains all of it."""
    assert retained_xs(50_000, 100_000, 200_000) == 50_000


def test_retained_loss_inside_layer() -> None:
    """Loss is inside the layer — insurer retains only the attachment.

    The reinsurer covers the loss above the attachment up to the exhaustion;
    here the loss never reaches the exhaustion so there's no above-exhaustion
    piece.
    """
    assert retained_xs(150_000, 100_000, 200_000) == 100_000


def test_retained_loss_above_exhaustion() -> None:
    """Loss busts the layer — insurer retains the attachment plus the bust.

    100k below + 100k above (300k - 200k exhaustion) = 200k retained.
    """
    assert retained_xs(300_000, 100_000, 200_000) == 200_000


def test_retained_loss_exactly_at_attachment() -> None:
    """Edge: loss exactly equals the attachment — all retained."""
    assert retained_xs(100_000, 100_000, 200_000) == 100_000


def test_retained_loss_exactly_at_exhaustion() -> None:
    """Edge: loss exactly equals the exhaustion.

    100k below (the attachment) + 0 above (loss - exhaustion = 0) = 100k.
    The reinsurer paid out the full 100k layer; no bust.
    """
    assert retained_xs(200_000, 100_000, 200_000) == 100_000


def test_retained_loss_degenerate_zero_width_layer() -> None:
    """Degenerate: attachment == exhaustion (zero-width layer).

    No cession happens — the reinsurer covers ``[att, att] = {att}`` which
    is a measure-zero interval. The insurer retains the entire loss:
    150k = 100k below + 50k above (loss - att).

    Verifies the function doesn't divide by ``(exhaustion - attachment)``
    or otherwise blow up on a degenerate layer.
    """
    assert retained_xs(150_000, 100_000, 100_000) == 150_000
