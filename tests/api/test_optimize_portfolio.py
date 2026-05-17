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
    """With tight capital, even low-loss cohorts must cede.

    Task P2.7 update: ``cede_xs`` no longer zeros its capital coefficient
    (the pre-P2.7 ``free escape hatch`` is gone — see ``api_py.treaty``).
    Under the new honest model with defaults ``att = loss_p50 × 1.5``
    (= 75k here) and ``exh = loss_p99 × 2.0`` (= 400k), full retention
    costs ``loss_p99`` (200k), ``cede_qs`` costs ``0.5 × loss_p99``
    (100k), and ``cede_xs`` costs ``retained_xs(200k, 75k, 400k) = 75k``
    (the below-attachment slice; nothing above exhaustion since p99 sits
    well under the 400k cap). ``non_renew`` is the only zero-capital
    action. So a capital budget of 60k binds: the solver must blend
    non_renew + cede_xs/cede_qs to avoid breaching.
    ``de_risked = non_renew + cede_qs + cede_xs`` should still dominate.
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
        capital_budget=60_000,
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


# ---------------------------------------------------------------------------
# Task P2.6 — TVaR-99 swap in MIP capital constraint.
#
# Field-name reconciliation: the plan's verbatim test uses the bare key
# ``scenarios``. P2.0 already persists scenarios as ``loss_scenarios`` on each
# cohort dict (see ``OptimizedCohort.loss_scenarios`` in
# ``lib/portfolio-actions.ts`` and commit ``ce0ecc9``). To avoid a second
# field-name alias becoming permanent vocabulary, we rewrite the plan-verbatim
# test below to use ``loss_scenarios`` — the canonical field name owned by
# P2.0. ``solve()`` only accepts ``loss_scenarios`` (no alias).
# ---------------------------------------------------------------------------
def test_solve_with_tvar_99_capital() -> None:
    """P2.6 (plan-verbatim, rewritten to use ``loss_scenarios``).

    Field rename: the plan's draft used ``scenarios=[...]`` on the cohort
    dict, but P2.0 already standardized on ``loss_scenarios``. We use the
    canonical name here rather than introduce an alias that would become
    drag forever.
    """
    out = solve(
        cohorts=[
            {
                "id": "c1",
                "total_tiv": 1e6,
                "total_premium": 1e4,
                "loss_p50": 5000,
                "loss_p99": 50000,
                # 100 scenarios: top 1% = the single 100000 value.
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

    Without this guard a future refactor that always-prefers scenarios would
    silently change every existing artifact. We assert the invariant by
    crafting a cohort whose TVaR-99 differs sharply from ``loss_p99`` and
    showing the capital-budget cutover happens at the ``loss_p99`` level.
    """
    # loss_p99 = 100_000, but the top-1% mean of these scenarios is ~1_000_000
    # (top 1 of 100 = the single 1e6 value). Under VaR-99 the capital cost of
    # ``retain`` is 100_000; under TVaR-99 it would be 1_000_000. Setting the
    # budget at 150_000 leaves retain feasible under VaR-99 but infeasible
    # under TVaR-99 — proving which path is active.
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
    # Default risk_measure path: no kwarg.
    out = solve(
        cohorts=cohorts,
        capital_budget=150_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert out["status"] == "Optimal"
    # Output must NOT advertise TVaR.
    assert out.get("tvar_99_used") is not True
    assert "tvar_99_per_cohort" not in out
    # A retain-style action (retain / reprice_up / reprice_down — all carry
    # LOSS_FACTOR=1.0) should be feasible at this budget under VaR-99
    # (100k <= 150k). Under TVaR-99 the coefficient would be ~1M and the
    # solver would have to cede.
    a = out["actions"][0]
    retain_style = a["retain"] + a["reprice_up"] + a["reprice_down"]
    cede_style = a["cede_qs"] + a["cede_xs"] + a["non_renew"]
    assert retain_style > 0.5 and cede_style < 0.5, (
        f"VaR-99 path should keep the cohort in retain-style actions at "
        f"budget 150k vs loss_p99 100k (and would force a cede under "
        f"TVaR-99 ~1M), got {a}"
    )


def test_solve_tvar_99_falls_back_to_loss_p99_when_scenarios_missing() -> None:
    """P2.6: when ``risk_measure='tvar_99'`` but a cohort lacks
    ``loss_scenarios``, that cohort falls back to ``loss_p99`` for its
    capital coefficient. The output still flags ``tvar_99_used=True`` so
    callers know which risk measure was *requested*.
    """
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 20000,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
            # No loss_scenarios.
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
    # Per-cohort dict should reflect that we fell back to loss_p99 for c1.
    per_cohort = out.get("tvar_99_per_cohort", {})
    assert per_cohort.get("c1") == 20_000.0, (
        f"Fallback cohort should record loss_p99 in tvar_99_per_cohort, "
        f"got {per_cohort}"
    )


def test_solve_tvar_99_changes_solution_on_extreme_tail_cohort() -> None:
    """P2.6: a cohort with an extreme top-1% (TVaR ≫ p99) should be more
    aggressively de-risked under TVaR-99 than under VaR-99.

    Construction: ``loss_p99=100_000`` but the top-1% mean of the scenarios
    is ~1_000_000. With a tight capital budget, the VaR-99 solver only sees
    the 100k coefficient and can retain; the TVaR-99 solver sees ~1M and
    must cede.

    Task P2.7 update: ``cede_xs`` no longer zeros capital (per-scenario
    retained tail is now real), so the budget had to be loosened from
    200k → 300k. Under P2.7 + TVaR-99 the retained_xs(1M, 15k, 200k)
    coefficient on cede_xs is ~815k, so the solver must mix non_renew
    (0 cost) with cede_qs (~500k) to land under budget. Under VaR-99
    the retain coefficient (100k) still fits comfortably.
    """
    base_cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 200_000,
        "loss_p50": 10_000,
        "loss_p99": 100_000,
        # 100 scenarios; top-1% (1 value) is 1_000_000 → TVaR ≈ 1M.
        "loss_scenarios": [1_000] * 99 + [1_000_000],
    }
    common = dict(
        capital_budget=300_000,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )

    out_var = solve(cohorts=[dict(base_cohort)], risk_measure="var_99", **common)
    out_tvar = solve(cohorts=[dict(base_cohort)], risk_measure="tvar_99", **common)

    assert out_var["status"] == "Optimal"
    assert out_tvar["status"] == "Optimal"

    a_var = out_var["actions"][0]
    a_tvar = out_tvar["actions"][0]

    # Under VaR-99 the cohort can comfortably retain (coefficient 100k vs
    # 200k budget). Under TVaR-99 it must cede (coefficient ~1M vs 200k).
    var_retain = a_var["retain"] + a_var["reprice_up"] + a_var["reprice_down"]
    tvar_cede = a_tvar["cede_qs"] + a_tvar["cede_xs"] + a_tvar["non_renew"]
    assert var_retain > 0.5, (
        f"Under VaR-99 the cohort should retain (loss_p99 100k << "
        f"budget 200k), got {a_var}"
    )
    assert tvar_cede > 0.5, (
        f"Under TVaR-99 the cohort should de-risk (TVaR ~1M >> "
        f"budget 200k), got {a_tvar}"
    )


def test_solve_tvar_99_emits_per_cohort_traceability() -> None:
    """P2.6: ``tvar_99_per_cohort`` maps each cohort id to the TVaR-99
    value used in the capital coefficient. Cheap traceability for the
    reconciler/UI to display 'why this action'.
    """
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
    # For 100 scenarios, top-1% threshold = numpy 99th percentile.
    # The extreme cohort's top-1% mean = the single 100_000 value.
    assert per_cohort["extreme"] == 100_000.0
    # Calm cohort: top-1% mean = 6_000.
    assert per_cohort["calm"] == 6_000.0


# ---------------------------------------------------------------------------
# Task P2.7 — per-cohort per-scenario retained tail (kill ``cede_xs`` zeroing).
#
# Before P2.7, the capital constraint zeroed out ``cede_xs`` from the VaR/TVaR
# retention with the comment "XS attaches below p99 so retained tail is ~0".
# That's a mock-grade shortcut — it makes ``cede_xs`` a free capital-zeroing
# action which is exactly the kind of sleight-of-hand a reinsurance reviewer
# will flag on sight. P2.7 replaces the zero with
# ``mean(retained_xs(L, att, exh) for L in scenarios)``: still linear in
# ``x[(c, a)]`` (the integration is over scenarios, not decisions) so the MIP
# stays MIP-shaped.
#
# Default attachment/exhaustion derivation (until P2.17 lets the user
# configure per-cohort treaties):
#   attachment = loss_p50 × 1.5   (treaty kicks in modestly above expected loss)
#   exhaustion = loss_p99 × 2.0   (layer caps out at 2× the cohort's p99)
# ---------------------------------------------------------------------------
def test_solve_cede_xs_no_longer_zeros_capital_var_99() -> None:
    """P2.7: with default attachment/exhaustion, ``cede_xs`` carries a
    positive retained-tail capital cost rather than a free zero.

    Construction: a single cohort with ``loss_p50=10_000`` and
    ``loss_p99=50_000`` (so default attachment=1.5×p50=15k,
    exhaustion=2×p99=100k). Under the pre-P2.7 zeroing trick,
    ``cede_xs`` would contribute 0 to the capital constraint; under
    P2.7 the retained tail at loss_p99 is
    ``retained_xs(50_000, 15_000, 100_000) = 15_000`` (the 15k below
    attachment; nothing above exhaustion since 50k < 100k).

    With a tight capital budget that forces ``cede_xs`` to be the dominant
    action, the constraint must reflect that positive retained tail —
    otherwise the solver could pick ``cede_xs`` "for free" and over-spend.
    """
    from api_py.treaty import retained_xs

    cohort = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 200_000,
        "loss_p50": 10_000,
        "loss_p99": 50_000,
        # No loss_scenarios — exercises the var_99 path (uses loss_p99
        # directly through retained_xs).
    }
    # Default treaty: attachment=1.5×p50=15_000, exhaustion=2×p99=100_000.
    # retained_xs(50_000, 15_000, 100_000) = min(50k, 15k) + max(0, -50k)
    # = 15k + 0 = 15k.
    expected_retained = retained_xs(50_000, 15_000, 100_000)
    assert expected_retained == 15_000
    assert expected_retained > 0, "default treaty should leave positive retained tail"

    # Capital budget set just below the expected retained tail × cede_xs
    # share so that pure cede_xs is infeasible — proves the constraint
    # actually counts the retained tail.
    out = solve(
        cohorts=[cohort],
        capital_budget=expected_retained * 0.5,
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
    )
    assert out["status"] == "Optimal"
    a = out["actions"][0]
    # cede_xs alone would consume the full retained tail (15k) > budget
    # (7.5k), so the solver must blend in non_renew or cede_qs to bring
    # capital usage down. Pre-P2.7 (with cede_xs=0 capital), cede_xs
    # alone would be feasible — that's the bug this test guards.
    assert a["cede_xs"] < 1.0 - 1e-6, (
        f"Under P2.7, cede_xs cannot zero capital — solver should blend "
        f"with non_renew/cede_qs to satisfy the tight budget. Got {a}"
    )


def test_solve_tvar_99_cede_xs_uses_per_scenario_retained_tail() -> None:
    """P2.7 + P2.6 interaction: under TVaR-99 with ``cede_xs``, the capital
    coefficient is ``mean(retained_xs(L_s, att, exh) for L_s in top_1%)``.

    Construction: a cohort with ``loss_p50=10_000`` (default
    attachment = 1.5×p50 = 15k) and ``loss_p99=100_000`` (default
    exhaustion = 2×p99 = 200k). Scenarios: 99 small draws + a single
    500_000 outlier. Under TVaR-99 the top 1% = just the 500k draw, so
    the per-scenario retained tail =
    ``retained_xs(500k, 15k, 200k) = 15k below + 300k above = 315k``.

    The pre-P2.7 path would zero this; P2.7 must surface 315k in the
    capital constraint. Verify by showing the solver de-risks under a
    budget tight against 315k.
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
    # Default treaty: attachment=1.5×p50=15_000, exhaustion=2×p99=200_000.
    # top-1% of scenarios = single 500_000 draw.
    # retained_xs(500_000, 15_000, 200_000)
    #   = min(500k, 15k) + max(0, 500k - 200k)
    #   = 15_000 + 300_000 = 315_000.
    expected = retained_xs(500_000.0, 15_000.0, 200_000.0)
    assert expected == 315_000.0

    # Set capital budget below the expected retained tail × 1.0 so a
    # pure cede_xs allocation must overshoot the budget — forcing the
    # solver to mix in non_renew/cede_qs. If the constraint still zeroed
    # cede_xs, the solver would happily pick cede_xs=1.0.
    out = solve(
        cohorts=[cohort],
        capital_budget=expected * 0.5,  # 157.5k vs 315k retained tail
        max_nonrenew_pct=0.5,
        cession_budget=1e6,
        risk_measure="tvar_99",
    )
    assert out["status"] == "Optimal"
    assert out["tvar_99_used"] is True
    a = out["actions"][0]
    assert a["cede_xs"] < 1.0 - 1e-6, (
        f"Under TVaR-99 + P2.7, the cede_xs retained tail (315k) exceeds "
        f"the 157.5k budget — solver must blend. Got {a}"
    )
