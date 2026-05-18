"""Task P2.9 — SAA mode with optimality-gap envelope.

Sample Average Approximation (SAA) wraps the deterministic-equivalent
MIP from ``api_py.optimize_portfolio.solve`` and runs it multiple times
with K-sized scenario samples per replication. Each replication is
seeded distinctly so the spread of the resulting objectives gives a
Monte-Carlo estimate of the K-approximation's optimality gap.

The contract is:

    solve_saa(cohorts, K, n_replications, ...) → dict with
        objectives (list[float]), mean_objective, std_objective,
        gap_envelope (1.96·σ/√n), best_actions, tightening_estimate.

Tests cover:

1. **Monotonic tightening**: as K grows ∈ {100, 500, 1000}, the across-
   replication ``std_objective`` should decrease (Slater's law of large
   numbers on the scenario integral).
2. **Determinism**: same ``seed`` → identical ``objectives`` list.
3. **Backward-compat**: cohorts without ``loss_scenarios`` synthesize
   via the lognormal posterior fallback (same path as P2.0).
4. **Empty cohorts list**: raises a clear error rather than crashing.
5. **Gap envelope arithmetic**: with known objectives [10, 12, 11, 13,
   11] and n=5, the 95% CI half-width = 1.96 × σ / √n. Verified
   numerically against a stubbed solve.
"""

from __future__ import annotations

import math
import time

import numpy as np
import pytest

from api_py.saa import solve_saa


# ---------------------------------------------------------------------------
# Tiny toy book — 5 cohorts. Tuned so K=1000 × n_replications=3 stays well
# under 30s wall-clock (~0.2s on CI) AND so the TVaR-99 capital coefficient
# sits near the capital-budget boundary — the only place where SAA scenario
# sampling actually flips action picks in a binary MIP. Without a boundary,
# the optimizer locks onto the same dominant action across replications
# and the std collapses to 0 *for every K*, washing out the monotonicity
# signal the plan asks us to verify.
#
# At capital_budget=1.8M, the K=100 spread is ~4.6k (one of 3 replications
# downgrades a single cohort) while K≥500 collapses to a single objective
# — the canonical 1/√K tightening pattern.
# ---------------------------------------------------------------------------
def _toy_cohorts_with_scenarios(seed: int = 0) -> list[dict]:
    """Five heterogeneous cohorts carrying their own ``loss_scenarios``.

    Each cohort has p99 = 5×p50 (a heavier tail than the precompute's
    4× default) so the TVaR-99 of K=100 samples can over- or under-shoot
    the cap by enough to flip a single cohort's action between
    replications. K=500/1000 sample enough of the tail to recover the
    true TVaR within ~1% and the action picks stabilize.
    """
    rng = np.random.default_rng(seed)
    cohorts: list[dict] = []
    for i in range(5):
        p50 = 100_000.0 + i * 20_000.0
        p99 = p50 * 5.0
        mu = math.log(p50)
        sigma = (math.log(p99) - math.log(p50)) / 2.326
        # 3000 underlying scenarios — SAA samples K (≤1000) from this pool
        # with replacement.
        scenarios = rng.lognormal(mean=mu, sigma=sigma, size=3000).tolist()
        cohorts.append(
            {
                "id": f"c{i}",
                "total_tiv": 5e6,
                "total_premium": 80_000,
                "loss_p50": p50,
                "loss_p99": p99,
                "loss_scenarios": scenarios,
                "zip3": "330",
            }
        )
    return cohorts


def _toy_cohorts_without_scenarios() -> list[dict]:
    """Three cohorts with only ``loss_p50`` / ``loss_p99`` — no scenario
    array. SAA must fall back to a lognormal-posterior synthesis path."""
    return [
        {
            "id": "c0",
            "total_tiv": 1e6,
            "total_premium": 20_000,
            "loss_p50": 5_000.0,
            "loss_p99": 20_000.0,
            "zip3": "330",
        },
        {
            "id": "c1",
            "total_tiv": 2e6,
            "total_premium": 40_000,
            "loss_p50": 50_000.0,
            "loss_p99": 250_000.0,
            "zip3": "331",
        },
        {
            "id": "c2",
            "total_tiv": 3e6,
            "total_premium": 60_000,
            "loss_p50": 200_000.0,
            "loss_p99": 700_000.0,
            "zip3": "337",
        },
    ]


def test_saa_monotonic_tightening_across_K() -> None:
    """Plan-verbatim: K ∈ {100, 500, 1000} with n_replications=3 on a
    small toy book. The across-replication ``std_objective`` should
    decrease as K grows — the scenario-average integral converges to
    its true value at rate σ/√K, so the spread of replicated objectives
    contracts roughly as 1/√K.

    We assert a *monotonic* drop from K=100 → K=1000 (allowing a small
    bump at K=500 due to finite-sample noise on 3 replications); the
    end-points must show the contraction.
    """
    cohorts = _toy_cohorts_with_scenarios(seed=42)
    # ``capital_budget=1.8M`` sits in the action-flip boundary band for
    # this 5-cohort book — K=100 sometimes over-/under-samples the tail
    # and flips a single cohort between retain-style and a cede, while
    # K≥500 estimates the tail tightly enough that all replications
    # agree on the same action vector.
    common = dict(
        capital_budget=1_800_000,
        max_nonrenew_pct=0.8,
        cession_budget=1e7,
        n_replications=3,
        seed=0,
    )
    t0 = time.time()
    out_100 = solve_saa(cohorts, K=100, **common)
    out_500 = solve_saa(cohorts, K=500, **common)
    out_1000 = solve_saa(cohorts, K=1000, **common)
    elapsed = time.time() - t0

    # Sanity: each result has 3 objectives.
    assert len(out_100["objectives"]) == 3
    assert len(out_500["objectives"]) == 3
    assert len(out_1000["objectives"]) == 3

    # Monotonic tightening on the endpoints (K=100 wider than K=1000).
    # The *direction* is what matters; the exact ratio depends on which
    # cohort flips and is sensitive to the seed-derived RNG stream.
    assert out_1000["std_objective"] < out_100["std_objective"], (
        f"Expected std to contract as K grows; got "
        f"K=100 σ={out_100['std_objective']:.0f}, "
        f"K=1000 σ={out_1000['std_objective']:.0f}"
    )
    # K=500 should sit at-or-below K=100 — 1/√K is monotonic in
    # expectation, allow 50% slack for the 3-replication finite-sample
    # noise.
    assert out_500["std_objective"] <= out_100["std_objective"] * 1.5, (
        f"K=500 σ={out_500['std_objective']:.0f} should not exceed "
        f"K=100 σ={out_100['std_objective']:.0f} × 1.5"
    )

    # Wall-clock sanity for the plan: <30s budget across all 3 K values.
    assert elapsed < 30, f"SAA toy run took {elapsed:.1f}s (target <30s)"


def test_saa_determinism_same_seed_same_objectives() -> None:
    """Re-running with the same ``seed`` produces an identical
    ``objectives`` list — the per-replication RNG is derived from
    ``seed + replication_idx`` so the sampled scenarios are reproducible.
    """
    cohorts = _toy_cohorts_with_scenarios(seed=7)
    common = dict(
        capital_budget=1e9,
        max_nonrenew_pct=0.5,
        cession_budget=1e7,
        K=200,
        n_replications=3,
        seed=123,
    )
    out_a = solve_saa(cohorts, **common)
    out_b = solve_saa(cohorts, **common)

    assert out_a["objectives"] == out_b["objectives"], (
        f"Same seed should yield identical objectives; got "
        f"{out_a['objectives']} vs {out_b['objectives']}"
    )
    # Derived stats follow.
    assert out_a["mean_objective"] == out_b["mean_objective"]
    assert out_a["std_objective"] == out_b["std_objective"]


def test_saa_falls_back_to_lognormal_when_scenarios_missing() -> None:
    """Cohorts without ``loss_scenarios`` synthesize K samples from the
    lognormal posterior whose median = ``loss_p50`` and 99th percentile
    = ``loss_p99`` (the same path P2.0 uses in the precompute script).
    """
    cohorts = _toy_cohorts_without_scenarios()
    for c in cohorts:
        assert "loss_scenarios" not in c

    out = solve_saa(
        cohorts,
        capital_budget=1e9,
        max_nonrenew_pct=0.5,
        cession_budget=1e7,
        K=200,
        n_replications=2,
        seed=0,
    )
    # The wrapper still produces 2 objectives and a sane envelope.
    assert len(out["objectives"]) == 2
    assert all(math.isfinite(o) for o in out["objectives"])
    assert out["K"] == 200
    assert out["n_replications"] == 2
    assert "gap_envelope" in out


def test_saa_empty_cohorts_raises_clear_error() -> None:
    """An empty cohorts list cannot be solved — SAA should raise a clear
    ``ValueError`` rather than crashing inside PuLP or numpy."""
    with pytest.raises(ValueError, match="cohorts"):
        solve_saa(
            [],
            capital_budget=1e9,
            max_nonrenew_pct=0.5,
            cession_budget=1e7,
            K=100,
            n_replications=2,
            seed=0,
        )


def test_saa_gap_envelope_formula(monkeypatch) -> None:
    """Plan-verbatim: with stubbed objectives [10, 12, 11, 13, 11] and
    n_replications=5, the 95% CI half-width = 1.96 × σ / √5.

    We monkeypatch ``api_py.saa._solve_one_replication`` to return a
    pre-determined objective per call, so we can assert the gap-envelope
    arithmetic without depending on PuLP's solution.
    """
    import api_py.saa as saa_mod

    stub_objectives = [10.0, 12.0, 11.0, 13.0, 11.0]
    calls = {"i": 0}

    def fake_solve_one(*args, **kwargs):
        i = calls["i"]
        calls["i"] += 1
        return {
            "objective": stub_objectives[i],
            "actions": [],
            "status": "Optimal",
        }

    monkeypatch.setattr(saa_mod, "_solve_one_replication", fake_solve_one)

    cohorts = _toy_cohorts_without_scenarios()
    out = solve_saa(
        cohorts,
        capital_budget=1e9,
        max_nonrenew_pct=0.5,
        cession_budget=1e7,
        K=100,
        n_replications=5,
        seed=0,
    )

    assert out["objectives"] == stub_objectives
    # Sample standard deviation (ddof=1) of [10, 12, 11, 13, 11] is
    # ≈ 1.1401754250991378.
    expected_std = float(np.std(stub_objectives, ddof=1))
    expected_mean = float(np.mean(stub_objectives))
    expected_half = 1.96 * expected_std / math.sqrt(5)

    assert math.isclose(out["std_objective"], expected_std, rel_tol=1e-9)
    assert math.isclose(out["mean_objective"], expected_mean, rel_tol=1e-9)
    assert math.isclose(out["gap_envelope"], expected_half, rel_tol=1e-9)

    # ``tightening_estimate`` should be the max(objectives) − mean(objectives)
    # gap (or its CI-width sibling — the impl reports both, but the
    # primary key is the upper-bound gap). max(13) − mean(11.4) = 1.6.
    assert math.isclose(
        out["tightening_estimate"], max(stub_objectives) - expected_mean,
        rel_tol=1e-9,
    )

    # ``best_actions`` should be the actions from the replication with
    # the highest objective (index 3, value 13).
    assert out["best_actions"] == []  # stub returns empty actions list.
    assert out["K"] == 100
    assert out["n_replications"] == 5
