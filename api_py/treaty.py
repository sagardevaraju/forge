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


# ── Task P3.20 — Captive vehicle (trapped vs free capital) ────────────────
#
# A captive is an insurance subsidiary the parent owns; the central
# state variable is what fraction of the captive's capital sits
# "trapped" against outstanding obligations (loss reserves, fronting
# collateral, unearned premium reserve) vs what's "free" to dividend
# back to parent or redeploy. Trapped capital is non-fungible — it
# cannot be released until the underlying obligation runs off.
#
#   trapped_capital = outstanding_reserves
#                   + collateral_pledged
#                   + unearned_premium_reserve
#
#   free_capital    = total_capital - trapped_capital   (floored at 0)
#   trapped_share   = trapped_capital / total_capital   (0 if total = 0)
#
# Negative input components are clamped at 0 (defensive — the
# precompute + UI validate at write time).


def captive_state(
    total_capital_usd: float,
    outstanding_reserves_usd: float,
    collateral_pledged_usd: float,
    unearned_premium_reserve_usd: float,
) -> dict[str, float]:
    """Derive captive trapped/free capital and the trapped share.

    Returns a dict with keys ``total``, ``trapped``, ``free``,
    ``trapped_share``. All money fields are USD.

    ``trapped_share`` is in ``[0, 1]``; values of 1.0 indicate the
    captive is fully reserved (any new underwriting consumes parent
    capital injection) and warrant an operator-facing risk badge.
    """
    total = max(0.0, float(total_capital_usd))
    reserves = max(0.0, float(outstanding_reserves_usd))
    collateral = max(0.0, float(collateral_pledged_usd))
    upr = max(0.0, float(unearned_premium_reserve_usd))
    trapped = reserves + collateral + upr
    # Free capital is capped at the larger of (total - trapped, 0) — a
    # captive that's over-reserved relative to its capital is in a
    # negative-free state and is reported as 0 free with trapped > total.
    free = max(0.0, total - trapped)
    share = (trapped / total) if total > 0 else 0.0
    if share > 1.0:
        # Cap visible share at 1.0 — over-trapped is clamped for the UI
        # bar but the operator can still see trapped > total in the
        # raw numbers if they look at the data table.
        share = 1.0
    return {
        "total": total,
        "trapped": trapped,
        "free": free,
        "trapped_share": share,
    }


# ── Task P3.21 — ILS / cat-bond layer math (indemnity trigger v1) ─────────
#
# An indemnity-triggered cat-bond behaves like an XS treaty from the
# sponsor's loss-side perspective: the bond covers losses inside
# ``[attachment, exhaustion]`` and the sponsor retains losses outside
# that band. The difference is the counterparty (capital-markets
# investors via an SPV instead of a traditional reinsurer) and the
# capital-markets economics (coupon paid to investors instead of RoL
# paid to a reinsurer). Annual coupon load on the sponsor =
# ``coupon_rate * principal`` where principal ≡ layer width.
#
# v2 trigger variants (industry_loss, parametric, modeled_loss) carry
# basis risk that decouples the sponsor's recovery from their incurred
# loss; out of P3.21 scope per plan.


def retained_ils(loss: float, attachment: float, exhaustion: float) -> float:
    """Sponsor's retained loss under an indemnity-triggered cat-bond.

    Mathematically identical to :func:`retained_xs` — the indemnity
    trigger means the bond pays the sponsor's actual loss inside the
    layer, with no basis risk. Aliased separately so the call site
    documents the counterparty (capital-markets investors via an SPV).
    """
    return retained_xs(loss, attachment, exhaustion)


def ceded_ils(loss: float, attachment: float, exhaustion: float) -> float:
    """Amount paid out of cat-bond principal under an indemnity trigger.

    The complement of :func:`retained_ils`. Equal to
    ``max(0, min(loss, exhaustion) - attachment)``.
    """
    return ceded_xs(loss, attachment, exhaustion)


def ils_annual_coupon(principal: float, coupon_rate: float) -> float:
    """Annual coupon paid by the sponsor to cat-bond investors.

    ``coupon_rate`` is the fraction of principal per annum (e.g.
    0.07 = 700 bps). Clamped at non-negative on both inputs.
    """
    p = max(0.0, principal)
    r = max(0.0, coupon_rate)
    return p * r


# ── Task P3.22 — Reinstatement modeling (per-occurrence capacity) ─────────
#
# A reinstatement clause lets an XS layer be "reset" after a covered
# loss: the reinsurer's capacity is refreshed, the cedant pays a
# reinstatement premium equal to a pro-rata fraction of the original
# premium times a factor (the standard cat-XS convention is
# "100% at 100%" — exhausting the layer costs the full original
# premium again). FORGE surfaces remaining capacity in /treaty as a
# MIP **input** (visible to the operator and to downstream cession-
# sizing logic) NOT as a constraint — per-event capacity bounds are
# not enforced in the precompute solve.
#
# State variables:
#   - initial_capacity = (N + 1) · width    (N reinstatements after the
#                                            initial layer fire)
#   - remaining_capacity = current available capacity after losses
#                          to date


def initial_layer_capacity(
    attachment: float,
    exhaustion: float,
    reinstatements: int,
) -> float:
    """Initial per-occurrence layer capacity, in dollars.

    ``capacity = (reinstatements + 1) · width``. A 2-reinstatement
    $40M xs $20M layer (width $40M) has initial capacity $120M (the
    layer can absorb the full $40M three times). Negative inputs
    clamp at 0.
    """
    width = max(0.0, exhaustion - attachment)
    n = max(0, int(reinstatements))
    return width * (n + 1)


def apply_loss_to_layer(
    loss: float,
    attachment: float,
    exhaustion: float,
    remaining_capacity: float,
) -> tuple[float, float]:
    """Apply a single-event loss to a layer with capped capacity.

    Returns ``(ceded_amount, new_remaining_capacity)``:

    - ``ceded_amount`` is the amount the reinsurer pays — equal to
      :func:`ceded_xs` clipped at the remaining capacity. If the layer
      is exhausted (``remaining_capacity == 0``) before any loss is
      applied, ``ceded_amount = 0``.
    - ``new_remaining_capacity = max(0, remaining_capacity − ceded_amount)``.

    The cedant's retention is *not* returned by this function — the
    portion of the loss that escapes the capacity-capped layer
    (because the layer is exhausted) falls back on the cedant on
    top of the standard XS retention; callers compute that explicitly
    if they need it.
    """
    cap = max(0.0, remaining_capacity)
    raw_ceded = ceded_xs(loss, attachment, exhaustion)
    ceded = min(raw_ceded, cap)
    return ceded, max(0.0, cap - ceded)


def reinstatement_premium(
    loss_paid_in_layer: float,
    layer_width: float,
    original_premium: float,
    reinstatement_factor: float = 1.0,
) -> float:
    """Reinstatement premium owed by the cedant for refreshing the layer.

    The standard cat-XS pricing convention is "100% at 100%": the
    cedant pays the original premium multiplied by the pro-rata
    fraction of the layer that the reinsurer paid out, multiplied
    by the reinstatement factor (typically 1.0).

        reinstatement_premium = (loss_paid_in_layer / layer_width)
                              · original_premium · reinstatement_factor

    Discounted reinstatements (e.g. "100% at 50%") use
    ``reinstatement_factor = 0.5``; free reinstatements use 0.0.
    Inputs are clamped non-negative; a zero or negative ``layer_width``
    returns 0 (degenerate layer).
    """
    width = max(0.0, layer_width)
    if width <= 0.0:
        return 0.0
    paid = max(0.0, loss_paid_in_layer)
    prem = max(0.0, original_premium)
    factor = max(0.0, reinstatement_factor)
    return (paid / width) * prem * factor


__all__ = [
    "retained_xs",
    "ceded_xs",
    "retained_fronting",
    "ceded_fronting",
    "fronting_fee",
    "captive_state",
    "retained_ils",
    "ceded_ils",
    "ils_annual_coupon",
    "initial_layer_capacity",
    "apply_loss_to_layer",
    "reinstatement_premium",
]
