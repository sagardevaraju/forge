"""TVaR-99 Benders-cut path for the column-generation prototype.

The original P3.11 prototype (``test_optimize_portfolio_cg.py``)
matches the monolithic CBC at ``risk_measure='var_99'`` only. This
file pins the new ``risk_measure='tvar_99'`` capability:

  - Unit-level pins on the L-shaped multicut precompute
    (``_precompute_tvar_coefficients``) and on the refactored
    ``_capital_coeff`` branch that accepts the precomputed scalars.
  - Toy acceptance: 10-cohort book with K=50 ``loss_scenarios`` per
    cohort; CG TVaR-99 objective within 1% of monolithic TVaR-99.
  - **Verification gate (the headline acceptance criterion):** the
    live 570-cohort book in ``artifacts/portfolio_optimization.json``
    — CG TVaR-99 objective within 0.1% of monolithic TVaR-99 at the
    artifact's own budget triple.

Reference for the per-cohort TVaR cut equivalence: Ahmed & Shapiro
(2008) §4 on CVaR cuts. The per-cohort TVaR-99 scalar IS the cluster's
linear cut contribution to the master capital constraint under the
L-shaped multicut form (Birge & Louveaux §6.4); the Lagrangian
``λ_cap`` from the existing CG loop is the dual variable on the
aggregated cut. See the module docstring of
``api_py/optimize_portfolio_cg.py``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from api_py.optimize_portfolio import solve, _tvar_99_tail
from api_py.optimize_portfolio_cg import (
    TvarCoeffs,
    _capital_coeff,
    _precompute_tvar_coefficients,
    solve_cg,
)


# ── unit: precompute helper ───────────────────────────────────────────────


def test_precompute_tvar_coefficients_returns_per_cohort_tail_mean() -> None:
    """``risk_coeff`` should equal the mean of the top 1% of
    ``loss_scenarios`` — matches the monolithic's per-cohort TVaR-99
    scalar that drives the capital constraint."""
    scenarios = [1000.0] * 99 + [100_000.0]  # tail of one => TVaR = 100k
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 5_000,
            "loss_p99": 50_000,
            "loss_scenarios": scenarios,
        }
    ]
    coeffs = _precompute_tvar_coefficients(cohorts)
    risk_coeff, cede_xs_coeff = coeffs["c1"]
    # The independent reference is the helper the monolithic uses.
    expected_risk, _ = _tvar_99_tail(scenarios)
    assert risk_coeff == pytest.approx(float(expected_risk))
    # cede_xs_coeff is the per-scenario retained_xs averaged over the
    # same tail — must be non-negative and bounded above by the tail
    # mean (retained_xs collapses to attach + max(0, L-exh) ≤ L).
    assert 0.0 <= cede_xs_coeff <= risk_coeff


def test_precompute_tvar_falls_back_to_loss_p99_when_scenarios_missing() -> None:
    """A cohort without ``loss_scenarios`` falls back to ``loss_p99``
    for its capital coefficient — same graceful degradation as the
    monolithic (logged warning, no crash)."""
    cohorts = [
        {
            "id": "c1",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 5_000,
            "loss_p99": 20_000,
        }
    ]
    coeffs = _precompute_tvar_coefficients(cohorts)
    risk_coeff, _ = coeffs["c1"]
    assert risk_coeff == pytest.approx(20_000.0)


def test_capital_coeff_uses_tvar_when_coeffs_supplied() -> None:
    """With ``tvar_coeffs`` supplied, ``_capital_coeff`` returns
    ``risk_coeff_tvar × LOSS_FACTOR[a]`` for non-cede_xs actions and
    the precomputed ``cede_xs_coeff`` for ``cede_xs`` — independent
    of the cohort's ``loss_p99``. The default (no ``tvar_coeffs``)
    still reproduces the legacy VaR-99 path."""
    c = {
        "id": "c1",
        "total_tiv": 1e6,
        "total_premium": 1e4,
        "loss_p50": 5_000,
        "loss_p99": 100_000,  # var_99 path uses this
    }
    coeffs: TvarCoeffs = {"c1": (250_000.0, 80_000.0)}  # tvar much larger
    # retain → LOSS_FACTOR=1.0 → tvar path uses 250k; var path uses 100k.
    assert _capital_coeff(c, "retain", tvar_coeffs=coeffs) == pytest.approx(250_000.0)
    assert _capital_coeff(c, "retain") == pytest.approx(100_000.0)
    # cede_xs → tvar path uses the precomputed scalar verbatim.
    assert _capital_coeff(c, "cede_xs", tvar_coeffs=coeffs) == pytest.approx(80_000.0)


# ── unknown risk_measure ──────────────────────────────────────────────────


def test_solve_cg_rejects_unknown_risk_measure() -> None:
    with pytest.raises(ValueError, match="unknown risk_measure"):
        solve_cg(
            [{"id": "335_wood_frame_q0", "total_tiv": 1e6,
              "total_premium": 1e4, "loss_p50": 5_000, "loss_p99": 50_000}],
            capital_budget=1e8,
            max_nonrenew_pct=0.1,
            cession_budget=1e6,
            risk_measure="cvar_95",  # not supported
        )


# ── result shape under TVaR-99 ────────────────────────────────────────────


def test_solve_cg_tvar_99_carries_tvar_99_used_flag() -> None:
    """Result dict must surface the ``tvar_99_used`` flag + per-cohort
    coefficient map under ``risk_measure='tvar_99'`` — matches the
    monolithic's result shape so callers can detect which capital
    formulation the answer was computed under."""
    cohorts = [
        {
            "id": "335_wood_frame_q0",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 5_000,
            "loss_p99": 50_000,
            "loss_scenarios": [1_000] * 99 + [100_000],
        }
    ]
    out = solve_cg(
        cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
        risk_measure="tvar_99",
    )
    assert out["tvar_99_used"] is True
    assert "tvar_99_per_cohort" in out
    assert "335_wood_frame_q0" in out["tvar_99_per_cohort"]


def test_solve_cg_var_99_default_does_not_carry_tvar_flag() -> None:
    """Default ``risk_measure='var_99'`` does NOT add the
    ``tvar_99_used`` flag — backward-compat with the existing
    P3.11 result-shape pin in ``test_solve_cg_returns_expected_keys``.
    """
    cohorts = [
        {
            "id": "335_wood_frame_q0",
            "total_tiv": 1e6,
            "total_premium": 1e4,
            "loss_p50": 5_000,
            "loss_p99": 50_000,
            "loss_scenarios": [1_000] * 99 + [100_000],
        }
    ]
    out = solve_cg(
        cohorts,
        capital_budget=1e8,
        max_nonrenew_pct=0.1,
        cession_budget=5e6,
    )
    assert "tvar_99_used" not in out
    assert "tvar_99_per_cohort" not in out


# ── toy acceptance ────────────────────────────────────────────────────────


def _toy_cohort_with_scenarios(
    cid: str,
    *,
    tiv: float = 50_000_000,
    premium: float = 600_000,
    loss_p50: float = 200_000,
    loss_p99: float = 1_000_000,
    seed: int | None = None,
) -> dict:
    """Toy cohort with K=50 lognormal scenarios derived from
    (loss_p50, loss_p99). Mirrors the precompute pipeline's lognormal
    seeding (deterministic via ``seed``) so the toy is reproducible."""
    import numpy as np

    rng = np.random.default_rng(seed)
    # Match the precompute's prior σ ≈ 0.85 (research.md §7).
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


def _toy_10_cohort_book_with_scenarios() -> list[dict]:
    """A 10-cohort toy spanning 3 ZIP3 clusters, each with K=50 draws."""
    cohorts = []
    for q in range(4):
        cohorts.append(
            _toy_cohort_with_scenarios(
                f"335_wood_frame_q{q}",
                loss_p50=200_000 * (q + 1),
                loss_p99=1_000_000 * (q + 1),
                seed=335 * 10 + q,
            )
        )
    for q in range(3):
        cohorts.append(
            _toy_cohort_with_scenarios(
                f"320_masonry_q{q}",
                premium=550_000,
                loss_p50=180_000 * (q + 1),
                loss_p99=900_000 * (q + 1),
                seed=320 * 10 + q,
            )
        )
    for q in range(3):
        cohorts.append(
            _toy_cohort_with_scenarios(
                f"339_commercial_q{q}",
                tiv=80_000_000,
                premium=750_000,
                loss_p50=300_000 * (q + 1),
                loss_p99=1_400_000 * (q + 1),
                seed=339 * 10 + q,
            )
        )
    return cohorts


def test_cg_tvar_99_matches_monolithic_within_1pct_on_10_cohort_toy() -> None:
    """Acceptance: CG TVaR-99 within 1% of monolithic TVaR-99 on the
    10-cohort toy. Mirrors the legacy
    ``test_cg_matches_monolithic_within_1pct_on_10_cohort_toy`` but
    under the ``tvar_99`` capital measure with K=50 scenarios."""
    cohorts = _toy_10_cohort_book_with_scenarios()
    # Pick a budget triple that binds capital under TVaR-99 (which is
    # generally larger than VaR-99 for lognormal tails).
    capital_budget = 12_000_000
    max_nonrenew_pct = 0.20
    cession_budget = 1_500_000

    mono = solve(
        cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        risk_measure="tvar_99",
    )
    cg = solve_cg(
        cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        risk_measure="tvar_99",
    )

    if mono["status"] == "Infeasible":
        assert cg["status"] == "Infeasible", (
            f"monolithic infeasible but CG status={cg['status']}; "
            f"capital_used={cg.get('capital_used')}"
        )
        return

    assert mono.get("objective") is not None
    assert cg.get("objective_value") is not None
    mono_obj = float(mono["objective"])
    cg_obj = float(cg["objective_value"])
    rel_gap = abs(cg_obj - mono_obj) / max(abs(mono_obj), 1.0)
    assert rel_gap <= 0.01, (
        f"CG TVaR-99 objective {cg_obj:.6f} not within 1% of "
        f"monolithic {mono_obj:.6f} (rel_gap={rel_gap:.4%}, "
        f"cg_iters={cg.get('iterations')})"
    )


# ── verification gate: live 570-cohort book ──────────────────────────────


def _load_live_book_cohorts() -> list[dict] | None:
    """Pull the cohorts (with K=1000 ``loss_scenarios``) from the
    committed artifact. Returns ``None`` if the artifact is missing or
    doesn't carry per-cohort scenarios so the test can skip rather
    than fail in a fresh checkout."""
    artifact = Path("artifacts") / "portfolio_optimization.json"
    if not artifact.exists():
        return None
    data = json.loads(artifact.read_text())
    cohorts = data.get("cohorts")
    if not cohorts:
        return None
    if not cohorts[0].get("loss_scenarios"):
        return None
    return cohorts


@pytest.mark.skipif(
    os.getenv("FORGE_SKIP_CG_TVAR_LIVE_GATE") == "1",
    reason="Live 570-cohort CG TVaR-99 verification gate skipped "
           "via FORGE_SKIP_CG_TVAR_LIVE_GATE=1 (opt-out for slow CI)",
)
def test_cg_tvar_99_matches_monolithic_within_0_1pct_on_live_book() -> None:
    """Verification gate (plan headline): CG TVaR-99 within 0.1% of
    monolithic TVaR-99 on the live 570-cohort book at the budget
    triple recorded in the artifact.

    The 0.1% bound is tight enough that any drift between the CG
    Lagrangian aggregation and the monolithic constraint encoding
    will surface immediately. The two formulations are mathematically
    equivalent for the per-cohort TVaR-99 scalar (the linear capital
    constraint Σ_c risk_coeff_tvar[c] × LOSS_FACTOR[a_c] ≤ B is
    identical regardless of whether you encode it as a single MILP
    constraint or as the L-shaped aggregated cut the CG loop uses),
    so the residual gap is driven by the Lagrangian subgradient's
    step-size finiteness and the CG's argmax projection vs the
    monolithic's CBC branch-and-bound.
    """
    cohorts = _load_live_book_cohorts()
    if cohorts is None:
        pytest.skip(
            "artifacts/portfolio_optimization.json missing or lacks "
            "loss_scenarios; run "
            "`python -m scripts.precompute_portfolio_optimization` "
            "to regenerate"
        )

    # Use the artifact's own budget triple so we're comparing against
    # the same constraint regime the production solve sees.
    artifact = json.loads(
        (Path("artifacts") / "portfolio_optimization.json").read_text()
    )
    budgets = artifact["budgets"]
    capital_budget = float(budgets["capital_budget"])
    max_nonrenew_pct = float(budgets["max_nonrenew_pct"])
    cession_budget = float(budgets["cession_budget"])

    mono = solve(
        cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        risk_measure="tvar_99",
    )
    cg = solve_cg(
        cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        risk_measure="tvar_99",
    )

    assert mono["status"] != "Infeasible", (
        "monolithic should solve to optimal at the artifact's own "
        f"budget triple; got status={mono['status']}"
    )
    assert cg["status"] != "Infeasible", (
        f"CG infeasible at the live budget triple; "
        f"capital_used={cg.get('capital_used'):.0f} "
        f"capital_budget={capital_budget:.0f} "
        f"iters={cg.get('iterations')}"
    )

    mono_obj = float(mono["objective"])
    cg_obj = float(cg["objective_value"])
    rel_gap = abs(cg_obj - mono_obj) / max(abs(mono_obj), 1.0)
    assert rel_gap <= 0.001, (
        f"CG TVaR-99 objective {cg_obj:,.2f} not within 0.1% of "
        f"monolithic {mono_obj:,.2f} (rel_gap={rel_gap:.4%}, "
        f"cg_iters={cg.get('iterations')}, "
        f"cg_capital={cg.get('capital_used'):,.0f}, "
        f"mono_solver_mode={mono.get('solver_mode')})"
    )
