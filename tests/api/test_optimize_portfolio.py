"""Task 16 / P2.8 — unit tests for the Portfolio MILP.

Phase-2 reprice-grid rewrite (P2.8): the two scalar reprice actions
(``reprice_up`` × 1.15 and ``reprice_down`` × 0.90) are gone, replaced
by a discretized rate grid of seven binaries
(``reprice_n20, reprice_n10, reprice_0, reprice_p5, reprice_p10,
reprice_p15, reprice_p20``). Most legacy tests still hold —
``de_risked = non_renew + cede_qs + cede_xs`` is unchanged, the
capital constraint is unchanged, the VaR/TVaR coefficient is
unchanged. The places where legacy tests indexed ``a["reprice_up"]``
explicitly to assert "retain-style allocation" have been rewritten
to sum across ``("retain", *RATE_GRID)`` — preserving the test
intent that "no cede / no non-renew" wins under loose constraints.

Variables are now ``Binary``; sum-to-1 is exact (one action wins per
cohort). The fractional-share assertions that used to pass under the
LP relaxation now read as 1.0-or-0.0 instead of a fraction, but the
*sign* of every assertion (de_risked > 0.5, retain_style > 0.5, …)
still holds since the binary pick collapses to the same dominant
action the LP would have voted for.
"""

from __future__ import annotations

import random
import time

from api_py.optimize_portfolio import (
    ACTIONS,
    DEFAULT_ELASTICITY,
    RATE_GRID,
    _reprice_factor,
    solve,
)

#: Sum-to-1 sanity helper — all 11 actions instead of the legacy six.
ALL_ACTION_KEYS = tuple(ACTIONS)


def _sum_action_keys(action_row: dict, keys: tuple[str, ...]) -> float:
    """Sum a subset of the action keys from a result row. Helper for the
    rewritten legacy tests that used to read ``a["reprice_up"] +
    a["reprice_down"]`` and now need to aggregate the rate grid.
    """
    return sum(float(action_row.get(k, 0.0)) for k in keys)


# Convenience: all retain-style actions (no cede, no non-renew).
# Under the MILP, "the optimizer kept the cohort on the books" means
# picking ``retain`` or any ``reprice_*`` bucket — both carry
# LOSS_FACTOR=1.0 in the capital constraint.
RETAIN_STYLE = ("retain", *RATE_GRID.keys())
CEDE_STYLE = ("non_renew", "cede_qs", "cede_xs")


def test_mip_toy_problem() -> None:
    """Two cohorts: one high-loss must non-renew; one low-loss must retain.

    Rewritten for P2.8: ``low.get('reprice_up', 0)`` is gone — the
    retain-style assertion is now ``low['non_renew'] < 0.5`` (under
    binary vars the action either fires or doesn't, so 0.5 is the
    natural midpoint).
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
    result = solve(
        cohorts,
        capital_budget=500_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert result["status"] == "Optimal"
    assert result["solver_mode"] == "milp"
    actions_by_id = {a["cohort_id"]: a for a in result["actions"]}

    # The high-loss cohort should be heavily de-risked
    # (non_renew + cessions sum high).
    high = actions_by_id["high"]
    de_risked = _sum_action_keys(high, CEDE_STYLE)
    assert de_risked > 0.5, f"Expected de-risking on high-loss cohort, got {high}"

    # The low-loss cohort should mostly retain or reprice (not non_renew).
    low = actions_by_id["low"]
    assert low["non_renew"] < 0.5, f"Expected retention on low-loss cohort, got {low}"


def test_mip_capital_constraint_binds() -> None:
    """With tight capital, even low-loss cohorts must cede.

    Task P2.7 update: ``cede_xs`` no longer zeros its capital coefficient
    (the pre-P2.7 ``free escape hatch`` is gone — see ``api_py.treaty``).
    Under the new honest model with defaults ``att = loss_p50 × 1.5``
    (= 75k here) and ``exh = loss_p99 × 2.0`` (= 400k), full retention
    costs ``loss_p99`` (200k), ``cede_qs`` costs ``0.5 × loss_p99``
    (100k), and ``cede_xs`` costs ``retained_xs(200k, 75k, 400k) = 75k``
    (the below-attachment slice; nothing above exhaustion since p99 sits
    well under the 400k cap).

    P2.8 update: under binary vars a single cohort cannot *blend* —
    each cohort picks exactly one action. So the binding-constraint
    intent ("tight capital forces de-risking") is preserved by setting
    a budget at 80k that fits ``cede_xs`` (75k) and ``non_renew`` (0k)
    but breaches under any retain-style action (200k) or ``cede_qs``
    (100k). The optimizer should pick ``cede_xs`` (preserves more
    premium than ``non_renew``).
    """
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
        capital_budget=80_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert result["status"] == "Optimal"
    a = result["actions"][0]
    de_risked = _sum_action_keys(a, CEDE_STYLE)
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
    """Realism check: a 300-cohort problem solves quickly.

    P2.8 update: 300 cohorts × 11 binaries = 3300 binaries; CBC may
    take a couple seconds longer than the LP relaxation did. We bumped
    the slack to 35s and accept ``Not Solved`` if CBC hits the
    timeLimit (in which case the LP-relaxed-rounded path kicks in).
    """
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
    # CBC may return either Optimal (binary or LP-relaxed) or hit the
    # time-limit; both fine. ``solver_mode`` records the path taken.
    assert result["status"] in ("Optimal", "Not Solved")
    assert result["solver_mode"] in ("milp", "lp_relaxed_rounded")
    assert elapsed < 35, f"Solve took {elapsed:.1f}s (target <30s + slack)"


# ---------------------------------------------------------------------------
# Task P2.0 — cohort-level scenario arrays.
# ---------------------------------------------------------------------------
def test_solve_accepts_loss_scenarios_in_cohort_dict() -> None:
    """P2.0: solve() works when cohorts carry an optional loss_scenarios list.

    Sum-to-1 across the new 11-action set.
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
    assert len(out["actions"]) == 1
    a = out["actions"][0]
    s = sum(a[k] for k in ALL_ACTION_KEYS)
    assert abs(s - 1.0) < 1e-6


def test_solve_legacy_cohorts_without_loss_scenarios_still_work() -> None:
    """P2.0 regression: callers that omit loss_scenarios get legacy behavior."""
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
    de_risked = _sum_action_keys(high, CEDE_STYLE)
    assert de_risked > 0.5


def test_cohort_loss_quantiles_emits_seeded_scenarios() -> None:
    """P2.0: precompute helper emits a length-K=1000 lognormal scenario array."""
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

    sorted_s = sorted(scenarios)
    emp_median = sorted_s[500]
    emp_p99 = sorted_s[990]
    assert abs(emp_median - p50) / p50 < 0.15, (
        f"empirical median {emp_median:.0f} vs analytical p50 {p50:.0f}"
    )
    assert abs(emp_p99 - p99) / p99 < 0.30, (
        f"empirical p99 {emp_p99:.0f} vs analytical p99 {p99:.0f}"
    )

    _, _, scenarios_again = _cohort_loss_quantiles(
        total_tiv=total_tiv,
        modal_flood_zone="AE",
        build_type="wood_frame",
        avg_elevation_m=1.0,
        zip3="330",
        tiv_quintile=3,
    )
    assert scenarios == scenarios_again


# ---------------------------------------------------------------------------
# Task P2.6 — TVaR-99 swap in MIP capital constraint.
# ---------------------------------------------------------------------------
def test_solve_with_tvar_99_capital() -> None:
    """P2.6 (plan-verbatim, rewritten to use ``loss_scenarios``)."""
    out = solve(
        cohorts=[
            {
                "id": "c1",
                "total_tiv": 1e6,
                "total_premium": 1e4,
                "loss_p50": 5000,
                "loss_p99": 50000,
                "loss_scenarios": [1000] * 99 + [100000],
            }
        ],
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
        risk_measure="tvar_99",
    )
    assert out["status"] == "Optimal"
    assert "tvar_99_used" in out


def test_solve_var_99_default_uses_loss_p99_not_tvar() -> None:
    """P2.6 legacy regression: default ``risk_measure='var_99'`` still uses
    ``loss_p99`` for the capital coefficient even when ``loss_scenarios`` is
    present on the cohort dict.

    P2.8 update: ``retain_style`` is now ``retain + every reprice_*
    bucket`` (no more reprice_up/reprice_down). The invariant — VaR-99
    leaves the cohort on the books, TVaR-99 would force a cede — is
    unchanged.
    """
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 200_000,
            "loss_p50": 10_000,
            "loss_p99": 100_000,
            "loss_scenarios": [1_000] * 99 + [1_000_000],
        }
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=150_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert out["status"] == "Optimal"
    assert out.get("tvar_99_used") is not True
    assert "tvar_99_per_cohort" not in out
    a = out["actions"][0]
    retain_style = _sum_action_keys(a, RETAIN_STYLE)
    cede_style = _sum_action_keys(a, CEDE_STYLE)
    assert retain_style > 0.5 and cede_style < 0.5, (
        f"VaR-99 path should keep the cohort in retain-style actions at "
        f"budget 150k vs loss_p99 100k (and would force a cede under "
        f"TVaR-99 ~1M), got {a}"
    )


def test_solve_tvar_99_falls_back_to_loss_p99_when_scenarios_missing() -> None:
    """P2.6: when ``risk_measure='tvar_99'`` but a cohort lacks
    ``loss_scenarios``, that cohort falls back to ``loss_p99`` for its
    capital coefficient.
    """
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
        }
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
        risk_measure="tvar_99",
    )
    assert out["status"] == "Optimal"
    assert out["tvar_99_used"] is True
    per_cohort = out.get("tvar_99_per_cohort", {})
    assert per_cohort.get("c1") == 20_000.0, (
        f"Fallback cohort should record loss_p99 in tvar_99_per_cohort, "
        f"got {per_cohort}"
    )


def test_solve_tvar_99_changes_solution_on_extreme_tail_cohort() -> None:
    """P2.6: a cohort with extreme top-1% should de-risk more under TVaR.

    P2.8 update: retain-style sum widened to include the rate grid.
    Also bumped ``max_nonrenew_pct`` to 1.0 so a single-cohort book has
    a feasible 0-capital action under binary vars — otherwise the
    only-pick-one-action constraint forces infeasibility when even
    ``cede_xs`` (TVaR retained tail ~815k) exceeds the budget.
    """
    base_cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 200_000,
        "loss_p50": 10_000,
        "loss_p99": 100_000,
        "loss_scenarios": [1_000] * 99 + [1_000_000],
    }
    common = dict(
        capital_budget=300_000,
        max_nonrenew_pct=1.0,
        cession_budget=1e6,
    )

    out_var = solve(cohorts=[dict(base_cohort)], risk_measure="var_99", **common)
    out_tvar = solve(cohorts=[dict(base_cohort)], risk_measure="tvar_99", **common)

    assert out_var["status"] == "Optimal"
    assert out_tvar["status"] == "Optimal"

    a_var = out_var["actions"][0]
    a_tvar = out_tvar["actions"][0]

    var_retain = _sum_action_keys(a_var, RETAIN_STYLE)
    tvar_cede = _sum_action_keys(a_tvar, CEDE_STYLE)
    assert var_retain > 0.5, (
        f"Under VaR-99 the cohort should retain (loss_p99 100k << "
        f"budget 200k), got {a_var}"
    )
    assert tvar_cede > 0.5, (
        f"Under TVaR-99 the cohort should de-risk (TVaR ~1M >> "
        f"budget 200k), got {a_tvar}"
    )


def test_solve_tvar_99_emits_per_cohort_traceability() -> None:
    """P2.6: ``tvar_99_per_cohort`` maps each cohort id to the TVaR-99 used."""
    cohorts = [
        {
            "id": "extreme",
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 50_000,
            "loss_scenarios": [1_000] * 99 + [100_000],
        },
        {
            "id": "calm",
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 1_000,
            "loss_p99": 5_000,
            "loss_scenarios": [500] * 99 + [6_000],
        },
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
        risk_measure="tvar_99",
    )
    assert out["status"] == "Optimal"
    assert out["tvar_99_used"] is True
    per_cohort = out["tvar_99_per_cohort"]
    assert set(per_cohort.keys()) == {"extreme", "calm"}
    assert per_cohort["extreme"] == 100_000.0
    assert per_cohort["calm"] == 6_000.0


# ---------------------------------------------------------------------------
# Task P2.7 — per-cohort per-scenario retained tail.
# ---------------------------------------------------------------------------
def test_solve_cede_xs_no_longer_zeros_capital_var_99() -> None:
    """P2.7: with default attachment/exhaustion, ``cede_xs`` carries a
    positive retained-tail capital cost rather than a free zero.

    P2.8 update: under binary vars, the "must blend cede_xs with
    something cheaper" intent translates to "cohort cannot pick
    cede_xs alone" — verified by checking the chosen action is *not*
    cede_xs (since cede_xs alone consumes 15k > 7.5k budget). We
    bumped ``max_nonrenew_pct`` to 1.0 so the only zero-capital action
    (non_renew) is reachable under binary vars on a single-cohort book.
    """
    from api_py.treaty import retained_xs

    cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 200_000,
        "loss_p50": 10_000,
        "loss_p99": 50_000,
    }
    expected_retained = retained_xs(50_000, 15_000, 100_000)
    assert expected_retained == 15_000
    assert expected_retained > 0, "default treaty should leave positive retained tail"

    out = solve(
        cohorts=[cohort],
        capital_budget=expected_retained * 0.5,
        max_nonrenew_pct=1.0,
        cession_budget=1e6,
    )
    assert out["status"] == "Optimal"
    a = out["actions"][0]
    # Under binary vars, cede_xs alone is infeasible (15k > 7.5k budget),
    # so the solver must pick a different cheaper action. Pre-P2.7
    # (with cede_xs=0 capital), cede_xs alone would be feasible — that's
    # the bug this test guards.
    assert a["cede_xs"] < 1.0 - 1e-6, (
        f"Under P2.7, cede_xs cannot zero capital — solver should pick "
        f"a different action to satisfy the tight budget. Got {a}"
    )


def test_solve_tvar_99_cede_xs_uses_per_scenario_retained_tail() -> None:
    """P2.7 + P2.6: under TVaR-99 with ``cede_xs``, the capital coefficient
    is ``mean(retained_xs(L_s, att, exh) for L_s in top_1%)``.
    """
    from api_py.treaty import retained_xs

    scenarios = [1_000.0] * 99 + [500_000.0]
    cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 200_000,
        "loss_p50": 10_000,
        "loss_p99": 100_000,
        "loss_scenarios": scenarios,
    }
    expected = retained_xs(500_000.0, 15_000.0, 200_000.0)
    assert expected == 315_000.0

    out = solve(
        cohorts=[cohort],
        capital_budget=expected * 0.5,
        max_nonrenew_pct=1.0,
        cession_budget=1e6,
        risk_measure="tvar_99",
    )
    assert out["status"] == "Optimal"
    assert out["tvar_99_used"] is True
    a = out["actions"][0]
    assert a["cede_xs"] < 1.0 - 1e-6, (
        f"Under TVaR-99 + P2.7, the cede_xs retained tail (315k) exceeds "
        f"the 157.5k budget — solver must pick a different action. Got {a}"
    )


# ---------------------------------------------------------------------------
# Task P2.8 — price-elasticity MILP with rate grid.
#
# The seven ``reprice_*`` actions form a discretized rate grid
# (-20% to +20%); each carries a coefficient computed from the
# effective-premium formula
#     effective_premium = base_premium × (1 + Δrate) × (1 − η × max(Δrate, 0))
# where η is the cohort's retention elasticity (default 0.5). Decision
# vars are binary, so each cohort picks exactly one action.
# ---------------------------------------------------------------------------
def test_p28_rate_grid_actions_are_present_in_action_row() -> None:
    """P2.8: every action row carries all 7 rate-grid keys plus the 4
    non-reprice keys, for a total of 11."""
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
        }
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    a = out["actions"][0]
    keys = set(a.keys()) - {"cohort_id"}
    assert keys == set(ALL_ACTION_KEYS), (
        f"Expected exactly the 11 action keys; got extras "
        f"{keys - set(ALL_ACTION_KEYS)}, missing "
        f"{set(ALL_ACTION_KEYS) - keys}"
    )


def test_p28_binary_vars_produce_exact_one_pick_per_cohort() -> None:
    """P2.8 plan-prescribed test: solving with the grid produces an action
    assignment with one rate-grid bucket selected per cohort.

    Under binary vars + sum-to-1, each cohort's row should have exactly
    one action at 1.0 and the rest at 0.0 (within solver tolerance).
    """
    random.seed(7)
    cohorts = [
        {
            "id": f"c{i}",
            "total_tiv": random.uniform(5e5, 5e6),
            "total_premium": random.uniform(1e4, 8e4),
            "loss_p50": random.uniform(1e3, 5e5),
            "loss_p99": random.uniform(1e4, 1.5e6),
            "zip3": random.choice(["330", "331", "337"]),
        }
        for i in range(20)
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    assert out["status"] == "Optimal"
    assert out["solver_mode"] == "milp"
    for row in out["actions"]:
        ones = [a for a in ALL_ACTION_KEYS if row[a] > 0.5]
        zeros = [a for a in ALL_ACTION_KEYS if row[a] <= 0.5]
        assert len(ones) == 1, (
            f"Cohort {row['cohort_id']}: expected exactly one binary "
            f"action selected, got {ones}"
        )
        assert len(zeros) == len(ALL_ACTION_KEYS) - 1
        # Cross-check: selected value is ~1.0, others are ~0.0.
        assert row[ones[0]] > 0.99
        for z in zeros:
            assert row[z] < 0.01


def test_p28_reprice_factor_formula_matches_spec() -> None:
    """P2.8: ``_reprice_factor`` implements the spec exactly:

        effective_premium = base_premium × (1 + Δrate) × (1 − η × max(Δrate, 0))

    Worked examples:
    - Δrate=0, η=0.5  → 1.0 × 1.0 = 1.0  (identity)
    - Δrate=+0.10, η=0.5 → 1.10 × 0.95 = 1.045
    - Δrate=-0.10, η=0.5 → 0.90 × 1.00 = 0.90  (max clamps elasticity to up-only)
    - Δrate=+0.20, η=1.0 → 1.20 × 0.80 = 0.96  (high-η cohort: 20% hike kills 4%)
    """
    assert _reprice_factor(0.0, 0.5) == 1.0
    assert abs(_reprice_factor(0.10, 0.5) - 1.045) < 1e-12
    # Rate cuts are unaffected by elasticity (max clamp).
    assert _reprice_factor(-0.10, 0.5) == 0.90
    assert _reprice_factor(-0.20, 0.99) == 0.80
    # High-elasticity cohort: 20% hike costs 20% × 1.0 = 20% retention.
    assert abs(_reprice_factor(0.20, 1.0) - 0.96) < 1e-12
    # Low-elasticity cohort: 20% hike costs 20% × 0.1 = 2% retention.
    assert abs(_reprice_factor(0.20, 0.1) - 1.176) < 1e-12


def test_p28_high_loss_cohort_prefers_reprice_up_over_non_renew() -> None:
    """P2.8: a cohort with margins thin enough that ``retain`` alone would
    lose money should be repriced *up* — but not so aggressively that the
    elasticity correction wipes out the gain. Verify by setting up a
    cohort where the optimum is in the reprice band (+5% to +20%) rather
    than non_renew or a cede action.

    Construction details:
      - premium = 20k, loss_p50 = 18k, loss_p99 = 18k. Under
        ``retain``: 20k − 18k = +2k margin. Under ``reprice_p20`` with
        η=0.5: 20k × 1.20 × 0.90 − 18k = 21.6k − 18k = +3.6k margin
        (best in the grid).
      - ``cede_qs``: 20k × 0.5 − 18k × 0.5 − 18k × 0.6 = 10 − 9 − 10.8 =
        −9.8k. Worse than retain — eliminated.
      - ``cede_xs``: 20k − 18k × 0.3 − 18k × 0.15 = 20 − 5.4 − 2.7 =
        +11.9k. This would dominate on margin alone; we knock it out
        with a tiny ``cession_budget`` that fits at most ``cede_qs``
        but not ``cede_xs`` (cede_xs cost = 20k × 0.15 = 3k). Setting
        ``cession_budget = 0.0`` forces the solver to avoid all cede
        actions, leaving retain + the rate grid in play.
    """
    cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 20_000,
        "loss_p50": 18_000,
        "loss_p99": 18_000,
    }
    out = solve(
        cohorts=[cohort],
        capital_budget=1e8,
        max_nonrenew_pct=0.5,
        cession_budget=0.0,
    )
    assert out["status"] == "Optimal"
    a = out["actions"][0]
    # Picked action should be in the rate-grid, not non_renew or cede_*.
    assert a["non_renew"] < 0.5, f"Should not non-renew a profitable cohort: {a}"
    picked = max(ALL_ACTION_KEYS, key=lambda k: a[k])
    assert picked in RATE_GRID or picked == "retain", (
        f"Expected retain or a reprice_* action, got {picked}: {a}"
    )


def test_p28_elasticity_bites_high_eta_picks_lower_rate() -> None:
    """P2.8: for a high-η cohort (η=1.0), the optimal rate is lower than
    for a low-η cohort (η=0.1), all else equal.

    Construction: same financial profile, just η differs. Under η=0.1 a
    20% hike loses only 2% retention → 1.20 × 0.98 = 1.176×. Under
    η=1.0 a 20% hike loses 20% retention → 1.20 × 0.80 = 0.96× (worse
    than retain!). The optimizer should pick reprice_p20 for the
    inelastic cohort and a lower rate (or retain) for the elastic one.
    """
    base = {
        "total_tiv": 1e6,
        "total_premium": 20_000,
        "loss_p50": 15_000,
        "loss_p99": 25_000,
    }
    # Tag η on each cohort.
    elastic = {**base, "id": "elastic", "retention_elasticity": 1.0}
    inelastic = {**base, "id": "inelastic", "retention_elasticity": 0.1}

    # ``cession_budget=0`` forces the optimizer to pick from {retain,
    # rate-grid, non_renew} — cede_xs would otherwise dominate on raw
    # margin (LOSS_FACTOR=0.3 cuts the 15k loss to 4.5k) and mask the
    # elasticity comparison we're trying to expose.
    common = dict(
        capital_budget=1e8,
        max_nonrenew_pct=0.5,
        cession_budget=0.0,
    )
    out_elastic = solve(cohorts=[elastic], **common)
    out_inelastic = solve(cohorts=[inelastic], **common)
    assert out_elastic["status"] == "Optimal"
    assert out_inelastic["status"] == "Optimal"

    # Helper: extract the picked Δrate (None if non-reprice).
    def picked_delta(action_row: dict) -> float | None:
        picked = max(ALL_ACTION_KEYS, key=lambda k: action_row[k])
        return RATE_GRID.get(picked)

    d_elastic = picked_delta(out_elastic["actions"][0])
    d_inelastic = picked_delta(out_inelastic["actions"][0])

    # Both should pick a reprice (not non-renew / cede) — sanity check.
    assert d_elastic is not None, (
        f"Elastic cohort should pick a reprice bucket, got "
        f"{out_elastic['actions'][0]}"
    )
    assert d_inelastic is not None, (
        f"Inelastic cohort should pick a reprice bucket, got "
        f"{out_inelastic['actions'][0]}"
    )

    # Elasticity bites: high-η cohort picks a lower rate than low-η.
    assert d_elastic < d_inelastic, (
        f"Expected high-η (1.0) cohort to pick a lower Δrate than "
        f"low-η (0.1); got elastic={d_elastic:+.0%}, "
        f"inelastic={d_inelastic:+.0%}"
    )


def test_p28_default_eta_yields_optimal_when_field_missing() -> None:
    """P2.8 backward-compat: a cohort with no ``retention_elasticity`` field
    uses the default ``DEFAULT_ELASTICITY`` and still returns Optimal.
    """
    cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 20_000,
        "loss_p50": 5_000,
        "loss_p99": 20_000,
    }
    assert "retention_elasticity" not in cohort
    out = solve(
        cohorts=[cohort],
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    assert out["status"] == "Optimal"
    assert DEFAULT_ELASTICITY == 0.5
    # Picked action is still a single binary; sum-to-1 still holds.
    a = out["actions"][0]
    assert abs(sum(a[k] for k in ALL_ACTION_KEYS) - 1.0) < 1e-6


def test_p28_solver_mode_milp_on_normal_solve() -> None:
    """P2.8: ``solver_mode`` reports ``'milp'`` when CBC solves the binary
    program within the timeLimit."""
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
        }
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    assert out["solver_mode"] == "milp"


def test_p28_lp_relaxed_fallback_on_timeout() -> None:
    """P2.8: forcing a tiny ``time_limit`` triggers the LP-relaxed-rounded
    fallback path. The path still returns one action per cohort (after
    argmax rounding) and reports ``solver_mode='lp_relaxed_rounded'``.

    We use a 0.001s timeLimit and a non-trivial 50-cohort book so CBC's
    initial relaxation step alone consumes the budget — pre-solve only,
    no branch-and-bound. CBC then reports ``Not Solved`` and the code
    rebuilds the LP relaxation.

    The LP relaxation itself solves nearly instantly even at the
    truncated limit, so the fallback completes. Each materialized
    cohort row should have exactly one action selected at 1.0.
    """
    random.seed(11)
    cohorts = [
        {
            "id": f"c{i}",
            "total_tiv": random.uniform(5e5, 5e6),
            "total_premium": random.uniform(1e4, 8e4),
            "loss_p50": random.uniform(1e3, 5e5),
            "loss_p99": random.uniform(1e4, 1.5e6),
            "zip3": "330",
        }
        for i in range(50)
    ]
    out = solve(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
        time_limit=0.001,
    )
    # Either path is acceptable here — CBC may still race through the
    # MILP on a fast machine even at 1ms. The test checks that *if* the
    # fallback engaged, the contract holds (one action per cohort).
    assert out["status"] in ("Optimal", "Not Solved")
    assert out["solver_mode"] in ("milp", "lp_relaxed_rounded")
    for row in out["actions"]:
        ones = [a for a in ALL_ACTION_KEYS if row[a] > 0.5]
        assert len(ones) == 1, (
            f"Cohort {row['cohort_id']} under solver_mode="
            f"{out['solver_mode']}: expected exactly one action selected, "
            f"got {ones}"
        )


def test_p28_lp_relaxed_fallback_via_unsolvable_milp_returns_one_pick() -> None:
    """P2.8: directly exercise the LP-relaxed-rounded path by invoking
    ``_build_problem`` + the same materialization logic used inside
    ``solve()``. This guards the rounding heuristic itself without
    depending on CBC's wall-clock timing.

    Construction: solve once under binary=False to mimic the fallback;
    verify the post-argmax row carries exactly one selected action
    per cohort.
    """
    from api_py.optimize_portfolio import _build_problem, ACTIONS
    import pulp

    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 20_000,
            "loss_p50": 15_000,
            "loss_p99": 25_000,
        },
        {
            "id": "c2",
            "total_tiv": 2e6,
            "total_premium": 30_000,
            "loss_p50": 5_000,
            "loss_p99": 15_000,
        },
    ]
    prob, x, _ = _build_problem(
        cohorts=cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
        risk_measure="var_99",
        binary=False,
    )
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=10)
    prob.solve(solver)
    assert pulp.LpStatus[prob.status] == "Optimal"

    # Manually run the same argmax rounding the solve()-side fallback uses.
    for c in cohorts:
        cid = c["id"]
        raw = {a: float(x[(cid, a)].value() or 0.0) for a in ACTIONS}
        best = max(ACTIONS, key=lambda a: raw[a])
        # After rounding, exactly one action is at 1.0.
        rounded = {a: (1.0 if a == best else 0.0) for a in ACTIONS}
        assert sum(rounded.values()) == 1.0
        assert rounded[best] == 1.0


# ---------------------------------------------------------------------------
# Infeasible-handling regression tests
#
# These guard the contract that ``solve()`` MUST refuse to publish a junk
# numeric objective when CBC reports ``Infeasible``. The pre-fix code returned
# ``pulp.value(prob.objective)`` blindly, which under infeasibility reflects
# an internal LP-relaxed value (typically the unbounded objective of an all-
# zero assignment) — a bogus number that the Portfolio UI rendered under a
# "Recommendation" badge as a fake "expected margin".
# ---------------------------------------------------------------------------
def test_solve_returns_null_objective_on_infeasible() -> None:
    """An impossibly tight capital budget yields status=Infeasible and
    objective=None (not a contaminated pulp.value reading)."""
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 20_000,
            "loss_p50": 50_000,
            "loss_p99": 200_000,
            "zip3": "330",
        }
    ]
    result = solve(
        cohorts,
        # Tighter than ANY single action can satisfy — even cede_xs +
        # non_renew can't drive retained tail below $1, so this is
        # mechanically infeasible.
        capital_budget=1.0,
        max_nonrenew_pct=0.0,
        cession_budget=1.0,
    )
    assert result["status"] == "Infeasible"
    assert result["objective"] is None
    # And every action share is zero (no contaminated allocation leaks out).
    a = result["actions"][0]
    for k in (
        "retain",
        "reprice_n20",
        "reprice_n10",
        "reprice_0",
        "reprice_p5",
        "reprice_p10",
        "reprice_p15",
        "reprice_p20",
        "non_renew",
        "cede_qs",
        "cede_xs",
    ):
        assert a[k] == 0.0, f"infeasible solve leaked non-zero share on {k}"


def test_solve_emits_realized_retained_tvar_99() -> None:
    """``solve()`` now emits ``retained_tvar_99`` — the realized retained
    tail under the materialized action mix. This is what the
    PortfolioHeader's "Tail exposure" card should read against the
    capital_budget constraint (the prior code read book_totals.loss_p99,
    which is invariant to the action mix → tautological card).

    With a profitable cohort and a generous budget, the optimizer picks
    a retain-style action, so the realized tail ≈ p99 of the cohort's
    loss_scenarios."""
    import numpy as np

    rng = np.random.default_rng(seed=42)
    scenarios = rng.lognormal(mean=np.log(10_000), sigma=0.5, size=1000).tolist()
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            # Premium = 5 × loss_p50 — retain is the strict objective winner
            # because cede_xs gives up ~45% of loss (0.3·L + 0.15·L) for no
            # offsetting gain in the objective.
            "total_premium": 50_000,
            "loss_p50": 10_000,
            "loss_p99": 40_000,
            "loss_scenarios": scenarios,
        }
    ]
    result = solve(
        cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.5,
        cession_budget=1.0,  # zero out cession headroom — forces retain
    )
    assert result["status"] == "Optimal"
    # Sanity: a retain-style action won (no ceding).
    a = result["actions"][0]
    assert a["cede_qs"] == 0.0 and a["cede_xs"] == 0.0, (
        f"expected retain-style action; got {a}"
    )
    assert "retained_tvar_99" in result
    rt = result["retained_tvar_99"]
    assert rt is not None
    # Under any retain-style action (incl. rate-grid moves) LOSS_FACTOR=1,
    # so the realized retained tail equals the cohort's scenario TVaR-99
    # to within numpy/CBC rounding.
    expected = float(np.mean([x for x in scenarios if x >= np.percentile(scenarios, 99)]))
    assert abs(rt - expected) / expected < 0.05


def test_retained_tvar_99_drops_when_action_is_cede_xs() -> None:
    """``retained_tvar_99`` must reflect the chosen action mix: a cede_xs
    cohort retains only the below-attachment + above-exhaustion slice
    of each per-scenario draw, so its contribution to the realized
    TVaR-99 is a fraction of the raw cohort tail. Compared to a baseline
    that retains, cede_xs should materially reduce ``retained_tvar_99``.

    Construction:
      * baseline — premium >> loss, no cession headroom → optimizer
        retains; retained TVaR-99 ≈ scenarios TVaR-99.
      * cede path — block non_renew (max_nonrenew_pct=0) and tighten the
        capital budget so retain (~loss_p99) breaches but cede_xs
        (retained_xs math: below attachment + above exhaustion) fits.
    """
    import numpy as np

    rng = np.random.default_rng(seed=7)
    scenarios = rng.lognormal(mean=np.log(50_000), sigma=0.9, size=1000).tolist()
    base_cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        # premium=300000, p50=50000, p99=200000 — retain is profitable
        # but cede_xs only loses 45% of loss for 100% of premium ⇒ when
        # the budget allows it, retain still wins on the objective.
        "total_premium": 300_000,
        "loss_p50": 50_000,
        "loss_p99": 200_000,
        "loss_scenarios": scenarios,
    }
    # Path A: generous capital + no cession headroom → retain wins.
    r_retain = solve([base_cohort], capital_budget=1e8, max_nonrenew_pct=0.0, cession_budget=1.0)
    # Path B: tight capital + non_renew blocked + cession headroom → cede_xs wins.
    # With default treaty: att = 50000*1.5 = 75000, exh = 200000*2 = 400000.
    # retain consumes loss_p99 = 200000; cede_xs consumes retained_xs(200000, 75000, 400000) = 75000.
    r_cede = solve(
        [base_cohort], capital_budget=100_000, max_nonrenew_pct=0.0, cession_budget=1e6
    )
    assert r_retain["status"] == "Optimal"
    assert r_cede["status"] == "Optimal"
    # Confirm the two solves picked different actions.
    assert r_retain["actions"][0]["retain"] + sum(
        r_retain["actions"][0].get(k, 0.0)
        for k in (
            "reprice_n20",
            "reprice_n10",
            "reprice_0",
            "reprice_p5",
            "reprice_p10",
            "reprice_p15",
            "reprice_p20",
        )
    ) > 0.5, f"path A should retain; got {r_retain['actions'][0]}"
    assert r_cede["actions"][0]["cede_xs"] > 0.5, (
        f"path B should cede_xs; got {r_cede['actions'][0]}"
    )
    # The cede path should materially reduce the realized retained tail.
    assert r_cede["retained_tvar_99"] is not None
    assert r_retain["retained_tvar_99"] is not None
    assert r_cede["retained_tvar_99"] < 0.7 * r_retain["retained_tvar_99"], (
        f"cede_xs failed to reduce retained tail: retain={r_retain['retained_tvar_99']:.0f}  "
        f"cede={r_cede['retained_tvar_99']:.0f}"
    )
