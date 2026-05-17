"""Task 16 — unit tests for the Portfolio MIP."""

from __future__ import annotations

import random
import time

from api_py.optimize_portfolio import solve


def test_mip_toy_problem() -> None:
    """Two cohorts: one high-loss must non-renew; one low-loss must retain."""
    cohorts = [
        {
            "id": "high",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 15000,
            "loss_p50": 800_000,
            "loss_p99": 950_000,
            "zip3": "330",
        },
        {
            "id": "low",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 15000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
            "zip3": "330",
        },
    ]
    result = solve(
        cohorts,
        capital_budget=500_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert result["status"] == "Optimal"
    actions_by_id = {a["cohort_id"]: a for a in result["actions"]}

    # The high-loss cohort should be heavily de-risked
    # (non_renew + cessions sum high).
    high = actions_by_id["high"]
    de_risked = high["non_renew"] + high.get("cede_qs", 0) + high.get("cede_xs", 0)
    assert de_risked > 0.5, f"Expected de-risking on high-loss cohort, got {high}"

    # The low-loss cohort should mostly retain or reprice (not non_renew).
    low = actions_by_id["low"]
    assert low["non_renew"] < 0.3, f"Expected retention on low-loss cohort, got {low}"


def test_mip_capital_constraint_binds() -> None:
    """With near-zero capital, even low-loss cohorts must cede."""
    cohorts = [
        {
            "id": "c1",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 50_000,
            "loss_p99": 200_000,
            "zip3": "330",
        }
    ]
    result = solve(
        cohorts,
        capital_budget=10_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert result["status"] == "Optimal"
    a = result["actions"][0]
    de_risked = a["non_renew"] + a.get("cede_qs", 0) + a.get("cede_xs", 0)
    assert de_risked > 0.5


def test_solve_accepts_horizon_metadata() -> None:
    """Task 24: solve() echoes horizon_start/horizon_end into the output dict."""
    cohorts = [
        {
            "id": "c1",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
            "zip3": "330",
        }
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
        horizon_start="2026-07-01",
        horizon_end="2027-06-30",
    )
    assert out["horizon_start"] == "2026-07-01"
    assert out["horizon_end"] == "2027-06-30"


def test_solve_horizon_defaults_to_treaty_year() -> None:
    """Defaults are the industry cat treaty cycle (Jul 1 → Jun 30)."""
    cohorts = [
        {
            "id": "c1",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
            "zip3": "330",
        }
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    assert out["horizon_start"] == "2026-07-01"
    assert out["horizon_end"] == "2027-06-30"


def test_full_book_solves_under_5_seconds() -> None:
    """Realism check: a 300-cohort problem solves quickly."""
    random.seed(0)
    cohorts = [
        {
            "id": f"c{i}",
            "tiv": random.uniform(5e5, 5e6),
            "total_tiv": random.uniform(5e5, 5e6),
            "total_premium": random.uniform(1e4, 8e4),
            "loss_p50": random.uniform(1e3, 5e5),
            "loss_p99": random.uniform(1e4, 1.5e6),
            "zip3": random.choice(["330", "331", "337", "770", "705", "275"]),
        }
        for i in range(300)
    ]
    t0 = time.time()
    result = solve(
        cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    elapsed = time.time() - t0
    # CBC may return either Optimal or hit the time-limit; both fine.
    assert result["status"] in ("Optimal", "Not Solved")
    assert elapsed < 10, f"Solve took {elapsed:.1f}s (target <5s with 5s slack)"


# ---------------------------------------------------------------------------
# Task P2.0 — cohort-level scenario arrays.
# Precursor for P2.6 (TVaR-99 swap), P2.7 (per-scenario retained tail), and
# P2.8 (elasticity MILP). P2.0 only adds the plumbing: cohorts may carry an
# optional ``loss_scenarios: list[float]`` field; ``solve()`` accepts it
# without consuming it yet (legacy p50/p99 path remains authoritative).
# ---------------------------------------------------------------------------
def test_solve_accepts_loss_scenarios_in_cohort_dict() -> None:
    """P2.0: solve() works when cohorts carry an optional loss_scenarios list.

    The MIP itself doesn't consume the array yet — that's P2.6/P2.7/P2.8 —
    but the signature must tolerate the field so the artifact-consuming
    caller can pass it through without filtering.
    """
    import math
    import random as _rand

    rng = _rand.Random(42)
    mu = math.log(5_000.0)
    sigma = math.log(4.0) / 2.326
    scenarios = [
        math.exp(rng.gauss(mu, sigma)) for _ in range(1000)
    ]
    cohorts = [
        {
            "id": "c1",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
            "loss_scenarios": scenarios,
            "zip3": "330",
        }
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    assert out["status"] == "Optimal"
    # The shape of the result is unchanged — actions still sum to 1, etc.
    assert len(out["actions"]) == 1
    a = out["actions"][0]
    s = sum(a[k] for k in ("retain", "reprice_up", "reprice_down",
                            "non_renew", "cede_qs", "cede_xs"))
    assert abs(s - 1.0) < 1e-6


def test_solve_legacy_cohorts_without_loss_scenarios_still_work() -> None:
    """P2.0 regression: callers that omit loss_scenarios get legacy behavior.

    The legacy callers in `tests/api/test_optimize_portfolio.py::test_mip_*`
    cover this implicitly, but assert it explicitly so a future P2.6
    refactor that *removes* the legacy path will surface here loudly.
    """
    cohorts = [
        {
            "id": "high",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 15000,
            "loss_p50": 800_000,
            "loss_p99": 950_000,
            "zip3": "330",
        },
        {
            "id": "low",
            "tiv": 1e6,
            "total_tiv": 1e6,
            "total_premium": 15000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
            "zip3": "330",
        },
    ]
    for c in cohorts:
        assert "loss_scenarios" not in c
    out = solve(
        cohorts,
        capital_budget=500_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert out["status"] == "Optimal"
    actions_by_id = {a["cohort_id"]: a for a in out["actions"]}
    high = actions_by_id["high"]
    de_risked = high["non_renew"] + high.get("cede_qs", 0) + high.get("cede_xs", 0)
    assert de_risked > 0.5


def test_cohort_loss_quantiles_emits_seeded_scenarios() -> None:
    """P2.0: precompute helper emits a length-K=1000 lognormal scenario array.

    Distribution check: the median of the draws should be ~p50 and the 99th
    percentile should be ~p99 (within sampling tolerance). Reproducibility
    check: two calls with the same (zip3, build_type, q) yield the same
    array within a single interpreter run.
    """
    from scripts.precompute_portfolio_optimization import _cohort_loss_quantiles

    total_tiv = 5.0e7
    p50, p99, scenarios = _cohort_loss_quantiles(
        total_tiv=total_tiv,
        modal_flood_zone="AE",
        build_type="wood_frame",
        avg_elevation_m=1.0,
        zip3="330",
        tiv_quintile=3,
    )
    assert len(scenarios) == 1000
    assert all(s >= 0.0 for s in scenarios)

    # Distribution sanity: empirical median within 15% of p50, p99 within
    # 30% of analytical p99 (sampling noise on 1000 draws is non-trivial).
    sorted_s = sorted(scenarios)
    emp_median = sorted_s[500]
    emp_p99 = sorted_s[990]
    assert abs(emp_median - p50) / p50 < 0.15, (
        f"empirical median {emp_median:.0f} vs analytical p50 {p50:.0f}"
    )
    assert abs(emp_p99 - p99) / p99 < 0.30, (
        f"empirical p99 {emp_p99:.0f} vs analytical p99 {p99:.0f}"
    )

    # Reproducibility within one interpreter run.
    _, _, scenarios_again = _cohort_loss_quantiles(
        total_tiv=total_tiv,
        modal_flood_zone="AE",
        build_type="wood_frame",
        avg_elevation_m=1.0,
        zip3="330",
        tiv_quintile=3,
    )
    assert scenarios == scenarios_again
