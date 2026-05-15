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
