"""Pins for the capital-budget anchor selection in
``scripts/precompute_portfolio_optimization.py``.

Background — 2026-05-25 audit on PR #68: the precompute previously
anchored capital_budget on Σ per-cohort p99 even when
``risk_measure='tvar_99'`` was the constraint LHS. After ~190 promoted
sims, Σ p99 shrank by ~40 % (zero-loss dilution of the per-cohort
empirical 99th-percentile rank) while Σ TVaR-99 grew, producing
mechanical infeasibility on every re-optimize. The fix anchors on the
matching measure under each path and floors at the prior-only Σ p99
so the budget can only grow with merged sims, never shrink.

These tests pin the helper's contract directly so a future refactor
of the budget formula can't silently drift the anchor back.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from scripts.precompute_portfolio_optimization import (
    CAPITAL_BUDGET_FRACTION,
    _compute_capital_budget_anchor,
)


# ── helpers ──────────────────────────────────────────────────────────────


def _lognormal_cohort(
    cid: str,
    *,
    loss_p50: float,
    sigma: float = 0.85,
    K: int = 1000,
    seed: int = 0,
) -> dict[str, Any]:
    """Synthesise a cohort with K lognormal scenarios whose median is
    ``loss_p50``. Mirrors the precompute pipeline's prior. Deterministic
    via ``seed`` so the tests are reproducible."""
    rng = np.random.default_rng(seed)
    mu = float(np.log(loss_p50))
    scenarios = rng.lognormal(mean=mu, sigma=sigma, size=K).tolist()
    return {
        "id": cid,
        "loss_p50": loss_p50,
        "loss_p99": float(np.percentile(scenarios, 99)),
        "loss_scenarios": scenarios,
    }


def _merge_zero_loss_sims(cohort: dict[str, Any], n_sims: int) -> dict[str, Any]:
    """Append ``n_sims × 1000`` zero-loss scenarios to a cohort's
    distribution — emulates the dilution effect of merging sims that
    are OUTSIDE that cohort's footprint (which is what the median
    cohort sees in a real 190-sim merge).

    Carries the pre-merge ``loss_p99`` scalar field forward unchanged
    — that's the contract the real precompute pipeline maintains
    (the field is set at cohort-aggregation time from the lognormal
    prior, then sim losses get concatenated into ``loss_scenarios``
    without touching the scalar fields). The new anchor helper reads
    ``loss_p99`` as the prior-baseline floor."""
    out = dict(cohort)
    out["loss_scenarios"] = list(cohort["loss_scenarios"]) + [0.0] * (n_sims * 1000)
    # Preserve the pre-merge loss_p99 explicitly so callers don't need
    # to remember to set it — emulates what the precompute does.
    if "loss_p99" not in out:
        out["loss_p99"] = float(np.percentile(cohort["loss_scenarios"], 99))
    return out


def _merge_catastrophic_sims(
    cohort: dict[str, Any],
    n_sims: int,
    *,
    sim_loss: float,
    seed: int = 1,
) -> dict[str, Any]:
    """Append ``n_sims × 1000`` scenarios where each sim contributes
    a constant cat loss to this cohort — emulates the cohort being
    INSIDE every sim's footprint."""
    rng = np.random.default_rng(seed)
    out = dict(cohort)
    new = []
    for _ in range(n_sims):
        # K=1000 draws per sim — each draw a noisy version of sim_loss
        # so the tail isn't degenerate.
        new.extend(rng.normal(loc=sim_loss, scale=sim_loss * 0.05, size=1000).tolist())
    out["loss_scenarios"] = list(cohort["loss_scenarios"]) + new
    return out


# ── contract: result shape ───────────────────────────────────────────────


def test_anchor_helper_returns_documented_keys() -> None:
    """The helper's return dict is the single source of truth for the
    artifact's ``budgets.capital_budget_anchor`` field — pin the
    keys so a renderer downstream can rely on the contract."""
    cohorts = [_lognormal_cohort("c0", loss_p50=10_000, seed=0)]
    out = _compute_capital_budget_anchor(cohorts, sim_ids=[])
    assert set(out) == {
        "anchor_value",
        "measure",
        "label",
        "capital_budget",
        "sum_cohort_p99",
        "sum_cohort_tvar99",
        "sum_pre_merge_p99",
    }


def test_capital_budget_fraction_is_documented_policy() -> None:
    """The 40 % retention fraction is policy, not magic. If anyone
    changes it, this test fails and forces them to update research.md
    + the actuarial-calibration documentation."""
    assert CAPITAL_BUDGET_FRACTION == 0.40


# ── prior-only path: backward compat with v0.2.1 ─────────────────────────


def test_prior_only_path_anchors_on_p99() -> None:
    """No sims merged → solver runs under ``risk_measure='var_99'`` →
    the constraint LHS is Σ p99, so the budget RHS must also use Σ p99
    (anything else would be a measure mismatch). This matches v0.2.1
    behaviour bit-for-bit and is the no-regression pin."""
    cohorts = [
        _lognormal_cohort("c0", loss_p50=10_000, seed=0),
        _lognormal_cohort("c1", loss_p50=20_000, seed=1),
        _lognormal_cohort("c2", loss_p50=5_000, seed=2),
    ]
    out = _compute_capital_budget_anchor(cohorts, sim_ids=[])
    assert out["measure"] == "sum_cohort_p99"
    assert out["anchor_value"] == out["sum_cohort_p99"]
    # Capital budget = 40 % × Σ p99 (the historical formula).
    assert out["capital_budget"] == out["sum_cohort_p99"] * 0.40
    assert "risk_measure='var_99'" in out["label"]


def test_prior_only_path_falls_back_to_loss_p99_field_when_no_scenarios() -> None:
    """A cohort dict with no ``loss_scenarios`` (legacy or DB-fresh)
    falls back to the scalar ``loss_p99`` field. Same behaviour the
    monolithic solver has under ``risk_measure='var_99'``."""
    cohorts = [
        {"id": "c0", "loss_p50": 5_000, "loss_p99": 50_000},
        {"id": "c1", "loss_p50": 6_000, "loss_p99": 60_000},
    ]
    out = _compute_capital_budget_anchor(cohorts, sim_ids=[])
    assert out["sum_cohort_p99"] == 110_000
    assert out["anchor_value"] == 110_000
    assert out["capital_budget"] == 110_000 * 0.40


# ── merged-sims path: the bug fix ────────────────────────────────────────


def test_merged_sims_path_anchors_on_tvar_99() -> None:
    """With sims merged the solver switches to ``risk_measure='tvar_99'``
    so the anchor must switch to Σ TVaR-99 to stay self-consistent.
    Headline pin for the 2026-05-25 audit fix."""
    cohorts = [
        _lognormal_cohort("c0", loss_p50=10_000, seed=0),
        _lognormal_cohort("c1", loss_p50=20_000, seed=1),
    ]
    out = _compute_capital_budget_anchor(
        cohorts, sim_ids=["sim_1", "sim_2"],
    )
    assert out["measure"] == "sum_cohort_tvar_99"
    # TVaR-99 ≥ p99 always (TVaR is the mean of the top 1 %, p99 the
    # lower bound of that tail), so the anchor — given the floor —
    # equals Σ TVaR-99 here.
    assert out["anchor_value"] == out["sum_cohort_tvar99"]
    assert out["anchor_value"] >= out["sum_cohort_p99"]
    assert "risk_measure='tvar_99'" in out["label"]


def test_merged_sims_path_floors_at_sum_p99() -> None:
    """Edge case: if the merged sims somehow produce a Σ TVaR-99
    *smaller* than the lognormal prior's Σ p99 (e.g., a hypothetical
    set of sims that are universally below the prior tail), the
    anchor must floor at Σ p99 so the budget never shrinks below the
    prior-only baseline. This is the 'never let sims tighten the
    budget' guarantee."""
    # Build a cohort where the lognormal p99 is large but the merged
    # 'sims' are all zeros — pathological case that pre-fix would let
    # Σ TVaR-99 drop below Σ p99 (zero dilution pulling the rank).
    base = _lognormal_cohort("c0", loss_p50=10_000, seed=0)
    diluted = _merge_zero_loss_sims(base, n_sims=100)
    out = _compute_capital_budget_anchor(
        [diluted], sim_ids=["sim_" + str(i) for i in range(100)],
    )
    assert out["measure"] == "sum_cohort_tvar_99"
    # Anchor floors at the (un-diluted) Σ p99 from the cohort's loss
    # distribution — see the helper's docstring for why.
    assert out["anchor_value"] >= out["sum_cohort_p99"]


def test_zero_dilution_reproduces_the_2026_05_25_bug_under_old_formula() -> None:
    """Reproduces the empirical observation from the audit: appending
    many zero-loss 'sim' draws to a cohort's distribution DRAGS its
    Σ p99 down (the same lognormal tail values now sit at a lower
    percentile rank in the bigger distribution).

    The fix's three-tier anchor (post-TVaR / post-p99 / pre-merge-p99)
    is robust to this — even in the pathological case where both
    post-merge measures collapse under extreme zero dilution, the
    pre-merge-p99 floor anchors the budget at the no-sims baseline.

    This is the test that would have caught the bug pre-shipping.
    """
    base = _lognormal_cohort("c0", loss_p50=10_000, seed=42)
    # 188 sims that contribute zero to this cohort — matches the
    # actual book observation (~99 % zero-loss merged scenarios).
    # The single-cohort/full-dilution case is intentionally
    # pathological so the pre-merge floor has to do the work.
    diluted = _merge_zero_loss_sims(base, n_sims=188)
    # Carry the pre-merge `loss_p99` field forward; the helper reads
    # it as the floor anchor (the same way the precompute pipeline
    # leaves it on the cohort dict — `loss_p99` is set at cohort-
    # aggregation time, never overwritten by sim merging).
    diluted["loss_p99"] = base["loss_p99"]

    pre_merge = _compute_capital_budget_anchor([base], sim_ids=[])
    post_merge_old_formula = pre_merge[
        "sum_cohort_p99"
    ]  # the v0.2.1 anchor formula
    post_merge_new_formula = _compute_capital_budget_anchor(
        [diluted], sim_ids=["s%d" % i for i in range(188)]
    )

    # Post-merge Σ p99 shrinks below the pre-merge value (the bug we
    # were chasing).
    p99_post = float(np.percentile(diluted["loss_scenarios"], 99))
    assert p99_post < pre_merge["sum_cohort_p99"], (
        "expected zero-dilution to DRAG Σ p99 down, but it didn't — "
        "the audit's hypothesis may be invalid or the lognormal seed "
        "produced an atypical sample"
    )
    # The new formula (with the pre-merge-p99 floor) protects against
    # this — post-merge anchor ≥ pre-merge anchor.
    assert post_merge_new_formula["anchor_value"] >= post_merge_old_formula, (
        f"new anchor {post_merge_new_formula['anchor_value']:,.2f} "
        f"falls below the pre-merge baseline "
        f"{post_merge_old_formula:,.2f} — the floor isn't working"
    )


def test_cat_y_sims_grow_the_budget_under_new_anchor() -> None:
    """Positive case: when merged sims add catastrophic loss to a
    cohort, the TVaR-99 anchor GROWS — exactly the behaviour the
    actuary expects ('more cat exposure → bigger required capital')."""
    base = _lognormal_cohort("c0", loss_p50=10_000, seed=0)
    cat_y = _merge_catastrophic_sims(base, n_sims=10, sim_loss=500_000, seed=1)

    no_sims = _compute_capital_budget_anchor([base], sim_ids=[])
    with_sims = _compute_capital_budget_anchor(
        [cat_y], sim_ids=["s%d" % i for i in range(10)]
    )
    assert with_sims["anchor_value"] > no_sims["anchor_value"], (
        f"cat-y merged sims should grow the anchor — got "
        f"with_sims={with_sims['anchor_value']:,.0f} vs "
        f"no_sims={no_sims['anchor_value']:,.0f}"
    )


# ── monotonicity (the property the old comment claimed and broke) ────────


def test_anchor_is_monotonic_non_decreasing_in_merged_sims() -> None:
    """Property: adding more sims to an already-merged book can never
    SHRINK the capital_budget anchor under the new formula. The old
    formula violated this — adding 188 mostly-zero sims dropped the
    anchor by ~40 %.

    Sweep across 0, 10, 50, 188 zero-loss merges + verify the anchor
    is non-decreasing.
    """
    base = _lognormal_cohort("c0", loss_p50=10_000, seed=7)
    sweeps = [0, 10, 50, 188]
    anchors = []
    for n in sweeps:
        c = _merge_zero_loss_sims(base, n_sims=n) if n > 0 else base
        sim_ids = ["s%d" % i for i in range(n)]
        out = _compute_capital_budget_anchor([c], sim_ids=sim_ids)
        anchors.append(out["anchor_value"])
    # Strict non-decreasing.
    for a, b in zip(anchors, anchors[1:]):
        assert b >= a, (
            f"anchor is non-monotonic in merged sim count: "
            f"{list(zip(sweeps, anchors))}"
        )


# ── precondition: TVaR-99 ≥ p99 always (coherent risk) ───────────────────


def test_tvar99_is_always_at_least_p99_on_well_formed_scenarios() -> None:
    """Sanity check: TVaR-99 (mean of the top 1 %) is always ≥ p99
    (lower bound of the same tail) for any non-degenerate
    distribution. The helper's output should reflect that."""
    cohorts = [_lognormal_cohort(f"c{i}", loss_p50=10_000 * (i + 1), seed=i) for i in range(5)]
    out = _compute_capital_budget_anchor(cohorts, sim_ids=["s1"])
    assert out["sum_cohort_tvar99"] >= out["sum_cohort_p99"]


def test_anchor_value_is_finite_and_positive() -> None:
    """Defensive — the precompute writes ``capital_budget`` into a JSON
    artifact; a NaN/inf would propagate into the UI and break the
    serializer. Pin that the helper never emits those values."""
    cohorts = [_lognormal_cohort("c0", loss_p50=1_000_000, seed=11)]
    out = _compute_capital_budget_anchor(cohorts, sim_ids=[])
    assert math.isfinite(out["anchor_value"])
    assert out["anchor_value"] > 0
    assert math.isfinite(out["capital_budget"])
    assert out["capital_budget"] > 0
