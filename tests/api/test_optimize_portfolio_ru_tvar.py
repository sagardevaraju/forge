"""Rockafellar-Uryasev joint book TVaR-99 path (opt-in).

The default ``tvar_aggregation='per_cohort_sum'`` sums each cohort's
own TVaR-99 — the conservative upper bound used by every committed
artifact through v0.2.1. The new ``'rockafellar_uryasev'`` value
switches to the exact joint book TVaR-99 via the auxiliary-variable
formulation of Rockafellar & Uryasev (2000): for K equiprobable
scenarios, ``CVaR_α(L) = min_{η, z} {η + (1/(K·(1−α)))·Σ_s z_s}``
subject to ``z_s ≥ L_s − η`` and ``z_s ≥ 0``.

Pins:
- API surface — ``TVAR_AGGREGATIONS`` whitelist, default
  ``per_cohort_sum`` (backward-compatible), R-U requires
  ``risk_measure='tvar_99'``, R-U requires per-cohort
  ``loss_scenarios``, R-U validates K consistency across cohorts.
- Default-path stability — without ``tvar_aggregation`` specified
  every prior solve produces the same result (no surprise drift in
  the committed v0.2.1 artifact pipeline).
- Subadditivity — R-U joint book TVaR ≤ per-cohort-sum TVaR by
  coherent-risk subadditivity. Pinned on a hand-built toy and on the
  live 570-cohort book.
- Result-shape contract — R-U solves carry
  ``tvar_aggregation_used='rockafellar_uryasev'`` and
  ``tvar_99_per_cohort`` (computed on demand under R-U since the
  cluster precompute is bypassed).
- CG dispatches R-U straight to its LP-master path with
  ``solver_mode='column_generation_lp_master_ru'`` — the cluster
  decomposition doesn't apply when scenarios couple across cohorts.

Reference: Rockafellar, R. T. & Uryasev, S. (2000). "Optimization of
conditional value-at-risk." *Journal of Risk* 2(3): 21–41 — eqn. (15)
is the auxiliary-variable formulation this module implements as
linear constraints in the portfolio MIP.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from api_py.optimize_portfolio import (
    TVAR_AGGREGATIONS,
    _build_problem,
    solve,
)
from api_py.optimize_portfolio_cg import solve_cg


# ── API surface ──────────────────────────────────────────────────────────


def test_tvar_aggregations_constant_lists_both_modes() -> None:
    """Single source of truth for the aggregation whitelist. If a
    third aggregation lands, this test reminds us to thread it
    through every validator + result-shape path."""
    assert TVAR_AGGREGATIONS == ("per_cohort_sum", "rockafellar_uryasev")


def test_build_problem_rejects_unknown_tvar_aggregation() -> None:
    cohort = {
        "id": "335_wood_frame_q0",
        "total_tiv": 1e6,
        "total_premium": 1e4,
        "loss_p50": 5_000,
        "loss_p99": 50_000,
    }
    with pytest.raises(ValueError, match="unknown tvar_aggregation"):
        _build_problem(
            cohorts=[cohort],
            capital_budget=1e8,
            max_nonrenew_pct=0.1,
            cession_budget=1e6,
            risk_measure="tvar_99",
            binary=True,
            tvar_aggregation="median_excess",  # not in the whitelist
        )


def test_build_problem_rejects_ru_with_var_99() -> None:
    """R-U is a TVaR aggregation, not a separate risk measure.
    Mixing it with ``risk_measure='var_99'`` is a contradiction —
    surface it loudly."""
    cohort = {
        "id": "335_wood_frame_q0",
        "total_tiv": 1e6,
        "total_premium": 1e4,
        "loss_p50": 5_000,
        "loss_p99": 50_000,
    }
    with pytest.raises(ValueError, match="requires risk_measure='tvar_99'"):
        _build_problem(
            cohorts=[cohort],
            capital_budget=1e8,
            max_nonrenew_pct=0.1,
            cession_budget=1e6,
            risk_measure="var_99",
            binary=True,
            tvar_aggregation="rockafellar_uryasev",
        )


def test_build_problem_ru_requires_loss_scenarios_on_every_cohort() -> None:
    """R-U has no graceful loss_p99 fallback — switching aggregation
    should fail fast rather than silently degrade. The per_cohort_sum
    path remains the answer for scenarios-missing books."""
    cohorts = [
        {
            "id": "335_wood_frame_q0",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 5_000,
            "loss_p99": 50_000,
            "loss_scenarios": [10.0, 20.0, 30.0],
        },
        {
            "id": "335_wood_frame_q1",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 6_000,
            "loss_p99": 60_000,
            # No loss_scenarios — should raise under R-U.
        },
    ]
    with pytest.raises(ValueError, match="loss_scenarios"):
        _build_problem(
            cohorts=cohorts,
            capital_budget=1e8,
            max_nonrenew_pct=0.1,
            cession_budget=1e6,
            risk_measure="tvar_99",
            binary=True,
            tvar_aggregation="rockafellar_uryasev",
        )


def test_build_problem_ru_requires_consistent_K_across_cohorts() -> None:
    """The R-U linking constraints index by scenario s ∈ {0, ..., K-1}
    — a cohort with a different K would either skip some scenarios or
    overflow others. Refuse the mismatch."""
    cohorts = [
        {
            "id": "335_wood_frame_q0",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 5_000,
            "loss_p99": 50_000,
            "loss_scenarios": [10.0, 20.0, 30.0, 40.0],
        },
        {
            "id": "335_wood_frame_q1",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 6_000,
            "loss_p99": 60_000,
            "loss_scenarios": [11.0, 22.0],  # different K
        },
    ]
    with pytest.raises(ValueError, match="same K"):
        _build_problem(
            cohorts=cohorts,
            capital_budget=1e8,
            max_nonrenew_pct=0.1,
            cession_budget=1e6,
            risk_measure="tvar_99",
            binary=True,
            tvar_aggregation="rockafellar_uryasev",
        )


# ── default-path stability ───────────────────────────────────────────────


def _toy_cohort_with_scenarios(
    cid: str,
    *,
    tiv: float = 50_000_000,
    premium: float = 600_000,
    loss_p50: float = 200_000,
    loss_p99: float = 1_000_000,
    seed: int | None = None,
) -> dict:
    rng = np.random.default_rng(seed)
    sigma = 0.85
    mu = float(np.log(loss_p50))
    scenarios = rng.lognormal(mean=mu, sigma=sigma, size=50).tolist()
    return {
        "id": cid,
        "total_tiv": tiv,
        "total_premium": premium,
        "loss_p50": loss_p50,
        "loss_p99": loss_p99,
        "loss_scenarios": scenarios,
    }


def _toy_book() -> list[dict]:
    """3-ZIP3, 10-cohort toy with deterministic K=50 scenarios."""
    out = []
    for q in range(4):
        out.append(
            _toy_cohort_with_scenarios(
                f"335_wood_frame_q{q}",
                loss_p50=200_000 * (q + 1),
                loss_p99=1_000_000 * (q + 1),
                seed=335 * 10 + q,
            )
        )
    for q in range(3):
        out.append(
            _toy_cohort_with_scenarios(
                f"320_masonry_q{q}",
                premium=550_000,
                loss_p50=180_000 * (q + 1),
                loss_p99=900_000 * (q + 1),
                seed=320 * 10 + q,
            )
        )
    for q in range(3):
        out.append(
            _toy_cohort_with_scenarios(
                f"339_commercial_q{q}",
                tiv=80_000_000,
                premium=750_000,
                loss_p50=300_000 * (q + 1),
                loss_p99=1_400_000 * (q + 1),
                seed=339 * 10 + q,
            )
        )
    return out


def test_default_tvar_aggregation_is_per_cohort_sum() -> None:
    """Backward-compat pin: omitting ``tvar_aggregation`` must give
    the same result as explicitly passing ``'per_cohort_sum'``. This
    is what keeps every committed artifact through v0.2.1 stable
    after the R-U merge."""
    cohorts = _toy_book()
    kwargs = dict(
        capital_budget=12_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
        risk_measure="tvar_99",
    )
    omitted = solve(cohorts, **kwargs)
    explicit = solve(cohorts, **kwargs, tvar_aggregation="per_cohort_sum")
    assert omitted["objective"] == pytest.approx(explicit["objective"])
    assert omitted["actions"] == explicit["actions"]
    # Either both surface the flag or neither — the API is consistent.
    assert (
        omitted.get("tvar_aggregation_used")
        == explicit.get("tvar_aggregation_used")
        == "per_cohort_sum"
    )


def test_var_99_ignores_tvar_aggregation_argument() -> None:
    """Under ``risk_measure='var_99'`` the aggregation flag is
    meaningless — verify omitting and passing default both produce
    the same answer, and that nothing surfaces a stale flag in the
    result dict."""
    cohorts = _toy_book()
    kwargs = dict(
        capital_budget=10_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
    )
    omitted = solve(cohorts, **kwargs)
    explicit = solve(cohorts, **kwargs, tvar_aggregation="per_cohort_sum")
    assert omitted["objective"] == pytest.approx(explicit["objective"])
    assert "tvar_aggregation_used" not in omitted
    assert "tvar_aggregation_used" not in explicit


# ── R-U solves cleanly + result shape ────────────────────────────────────


def test_ru_solve_produces_optimal_with_expected_result_shape() -> None:
    """R-U + tvar_99 on the toy book must solve cleanly under loose
    budgets and carry the new ``tvar_aggregation_used`` field +
    on-demand ``tvar_99_per_cohort`` mapping."""
    cohorts = _toy_book()
    out = solve(
        cohorts,
        capital_budget=50_000_000,  # loose
        max_nonrenew_pct=0.20,
        cession_budget=5_000_000,
        risk_measure="tvar_99",
        tvar_aggregation="rockafellar_uryasev",
    )
    assert out["status"] == "Optimal"
    assert out["tvar_99_used"] is True
    assert out["tvar_aggregation_used"] == "rockafellar_uryasev"
    assert "tvar_99_per_cohort" in out
    # Every toy cohort must surface a per-cohort TVaR scalar (computed
    # on demand under R-U since the cluster precompute is bypassed).
    assert set(out["tvar_99_per_cohort"]) == {c["id"] for c in cohorts}


def test_ru_capital_used_matches_book_top_1pct_mean_at_optimum() -> None:
    """Under R-U at optimum, ``α + (1/(K·0.01))·Σ z_s`` equals the
    empirical book TVaR-99 of the realized action mix's per-scenario
    losses. We can independently compute that from the solver's
    action allocation and check the R-U value matches.

    This is the headline 'R-U gives the joint book TVaR'
    correctness pin — the value the LP constraint sees IS the
    empirical book TVaR under the realized action mix.
    """
    cohorts = _toy_book()
    out = solve(
        cohorts,
        capital_budget=50_000_000,  # loose enough not to bind
        max_nonrenew_pct=0.20,
        cession_budget=5_000_000,
        risk_measure="tvar_99",
        tvar_aggregation="rockafellar_uryasev",
    )
    assert out["status"] == "Optimal"

    # Reconstruct per-scenario book losses from the action mix +
    # raw loss_scenarios + LOSS_FACTOR / retained_xs treaty terms.
    from api_py.optimize_portfolio import LOSS_FACTOR
    from api_py.treaty import retained_xs

    actions_by_cohort = {a["cohort_id"]: a for a in out["actions"]}
    K = len(cohorts[0]["loss_scenarios"])
    book_losses = np.zeros(K)
    for c in cohorts:
        cid = c["id"]
        loss50 = float(c["loss_p50"])
        loss99 = float(c["loss_p99"])
        attach = loss50 * 1.5
        exh = loss99 * 2.0
        scenarios = np.array(c["loss_scenarios"], dtype=float)
        for action_name, share in actions_by_cohort[cid].items():
            if action_name == "cohort_id":
                continue
            if share <= 0:
                continue
            if action_name == "cede_xs":
                per_scen = np.array(
                    [retained_xs(float(L), attach, exh) for L in scenarios]
                )
            else:
                per_scen = scenarios * LOSS_FACTOR[action_name]
            book_losses += share * per_scen

    # Empirical book TVaR-99 = mean of top 1 % (K=50 → top 0.5 element
    # by ceil; in practice the top entry).
    threshold = np.percentile(book_losses, 99)
    tail = book_losses[book_losses >= threshold]
    empirical_tvar = float(tail.mean()) if tail.size else float(
        book_losses.max()
    )

    # Capital constraint isn't binding here (loose budget), but the
    # realized retained_tvar_99 reported by the solver should match
    # the empirical computation to LP-solver precision.
    realized = float(out["retained_tvar_99"])
    assert realized == pytest.approx(empirical_tvar, rel=0.02), (
        f"realized retained TVaR {realized:,.2f} doesn't match "
        f"empirical book TVaR {empirical_tvar:,.2f} on the materialized "
        f"action mix"
    )


def test_ru_joint_tvar_is_at_most_per_cohort_sum_tvar_on_toy() -> None:
    """Subadditivity: TVaR is a coherent risk measure, so
    ``TVaR(Σ_c L_c) ≤ Σ_c TVaR(L_c)``. The R-U capital_used at
    optimum should therefore be ≤ the per-cohort-sum capital_used
    when both solves are run against the same budget.

    Practical implication: at the same capital_budget, R-U has at
    least as much slack as per-cohort-sum and so the R-U objective
    is ≥ the per-cohort-sum objective (the optimizer can afford
    more risk for the same budget under the tighter measure).
    """
    cohorts = _toy_book()
    kwargs = dict(
        # Tight enough that the constraint actually binds, so the
        # gap between the two measures shows up in the action mix.
        capital_budget=8_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
        risk_measure="tvar_99",
    )
    per_cohort = solve(cohorts, **kwargs, tvar_aggregation="per_cohort_sum")
    ru = solve(cohorts, **kwargs, tvar_aggregation="rockafellar_uryasev")

    assert per_cohort["status"] != "Infeasible"
    assert ru["status"] != "Infeasible"
    # R-U should reach an objective ≥ per-cohort-sum (less conservative
    # capital measure ⇒ more headroom for revenue actions).
    assert ru["objective"] >= per_cohort["objective"] - 1e-6, (
        f"R-U objective {ru['objective']:,.2f} is meaningfully less "
        f"than per-cohort-sum {per_cohort['objective']:,.2f} — "
        f"subadditivity would predict the opposite ordering"
    )


# ── CG path: R-U routes to LP-master ─────────────────────────────────────


def test_solve_cg_ru_rejects_var_99_combination() -> None:
    with pytest.raises(ValueError, match="requires risk_measure='tvar_99'"):
        solve_cg(
            [_toy_cohort_with_scenarios("335_wood_frame_q0", seed=1)],
            capital_budget=1e8,
            max_nonrenew_pct=0.1,
            cession_budget=1e6,
            risk_measure="var_99",
            tvar_aggregation="rockafellar_uryasev",
        )


def test_solve_cg_ru_rejects_unknown_aggregation() -> None:
    with pytest.raises(ValueError, match="unknown tvar_aggregation"):
        solve_cg(
            [_toy_cohort_with_scenarios("335_wood_frame_q0", seed=1)],
            capital_budget=1e8,
            max_nonrenew_pct=0.1,
            cession_budget=1e6,
            risk_measure="tvar_99",
            tvar_aggregation="median_excess",
        )


def test_solve_cg_ru_routes_through_lp_master() -> None:
    """Under R-U the CG path should skip the subgradient loop
    entirely (``iterations == 0``) and report
    ``solver_mode='column_generation_lp_master_ru'``."""
    cohorts = _toy_book()
    out = solve_cg(
        cohorts,
        capital_budget=50_000_000,  # loose
        max_nonrenew_pct=0.20,
        cession_budget=5_000_000,
        risk_measure="tvar_99",
        tvar_aggregation="rockafellar_uryasev",
    )
    assert out["status"] == "Optimal"
    assert out["solver_mode"] == "column_generation_lp_master_ru"
    assert out["iterations"] == 0
    assert out["tvar_aggregation_used"] == "rockafellar_uryasev"


def test_solve_cg_ru_matches_monolithic_ru_on_toy() -> None:
    """Both paths solve the same R-U LP; the CG prototype just does
    so via its LP-master fallback. Objectives should match to LP
    precision; the argmax projection on the CG side may yield a
    slightly different integer action than the monolithic MILP, so
    we hold the gap to 1 % (consistent with the legacy CG toy
    acceptance)."""
    cohorts = _toy_book()
    kwargs = dict(
        capital_budget=50_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=5_000_000,
        risk_measure="tvar_99",
        tvar_aggregation="rockafellar_uryasev",
    )
    mono = solve(cohorts, **kwargs)
    cg = solve_cg(cohorts, **kwargs)

    assert mono["status"] == "Optimal"
    assert cg["status"] == "Optimal"
    mono_obj = float(mono["objective"])
    cg_obj = float(cg["objective_value"])
    rel_gap = abs(cg_obj - mono_obj) / max(abs(mono_obj), 1.0)
    assert rel_gap <= 0.01, (
        f"CG R-U objective {cg_obj:,.2f} not within 1 % of monolithic "
        f"{mono_obj:,.2f} (rel_gap={rel_gap:.4%})"
    )


# ── live-book subadditivity (heavy; opt-out) ─────────────────────────────


def _load_live_book() -> tuple[list[dict] | None, dict | None]:
    artifact = Path("artifacts") / "portfolio_optimization.json"
    if not artifact.exists():
        return None, None
    data = json.loads(artifact.read_text())
    cohorts = data.get("cohorts")
    if not cohorts:
        return None, None
    if not cohorts[0].get("loss_scenarios"):
        return None, None
    return cohorts, data["budgets"]


@pytest.mark.skipif(
    os.getenv("FORGE_SKIP_RU_LIVE_GATE") == "1",
    reason="Live 570-cohort R-U joint TVaR gate skipped via "
           "FORGE_SKIP_RU_LIVE_GATE=1 (opt-out for slow CI: R-U LP on "
           "K=1000 × 570 cohorts can take ~30-60 s under CBC)",
)
def test_ru_joint_tvar_is_at_most_per_cohort_sum_on_live_book() -> None:
    """Subadditivity gate on the v0.2.1 artifact's 570-cohort book.
    At the artifact's own budget triple under ``risk_measure='tvar_99'``,
    R-U joint TVaR-99 ≤ per-cohort-sum TVaR-99 by coherent-risk
    subadditivity — and the R-U-optimal objective ≥ per-cohort-sum.

    The R-U LP carries K=1000 auxiliary z_s variables + K linking
    constraints; CBC LP relaxation handles this in tens of seconds.
    """
    cohorts, budgets = _load_live_book()
    if cohorts is None:
        pytest.skip("artifacts/portfolio_optimization.json missing or stale")
    assert budgets is not None

    kwargs = dict(
        capital_budget=float(budgets["capital_budget"]),
        max_nonrenew_pct=float(budgets["max_nonrenew_pct"]),
        cession_budget=float(budgets["cession_budget"]),
        risk_measure="tvar_99",
    )
    per_cohort = solve(cohorts, **kwargs, tvar_aggregation="per_cohort_sum")
    ru = solve(cohorts, **kwargs, tvar_aggregation="rockafellar_uryasev")

    assert per_cohort["status"] != "Infeasible"
    assert ru["status"] != "Infeasible"
    assert ru["tvar_aggregation_used"] == "rockafellar_uryasev"
    assert per_cohort["tvar_aggregation_used"] == "per_cohort_sum"

    # R-U objective ≥ per-cohort-sum (less conservative measure ⇒ more
    # revenue headroom at the same budget). Allow a small numerical
    # margin in case the per-cohort-sum integer solution coincidentally
    # uses less capital than the budget; the strict ≥ may break by
    # rounding-heuristic levels of slack.
    assert ru["objective"] >= per_cohort["objective"] - 1.0, (
        f"R-U objective {ru['objective']:,.2f} less than per-cohort-sum "
        f"{per_cohort['objective']:,.2f} — subadditivity would predict "
        f"the opposite ordering on the live book"
    )
