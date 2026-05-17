"""Task P2.7 — Excess-of-loss (XS) treaty layer math.

Standard reinsurance conventions:

- An XS treaty layer is described by a pair ``(attachment, exhaustion)``
  in *dollar* terms (sometimes quoted as ``"X xs A"`` meaning "X dollars
  of cover in excess of A attachment"; i.e. attachment = A, exhaustion
  = A + X).
- For a single-event loss ``L``, the reinsurer pays
  ``max(0, min(L, exhaustion) - attachment)`` — i.e. the slice of ``L``
  that falls inside the layer ``[attachment, exhaustion]``.
- The cedant *retains* everything outside that slice: the piece below
  the attachment (where the treaty hasn't kicked in) plus the piece
  above the exhaustion (where the layer is busted).

This module exposes the cedant's retained-loss function, which is what
the Portfolio MIP needs for its capital constraint when ``cede_xs`` is
the chosen action. Before P2.7, the MIP zeroed the ``cede_xs``
retained tail outright — a mock-grade shortcut that overstated the
benefit of XS cession. P2.7 replaces that zero with the honest
retained-tail math here so the capital constraint is no longer a lie.

Notes on what is *not* modeled here:

- **Reinstatements**: P3.22 will add per-treaty reinstatement counts +
  premiums. Until then the layer is single-shot.
- **Aggregate vs per-occurrence**: this is a per-event function. An
  aggregate-XS treaty would need a running total — currently out of
  scope.
- **QS treaties**: handled inline in ``optimize_portfolio.py`` as a
  flat 50% factor on loss and premium. Not in this module.
"""

from __future__ import annotations


def retained_xs(loss: float, attachment: float, exhaustion: float) -> float:
    """Return the cedant's retained loss under an XS treaty.

    Parameters
    ----------
    loss
        Single-event loss in dollars (non-negative).
    attachment
        Treaty attachment in dollars — the cedant pays everything below
        this point out of pocket.
    exhaustion
        Treaty exhaustion in dollars — once the loss exceeds this, the
        layer is exhausted and the cedant pays the bust.

    Returns
    -------
    float
        The cedant's retained loss = below-attachment piece +
        above-exhaustion piece. The reinsurer covers
        ``loss - retained_xs(loss, attachment, exhaustion)``.

    Notes
    -----
    Degenerate ``attachment == exhaustion`` is supported: the layer has
    zero width, the reinsurer covers nothing, and the cedant retains
    the full loss. No division — the formula is purely
    ``min`` / ``max`` / addition.
    """
    below = min(loss, attachment)
    above = max(0.0, loss - exhaustion)
    return below + above


def ceded_xs(loss: float, attachment: float, exhaustion: float) -> float:
    """Return the reinsurer's paid loss under an XS treaty.

    The complement of :func:`retained_xs` — equal to
    ``max(0, min(loss, exhaustion) - attachment)``. Useful when
    reasoning about XS layer width / utilization (e.g. for the P2.17
    treaty configurator). Not required by the P2.7 MIP path.
    """
    return max(0.0, min(loss, exhaustion) - attachment)
