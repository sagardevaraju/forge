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


# ── Task P3.19 — Fronting vehicle ─────────────────────────────────────────
#
# A fronting layer represents an arrangement where a licensed-paper
# carrier (the "fronter") issues policies in jurisdictions where the
# actual risk-bearer can't write, and cedes the risk back to a capital
# provider (typically a captive, sidecar, or ILS investor) for a
# fronting fee. The fronter may retain a small residual slice
# (``residual_retention_share``) for regulatory + tail-of-the-tail
# purposes; the cession ``(1 − residual_retention_share)`` flows to
# the capital provider. The fronting fee is a *premium* slice —
# separate from the loss retention — and compensates the fronter for
# rented paper. Typical industry: 3-8% fronting fee, 5-10% residual
# retention.


def _clamp_share(s: float) -> float:
    if s < 0.0:
        return 0.0
    if s > 1.0:
        return 1.0
    return s


def retained_fronting(loss: float, residual_retention_share: float) -> float:
    """Return the fronter's retained loss under a fronting arrangement.

    The fronter keeps ``residual_retention_share · loss``; the rest is
    ceded to the underlying capital provider.

    Parameters
    ----------
    loss
        Inbound loss in dollars (non-negative).
    residual_retention_share
        Fraction in ``[0, 1]`` the fronter retains. 0 = pure conduit
        (allowed in some jurisdictions); 1 = no fronting at all
        (degenerate). Out-of-range inputs are clamped at write time.
    """
    return max(0.0, loss) * _clamp_share(residual_retention_share)


def ceded_fronting(loss: float, residual_retention_share: float) -> float:
    """Return the loss ceded to the capital provider via fronting.

    Complement of :func:`retained_fronting`:
    ``(1 − residual_retention_share) · loss``.
    """
    return max(0.0, loss) * (1.0 - _clamp_share(residual_retention_share))


def fronting_fee(premium: float, fronting_fee_share: float) -> float:
    """Return the fronting fee paid to the fronter (premium slice).

    Distinct from the loss retention — even at 0% loss retention the
    fronter charges this fee for rented paper. Typical industry range:
    3-8% of inbound premium.
    """
    return max(0.0, premium) * _clamp_share(fronting_fee_share)


__all__ = [
    "retained_xs",
    "ceded_xs",
    "retained_fronting",
    "ceded_fronting",
    "fronting_fee",
]
