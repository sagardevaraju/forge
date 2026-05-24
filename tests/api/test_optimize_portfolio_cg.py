"""Task P3.11 — Column-generation prototype acceptance tests.

Acceptance criterion: a 10-cohort toy solved by the CG prototype
returns an objective value within 1% of the monolithic CBC solve on
the same input.

Also pins the cluster decomposition behavior and the solver result
shape.
"""

from __future__ import annotations

import time

import pytest

from api_py.optimize_portfolio import solve
from api_py.optimize_portfolio_cg import cluster_cohorts, solve_cg


# ── helpers ───────────────────────────────────────────────────────────────


def _toy_cohort(
    cid: str,
    *,
    tiv: float = 50_000_000,
    premium: float = 600_000,
    loss_p50: float = 200_000,
    loss_p99: float = 1_000_000,
) -> dict:
    return {
        "id": cid,
        "total_tiv": tiv,
        "total_premium": premium,
        "loss_p50": loss_p50,
        "loss_p99": loss_p99,
    }


def _toy_10_cohort_book() -> list[dict]:
    """A 10-cohort toy spanning 3 ZIP3 clusters."""
    cohorts = []
    # ZIP3 = 335 (Tampa) — 4 cohorts
    for q in range(4):
        cohorts.append(_toy_cohort(
            f"335_wood_frame_q{q}",
            loss_p50=200_000 * (q + 1),
            loss_p99=1_000_000 * (q + 1),
        ))
    # ZIP3 = 320 (Jax) — 3 cohorts
    for q in range(3):
        cohorts.append(_toy_cohort(
            f"320_masonry_q{q}",
            premium=550_000,
            loss_p50=180_000 * (q + 1),
            loss_p99=900_000 * (q + 1),
        ))
    # ZIP3 = 339 (Fort Myers) — 3 cohorts
    for q in range(3):
        cohorts.append(_toy_cohort(
            f"339_commercial_q{q}",
            tiv=80_000_000,
            premium=750_000,
            loss_p50=300_000 * (q + 1),
            loss_p99=1_400_000 * (q + 1),
        ))
    return cohorts


# ── cluster decomposition ────────────────────────────────────────────────


def test_cluster_cohorts_groups_by_zip3():
    cohorts = _toy_10_cohort_book()
    clusters = cluster_cohorts(cohorts)
    assert set(clusters) == {"335", "320", "339"}
    assert len(clusters["335"]) == 4
    assert len(clusters["320"]) == 3
    assert len(clusters["339"]) == 3


def test_cluster_cohorts_unknown_id_goes_to_underscore_unknown():
    cohorts = [
        {"id": "no_zip_format", "total_tiv": 1, "total_premium": 1,
         "loss_p50": 1, "loss_p99": 2},
        _toy_cohort("335_wood_frame_q0"),
    ]
    clusters = cluster_cohorts(cohorts)
    assert "_unknown" in clusters
    assert len(clusters["_unknown"]) == 1


# ── result shape ──────────────────────────────────────────────────────────


def test_solve_cg_returns_expected_keys():
    cohorts = _toy_10_cohort_book()
    out = solve_cg(
        cohorts,
        capital_budget=100_000_000,
        max_nonrenew_pct=0.10,
        cession_budget=10_000_000,
    )
    for key in (
        "status", "objective_value", "allocation",
        "capital_used", "cession_used", "nonrenew_tiv_used",
        "solver_mode", "iterations", "wall_clock_s",
    ):
        assert key in out
    assert out["solver_mode"] == "column_generation_prototype"
    # Every cohort got an action.
    assert set(out["allocation"]) == {c["id"] for c in cohorts}


def test_solve_cg_rejects_empty_cohorts():
    with pytest.raises(ValueError, match="empty"):
        solve_cg(
            [],
            capital_budget=1.0,
            max_nonrenew_pct=0.1,
            cession_budget=1.0,
        )


# ── acceptance: CG within 1% of monolithic ───────────────────────────────


def _objective_match_within(
    mono: dict, cg: dict, tolerance_pct: float = 0.01
) -> bool:
    """Compare CG objective_value to monolithic objective.

    Returns True if relative gap ≤ tolerance_pct OR if monolithic is
    infeasible and CG also reports infeasible (consistent answers).
    """
    if mono["status"] == "Infeasible" and cg["status"] == "Infeasible":
        return True
    if mono.get("objective") is None or cg["objective_value"] is None:
        return False
    mono_obj = float(mono["objective"])
    cg_obj = float(cg["objective_value"])
    if abs(mono_obj) < 1e-9:
        return abs(cg_obj) < 1e-9
    return abs(cg_obj - mono_obj) / abs(mono_obj) <= tolerance_pct


def test_cg_matches_monolithic_within_1pct_on_10_cohort_toy():
    """Plan acceptance: 10-cohort toy CG within 1% of monolithic CBC."""
    cohorts = _toy_10_cohort_book()
    capital_budget = 8_000_000     # tight enough to bind on some cohorts
    max_nonrenew_pct = 0.20
    cession_budget = 1_500_000

    t0 = time.time()
    mono = solve(
        cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
    )
    t_mono = time.time() - t0

    t0 = time.time()
    cg = solve_cg(
        cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
    )
    t_cg = time.time() - t0

    # Document the solve-time comparison via assertion message (this
    # surfaces in pytest -v output and the PR body).
    assert _objective_match_within(mono, cg, 0.01), (
        f"CG objective {cg.get('objective_value')} not within 1% of "
        f"monolithic {mono.get('objective')}. "
        f"mono_t={t_mono:.3f}s cg_t={t_cg:.3f}s "
        f"cg_iters={cg.get('iterations')}"
    )


def test_cg_matches_monolithic_with_loose_constraints():
    """Loose-budget scenario — CG should converge in few iterations
    and match exactly (or near-exactly) the monolithic solution."""
    cohorts = _toy_10_cohort_book()
    out = solve_cg(
        cohorts,
        capital_budget=1_000_000_000,   # very loose
        max_nonrenew_pct=1.0,
        cession_budget=1_000_000_000,
    )
    mono = solve(
        cohorts,
        capital_budget=1_000_000_000,
        max_nonrenew_pct=1.0,
        cession_budget=1_000_000_000,
    )
    assert _objective_match_within(mono, out, 0.01)
    # With loose constraints CG should converge in just a few iters.
    assert out["iterations"] <= 5


def test_cg_respects_global_capital_budget_when_feasible():
    cohorts = _toy_10_cohort_book()
    capital_budget = 12_000_000
    out = solve_cg(
        cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=0.5,
        cession_budget=10_000_000,
    )
    # Feasible solutions must obey the budget.
    if out["status"] == "Optimal":
        assert out["capital_used"] <= capital_budget * 1.001  # tiny float slack


def test_cg_iterations_bounded():
    cohorts = _toy_10_cohort_book()
    out = solve_cg(
        cohorts,
        capital_budget=8_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
        max_iterations=10,
    )
    assert out["iterations"] <= 10
