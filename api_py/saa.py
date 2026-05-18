"""Task P2.9 — Sample Average Approximation (SAA) with optimality-gap envelope.

Wraps ``api_py.optimize_portfolio.solve`` and runs it multiple times with
K-sized scenario samples per cohort, derived from independent seeds. The
spread of the replicated objectives is the Monte-Carlo estimate of the
K-approximation's optimality gap — i.e. *how much further would we
gain if we could solve against the true scenario distribution rather
than against K samples?*

This is an analytical / offline tool. K=1000 × n_replications=5 on the
live ~570-cohort book runs in ~3 minutes on CBC — fine for a nightly
batch and for an academic-mode persona dashboard (P2.18), but not for
the request-time path. The deterministic ``solve()`` continues to ship
in ``artifacts/portfolio_optimization.json``.

SAA semantics
-------------

For each replication ``r ∈ {0, …, n_replications-1}``:

1. Seed an RNG with ``seed + r``.
2. For each cohort, sample K scenarios:
   - If the cohort carries ``loss_scenarios``: sample K with replacement
     from it.
   - Else: synthesize K samples from a lognormal posterior whose
     median = ``loss_p50`` and 99th percentile = ``loss_p99`` (the same
     path the precompute uses, see ``scripts.precompute_portfolio_
     optimization._cohort_loss_quantiles``).
3. Build a copy of each cohort with the freshly sampled
   ``loss_scenarios`` and call ``solve(..., risk_measure='tvar_99')`` —
   this exercises the per-scenario tail integration (P2.6's TVaR-99 +
   P2.7's retained_xs).

The replicated objectives form the SAA distribution; we report the
mean, std, 95% CI half-width (the *gap envelope*), and the optimality
gap estimate ``max(objectives) − mean(objectives)`` which → 0 as K → ∞.

Both measures are reported under ``gap_envelope`` (CI half-width) and
``tightening_estimate`` (upper-bound gap). The dispatch is open — an
academic panel asking "how tight is your K approximation?" can quote
either.

Determinism
-----------

Same ``(seed, K, n_replications, cohorts)`` → identical ``objectives``
list. ``np.random.default_rng(seed + r)`` is the only stochastic input.
The deterministic-equivalent MILP itself is deterministic-ish — CBC's
branch-and-bound is internally deterministic for a fixed input
(modulo timing-dependent randomized tie-breaking, which doesn't fire
on the toy book sizes SAA tests use).
"""

from __future__ import annotations

import math
import statistics
from typing import Any

import numpy as np

from api_py.optimize_portfolio import solve

# Φ⁻¹(0.99) — the standard-normal quantile at the 99th percentile.
# Reconstructing the lognormal posterior whose median = p50 and whose
# 99th percentile = p99 gives σ = (log(p99) − log(p50)) / Φ⁻¹(0.99).
# Identical to the constant in ``scripts.precompute_portfolio_optimization``;
# we duplicate it here so SAA does not import from the scripts package
# (the scripts package depends on sqlite3 and the live DB path).
PHI_INV_99 = 2.326


def _sample_K_for_cohort(
    cohort: dict[str, Any], K: int, rng: np.random.Generator
) -> list[float]:
    """Return K loss draws for ``cohort``.

    Two paths, branching on whether the cohort carries pre-computed
    ``loss_scenarios``:

    1. **Re-sample**: cohorts carrying ``loss_scenarios`` (the P2.0
       artifact path) get K draws *with replacement* from that pool.
       The pool is typically 1000 samples and we may want K=100 / 500 /
       1000 / 5000 — with-replacement sampling lets us scale K below
       *and* above the pool size.
    2. **Synthesize**: cohorts with only the scalar (``loss_p50``,
       ``loss_p99``) quantiles synthesize a fresh lognormal posterior
       and draw K samples from it. Matches the precompute's
       ``_cohort_loss_quantiles`` math 1:1.

    Pathological zero-p50 cohorts return K zeros (matches the
    precompute's zero-TIV branch).
    """
    pool = cohort.get("loss_scenarios")
    if pool is not None and len(pool) > 0:
        arr = np.asarray(pool, dtype=float)
        idx = rng.integers(low=0, high=arr.size, size=K)
        return [float(x) for x in arr[idx]]

    # Synthesize from the (p50, p99) lognormal.
    p50 = float(cohort.get("loss_p50", 0.0))
    p99 = float(cohort.get("loss_p99", 0.0))
    if p50 <= 0.0:
        return [0.0] * K
    if p99 <= p50:
        # Degenerate / inverted quantiles — fall back to a tight lognormal
        # with σ implied by a 10% p99 lift (avoid div-by-zero or log of a
        # ratio ≤ 1 producing σ ≤ 0).
        p99 = p50 * 1.1
    mu = math.log(p50)
    sigma = (math.log(p99) - math.log(p50)) / PHI_INV_99
    scenarios = rng.lognormal(mean=mu, sigma=sigma, size=K)
    return [float(x) for x in scenarios]


def _cohorts_with_sampled_scenarios(
    cohorts: list[dict[str, Any]], K: int, rng: np.random.Generator
) -> list[dict[str, Any]]:
    """Return a shallow-copied cohort list where each cohort carries a
    freshly-sampled K-element ``loss_scenarios`` array. The originals
    are not mutated (we copy the dict per cohort)."""
    out: list[dict[str, Any]] = []
    for c in cohorts:
        c2 = dict(c)
        c2["loss_scenarios"] = _sample_K_for_cohort(c, K, rng)
        out.append(c2)
    return out


def _solve_one_replication(
    cohorts: list[dict[str, Any]],
    capital_budget: float,
    max_nonrenew_pct: float,
    cession_budget: float,
    K: int,
    rng: np.random.Generator,
    **solve_kwargs: Any,
) -> dict[str, Any]:
    """Sample K scenarios per cohort under ``rng`` and run a single
    deterministic-equivalent solve. Returns the full ``solve()`` dict.

    Factored out as a module-level function so tests can monkeypatch
    it with a stub for the gap-envelope arithmetic test (which doesn't
    care about CBC).
    """
    sampled = _cohorts_with_sampled_scenarios(cohorts, K, rng)
    # SAA forces ``risk_measure='tvar_99'`` so the sampled scenarios
    # actually drive the capital constraint (P2.6) and the per-scenario
    # retained_xs integration (P2.7). A var_99 SAA would collapse back to
    # the scalar ``loss_p99`` and ignore the sampling entirely.
    return solve(
        cohorts=sampled,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        risk_measure="tvar_99",
        **solve_kwargs,
    )


def solve_saa(
    cohorts: list[dict[str, Any]],
    capital_budget: float,
    max_nonrenew_pct: float,
    cession_budget: float,
    K: int = 1000,
    n_replications: int = 5,
    seed: int = 0,
    **solve_kwargs: Any,
) -> dict[str, Any]:
    """Run SAA with K samples per cohort, repeated n_replications times.

    Parameters
    ----------
    cohorts
        Cohort dicts as accepted by ``api_py.optimize_portfolio.solve``.
        If a cohort carries ``loss_scenarios``, SAA samples K with
        replacement from it; otherwise SAA synthesizes K draws from
        the lognormal posterior implied by ``(loss_p50, loss_p99)``.
    capital_budget, max_nonrenew_pct, cession_budget
        Forwarded to ``solve()``.
    K
        Number of scenario samples per cohort per replication. Higher K
        means a tighter approximation to the true expectation —
        empirically, ``std(objectives) ∝ 1/√K``.
    n_replications
        Number of independent SAA solves (each with its own seed-offset
        RNG). Need ≥ 2 to compute a non-trivial std / CI; ≥ 5 is the
        convention for a 95% CI half-width to be meaningful.
    seed
        Master RNG seed. Replication ``r`` uses
        ``np.random.default_rng(seed + r)``.
    **solve_kwargs
        Forwarded to ``solve()`` (e.g. ``horizon_start``,
        ``horizon_end``, ``time_limit``). ``risk_measure`` is *not*
        forwarded — SAA forces ``risk_measure='tvar_99'`` since that's
        the path that consumes the sampled scenarios.

    Returns
    -------
    dict
        ``{
            "K": int,
            "n_replications": int,
            "objectives": list[float],
            "mean_objective": float,
            "std_objective": float,
            "gap_envelope": float,        # 1.96·σ/√n
            "best_actions": list[dict],   # actions[] of the highest-objective replication
            "tightening_estimate": float, # max − mean (upper-bound gap)
            "seed": int,
        }``.

    Raises
    ------
    ValueError
        If ``cohorts`` is empty or ``n_replications`` < 2.
    """
    if not cohorts:
        raise ValueError(
            "solve_saa: cohorts list is empty; cannot compute SAA "
            "envelope on a zero-cohort book"
        )
    if n_replications < 2:
        raise ValueError(
            f"solve_saa: n_replications must be ≥ 2 to estimate a "
            f"spread; got {n_replications}"
        )
    if K < 1:
        raise ValueError(f"solve_saa: K must be ≥ 1; got {K}")

    # Don't let callers override risk_measure — SAA's whole point is
    # to integrate over sampled scenarios via TVaR-99 + retained_xs.
    solve_kwargs.pop("risk_measure", None)

    objectives: list[float] = []
    best_actions: list[dict[str, Any]] = []
    best_obj = -math.inf

    for r in range(n_replications):
        rng = np.random.default_rng(seed + r)
        result = _solve_one_replication(
            cohorts=cohorts,
            capital_budget=capital_budget,
            max_nonrenew_pct=max_nonrenew_pct,
            cession_budget=cession_budget,
            K=K,
            rng=rng,
            **solve_kwargs,
        )
        obj = float(result["objective"])
        objectives.append(obj)
        if obj > best_obj:
            best_obj = obj
            best_actions = result.get("actions", [])

    mean_obj = float(statistics.fmean(objectives))
    # Sample std (ddof=1) — the canonical estimator for a finite-sample
    # mean's spread.
    std_obj = float(statistics.stdev(objectives)) if len(objectives) > 1 else 0.0
    # 95% CI half-width on the mean (z=1.96, σ/√n).
    gap_envelope = 1.96 * std_obj / math.sqrt(n_replications)
    # Upper-bound optimality gap estimate. For K → ∞ this collapses to 0
    # because every replication recovers the same true optimum.
    tightening = max(objectives) - mean_obj

    return {
        "K": K,
        "n_replications": n_replications,
        "objectives": objectives,
        "mean_objective": mean_obj,
        "std_objective": std_obj,
        "gap_envelope": gap_envelope,
        "best_actions": best_actions,
        "tightening_estimate": tightening,
        "seed": seed,
    }
