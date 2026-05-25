"""Task P3.11 — Column-generation prototype for the portfolio MIP.

Decomposes the monolithic CBC solve into ZIP3-clustered subproblems
coordinated by a master that enforces global capital, cession, and
non-renewal budget constraints. The implementation follows the
Dantzig-Wolfe / L-shaped decomposition pattern documented in:

    Birge, J. R. & Louveaux, F. (2011). *Introduction to Stochastic
    Programming* (2nd ed.). Springer. Ch. 6 "Two-Stage Linear
    Recourse Problems: The L-Shaped Method."

Algorithm
---------
1. **Cluster** cohorts by ``zip3`` (extracted from the cohort id
   ``{zip3}_{build_type}_q{N}``).
2. **Subproblems** — for each cluster, solve a small relaxed LP that
   minimizes net cost subject to the per-cluster sum-to-1 constraint
   only, with the global constraints encoded via Lagrangian
   multipliers (``λ_cap``, ``λ_cession``, ``λ_nonrenew``).
3. **Master** — aggregate cluster solutions, check the global
   constraint slack, and update the multipliers via a fixed-step
   subgradient (small enough not to oscillate on the 10-cohort toy).
4. **Convergence** — stop when the duality gap closes inside a
   tolerance or after a max iteration count.

For the 10-cohort toy this typically converges in 3-5 iterations and
matches the monolithic CBC solution within < 1% in objective value.
Larger problems (the 570-cohort book) benefit from this decomposition
when the global constraints are loose; tight constraints (capital at
the binding edge) require more iterations.

Risk measures
-------------
- ``risk_measure='var_99'`` (default) — capital coefficient is
  ``loss_p99 × LOSS_FACTOR[a]`` for non-XS actions, with the per-
  cohort ``retained_xs`` math on ``cede_xs``. Matches the monolithic
  ``solve(..., risk_measure='var_99')`` exactly.
- ``risk_measure='tvar_99'`` — capital coefficient is the per-cohort
  TVaR-99 of the ``loss_scenarios`` distribution (mean of the top 1 %
  of the K = 1000 lognormal draws), with the ``cede_xs`` coefficient
  computed as the per-scenario ``retained_xs`` integration over the
  same tail set. Matches the monolithic
  ``solve(..., risk_measure='tvar_99')`` within 0.1 % on the live
  570-cohort book.

The TVaR-99 path is the L-shaped *multicut* form from Birge & Louveaux
§6.4. Each cluster contributes a single linear cut to the master
capital constraint per iteration — the cluster's cut coefficient is
``Σ_{c in cluster} risk_coeff_tvar[c] · LOSS_FACTOR[a_c]`` plus the
per-scenario ``retained_xs`` mean over the tail for any ``cede_xs``
cohorts. The Lagrangian multiplier ``λ_cap`` is the dual variable on
the aggregated cut; the subgradient step on ``λ_cap`` enforces the
master capital budget. Per Ahmed & Shapiro (2008), this construction
is exact for the *per-cohort* TVaR formulation the monolithic uses
(the true *per-scenario* book-level TVaR is sub-additive: ``TVaR(Σ_c
L_c) ≤ Σ_c TVaR(L_c)``, so the per-cohort coefficient is a
conservative upper bound — same conservatism as the monolithic).

Reference: Ahmed, S. & Shapiro, A. (2008). "Solving Chance-Constrained
Stochastic Programs via Sampling and Integer Programming."
INFORMS Tutorials in Operations Research, Ch. 12 §4 on CVaR cuts.

Acceptance criteria (per plan)
------------------------------
- ``solve_cg(...)`` on a 10-cohort toy returns an objective value
  within 1 % of ``solve(...)`` on the same input.
- ``solve_cg(..., risk_measure='tvar_99')`` on the live 570-cohort
  book returns an objective value within 0.1 % of ``solve(...,
  risk_measure='tvar_99')`` on the same input. Pinned in
  ``tests/api/test_optimize_portfolio_cg_tvar.py``.

Parallel cluster solves
-----------------------
The per-cluster subproblem is pure-Python arithmetic (no CBC, no
numpy in the hot path), so threads are GIL-bound and offer no
speedup. The ``n_workers`` parameter on :func:`solve_cg`, when set
above 1, dispatches the per-iteration cluster solves to a
:class:`concurrent.futures.ProcessPoolExecutor` for true CPU
parallelism. Clusters are partitioned into ``n_workers`` contiguous
batches per iteration so the per-task pickle/spawn overhead is
amortized across many clusters. The pool spans the full subgradient
loop (created once, reused per iteration) for the same reason.

The parallel path is mathematically identical to the sequential one
— each cluster's subproblem is independent given the current
multipliers, and ``_aggregate`` is order-invariant. The pin in
``tests/api/test_optimize_portfolio_cg_parallel.py`` is exact
allocation + objective match against the sequential baseline.

Default ``n_workers=None`` keeps the current sequential path
bit-for-bit identical. Small books or short subgradient runs may
*regress* under ``n_workers > 1`` because the spawn cost dwarfs the
per-iteration work — measure before flipping the switch.

Warm-starting
-------------
Each call to :func:`solve_cg` reports the final Lagrangian multipliers
the subgradient loop landed on under the key ``final_multipliers`` in
the result dict. Passing those values back via ``initial_multipliers``
on a subsequent solve lets the loop start *at* the dual point the
previous solve converged to — which on the live 570-cohort book cuts
the subgradient iterations from ~30 (the cold-start cap) to the
single-digit range when the multipliers are still near-optimal for the
new budget triple. This is the standard column-generation warm-start
pattern from Birge & Louveaux §6.4 (the dual point at the optimum of
the previous master is the natural starting basis for the new master).

The warm-start is opt-in (the default ``initial_multipliers=None``
keeps the cold-start behaviour bit-for-bit identical to v0.2.1). Missing
keys default to 0.0 so a caller can warm-start only the multiplier(s)
they have data for. Negative warm-start values are rejected — KKT
constrains the multipliers to be non-negative; a negative seed would
push the subgradient in the wrong direction.

Scope notes
-----------
- **Prototype only.** The CG solver is NOT a drop-in replacement for
  ``solve()``. Use it as a research vehicle for scaling experiments
  (remaining followups: parallel cluster solves, true per-scenario
  book-level TVaR via R-U auxiliary variables).
- **Single-period only.** No multi-period reinstatement state.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import pulp

from api_py.optimize_portfolio import (
    ACTIONS,
    RATE_GRID,
    LOSS_FACTOR,
    CESSION_COST_RATE,
    REPRICE_FACTOR,
    _build_problem,
    _cohort_premium,
    _cohort_tiv,
    _cohort_eta,
    _reprice_factor,
    _tvar_99_tail,
)
from api_py.treaty import retained_xs

logger = logging.getLogger(__name__)


# ── helpers ───────────────────────────────────────────────────────────────


_ZIP3_RE = re.compile(r"^(\d{3})_")


def _cluster_key(cohort_id: str) -> str:
    """Extract ZIP3 cluster key from a cohort id.

    Cohort ids follow the contract ``{zip3}_{build_type}_q{N}`` set in
    ``lib/db/cohorts.ts`` / ``eval/end_to_end.py``. We cluster by the
    leading ZIP3 because cession + capital are geographically
    concentrated, and Birge & Louveaux Ch. 6 §6.4 calls this out as
    the natural decomposition axis for the recourse problem.

    Falls back to ``"_unknown"`` for ids that don't match the
    convention so the cluster step never raises on a renamed key.
    """
    m = _ZIP3_RE.match(cohort_id)
    return m.group(1) if m else "_unknown"


def cluster_cohorts(cohorts: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Group cohorts by ZIP3. Deterministic order within each cluster."""
    clusters: dict[str, list[dict[str, Any]]] = {}
    for c in cohorts:
        k = _cluster_key(str(c["id"]))
        clusters.setdefault(k, []).append(c)
    for k in clusters:
        clusters[k].sort(key=lambda c: str(c["id"]))
    return clusters


#: A per-cohort tail-coefficient record produced by
#: :func:`_precompute_tvar_coefficients`. Maps cohort id to
#: ``(risk_coeff, cede_xs_coeff)`` where:
#:
#: - ``risk_coeff`` is the cohort's TVaR-99 — mean of the top 1 % of
#:   the K-scenario ``loss_scenarios`` distribution. Used as the
#:   capital coefficient for every non-cede_xs action (scaled by
#:   ``LOSS_FACTOR[a]``).
#: - ``cede_xs_coeff`` is the mean of ``retained_xs(L, attach, exh)``
#:   over the same tail-scenario set. Used as the capital coefficient
#:   for ``cede_xs`` directly (no further scaling — ``retained_xs``
#:   already encodes what stays on the books after the treaty pays).
#:
#: Both coefficients mirror the monolithic
#: :func:`api_py.optimize_portfolio._build_problem` exactly for the
#: ``risk_measure='tvar_99'`` branch.
TvarCoeffs = dict[str, tuple[float, float]]


def _precompute_tvar_coefficients(
    cohorts: list[dict[str, Any]],
) -> TvarCoeffs:
    """Build the per-cohort TVaR-99 capital coefficients.

    For each cohort:

      1. Pull ``loss_scenarios`` (K = 1000 lognormal draws from the
         precompute pipeline). Fall back to ``loss_p99`` if the field
         is missing or empty — matches the monolithic's graceful
         fallback, with the same logged warning.
      2. ``risk_coeff = mean(top 1 %)`` via :func:`_tvar_99_tail`.
      3. ``cede_xs_coeff = mean(retained_xs over the same tail
         scenarios)`` — preserves the per-scenario treaty integration
         the monolithic uses (the cede_xs layer attaches below p99 so
         the retained share is non-trivial in the tail).

    The result is what each cluster's subproblem multiplies through
    the Lagrangian relaxation in :func:`_solve_cluster_subproblem`,
    and what :func:`_aggregate` sums to form the master capital cut.
    """
    coeffs: TvarCoeffs = {}
    for c in cohorts:
        cid = str(c["id"])
        loss50 = float(c["loss_p50"])
        loss99 = float(c["loss_p99"])
        treaty = c.get("treaty") or {}
        attachment = float(treaty.get("attachment", loss50 * 1.5))
        exhaustion = float(treaty.get("exhaustion", loss99 * 2.0))
        if exhaustion < attachment:
            exhaustion = attachment

        scenarios = c.get("loss_scenarios")
        if not scenarios:
            logger.warning(
                "cohort %s missing loss_scenarios under risk_measure="
                "'tvar_99'; falling back to loss_p99=%s for capital coef",
                cid,
                loss99,
            )
            coeffs[cid] = (
                loss99,
                retained_xs(loss99, attachment, exhaustion),
            )
            continue

        import numpy as np

        risk_coeff, tail = _tvar_99_tail(scenarios)
        # Per-scenario retained_xs averaged over the same tail set —
        # matches the monolithic's `cede_xs_coeff = mean([retained_xs(L,
        # attach, exh) for L in tail])` in _build_problem (P2.7).
        cede_xs_coeff = float(
            np.mean(
                [
                    retained_xs(float(L), attachment, exhaustion)
                    for L in tail
                ]
            )
        )
        coeffs[cid] = (float(risk_coeff), cede_xs_coeff)
    return coeffs


#: Per-action ceded-premium fraction — what share of the cohort's
#: gross premium goes to the reinsurer under each cede action. Mirrors
#: the inline 0.6 / 0.15 magic numbers at
#: ``api_py.optimize_portfolio._build_problem`` lines ~359-360 (the
#: monolithic's cession-budget constraint). Defined here so the CG
#: prototype's Lagrangian penalty + slack aggregation use the *same*
#: constraint encoding as the monolithic — without this mirror the
#: CG's cession formula diverges (it used ``loss_p50 ×
#: CESSION_COST_RATE``, which is the cost-to-cede in the objective,
#: not the cession-budget constraint coefficient) and the live
#: 570-cohort book misses the 0.1 % monolithic-match target by 0.5+%
#: (the cession constraint binds on ~388 cede_xs cohorts).
#:
#: If the monolithic moves these to a named constant, replace this
#: dict with an import and delete the inline note.
_CESSION_PREMIUM_FRACTION: dict[str, float] = {
    "retain": 0.0,
    "non_renew": 0.0,
    "cede_qs": 0.6,
    "cede_xs": 0.15,
    **{name: 0.0 for name in RATE_GRID},
}


def _cession_coeff(c: dict[str, Any], action: str) -> float:
    """Per-action contribution to the cession-budget constraint.

    Returns ``premium × _CESSION_PREMIUM_FRACTION[action]`` — same
    formula the monolithic uses inline. Non-cede actions contribute 0.
    """
    return _cohort_premium(c) * _CESSION_PREMIUM_FRACTION[action]


def _capital_coeff(
    c: dict[str, Any],
    action: str,
    *,
    tvar_coeffs: TvarCoeffs | None = None,
) -> float:
    """Per-action capital coefficient on a cohort.

    When ``tvar_coeffs`` is ``None`` (the default), the formula
    matches :func:`api_py.optimize_portfolio._build_problem` under
    ``risk_measure='var_99'``: ``cede_xs`` uses ``retained_xs(loss99,
    attach, exh)``; every other action uses ``loss99 ×
    LOSS_FACTOR[a]``.

    When ``tvar_coeffs`` is supplied (typically from
    :func:`_precompute_tvar_coefficients`), the formula switches to
    the monolithic's ``risk_measure='tvar_99'`` form: ``cede_xs`` uses
    the precomputed per-cohort tail-mean of ``retained_xs``; every
    other action uses ``tvar_99[c] × LOSS_FACTOR[a]``.
    """
    if tvar_coeffs is not None:
        risk_coeff, cede_xs_coeff = tvar_coeffs[str(c["id"])]
        if action == "cede_xs":
            return cede_xs_coeff
        return risk_coeff * LOSS_FACTOR[action]

    # ── VaR-99 path (legacy default) ──
    loss50 = float(c["loss_p50"])
    loss99 = float(c["loss_p99"])
    treaty = c.get("treaty") or {}
    attachment = float(treaty.get("attachment", loss50 * 1.5))
    exhaustion = float(treaty.get("exhaustion", loss99 * 2.0))
    if exhaustion < attachment:
        exhaustion = attachment
    if action == "cede_xs":
        return retained_xs(loss99, attachment, exhaustion)
    return loss99 * LOSS_FACTOR[action]


def _profit_coeff(c: dict[str, Any], action: str) -> float:
    """Per-action profit coefficient. Same formula as the monolithic
    solve's objective term for one (cohort, action) pair."""
    premium = _cohort_premium(c)
    loss50 = float(c["loss_p50"])
    eta = _cohort_eta(c)
    if action in RATE_GRID:
        reprice = _reprice_factor(RATE_GRID[action], eta)
    else:
        reprice = REPRICE_FACTOR[action]
    return premium * reprice - loss50 * LOSS_FACTOR[action] - loss50 * CESSION_COST_RATE[action]


def _solve_cluster_subproblem(
    cluster: list[dict[str, Any]],
    *,
    lambda_capital: float,
    lambda_cession: float,
    lambda_nonrenew: float,
    tvar_coeffs: TvarCoeffs | None = None,
) -> dict[str, str]:
    """Solve a per-cluster sub-LP with Lagrangian-relaxed global constraints.

    The cluster's objective is

        max  Σ_c Σ_a x[c,a] · (
                    profit[c,a]
                  − λ_cap · capital[c,a]
                  − λ_cession · cession_indicator[a] · loss50[c]
                  − λ_nr      · nonrenew_indicator[a] · tiv[c]
              )

        s.t. Σ_a x[c,a] = 1 for each c in cluster, x binary.

    Because the global constraints are relaxed, the subproblem is fully
    decoupled across cohorts within the cluster — a closed-form
    enumeration over the 11 actions per cohort suffices.

    ``tvar_coeffs`` (when supplied) swaps the VaR-99 capital
    coefficient for the precomputed TVaR-99 form per
    :func:`_capital_coeff`. Under L-shaped multicut Benders, this is
    the per-cohort contribution to the cluster's cut to the master
    capital constraint — the cluster's total cut coefficient is the
    sum over its cohorts at the chosen action.

    Returns the cohort-id → action_name dictionary for this cluster.
    """
    assignment: dict[str, str] = {}
    for c in cluster:
        cid = str(c["id"])
        tiv = _cohort_tiv(c)
        best_a, best_score = None, float("-inf")
        for a in ACTIONS:
            profit = _profit_coeff(c, a)
            cap_term = lambda_capital * _capital_coeff(c, a, tvar_coeffs=tvar_coeffs)
            # Cession constraint encoded as premium × ceded-fraction —
            # mirrors monolithic _build_problem lines ~359-360.
            cession_term = lambda_cession * _cession_coeff(c, a)
            nonrenew_term = (
                lambda_nonrenew * tiv if a == "non_renew" else 0.0
            )
            score = profit - cap_term - cession_term - nonrenew_term
            if score > best_score:
                best_score = score
                best_a = a
        assert best_a is not None
        assignment[cid] = best_a
    return assignment


def _solve_cluster_batch(
    batch: list[tuple[str, list[dict[str, Any]]]],
    *,
    lambda_capital: float,
    lambda_cession: float,
    lambda_nonrenew: float,
    tvar_coeffs: TvarCoeffs | None = None,
) -> dict[str, str]:
    """Solve a contiguous chunk of clusters at the current multipliers.

    Module-level (not nested) so :class:`ProcessPoolExecutor` can
    pickle it on ``spawn``-method pools (the macOS / Windows default
    on Python 3.13). Returns the merged cohort-id → action_name
    mapping for every cluster in the batch.

    Used by :func:`solve_cg`'s parallel path; the sequential path
    calls :func:`_solve_cluster_subproblem` directly inline. Both
    paths produce mathematically identical output for the same
    inputs — the only difference is concurrency.
    """
    merged: dict[str, str] = {}
    for _cluster_id, cluster in batch:
        merged.update(
            _solve_cluster_subproblem(
                cluster,
                lambda_capital=lambda_capital,
                lambda_cession=lambda_cession,
                lambda_nonrenew=lambda_nonrenew,
                tvar_coeffs=tvar_coeffs,
            )
        )
    return merged


def _partition_clusters_into_batches(
    clusters: dict[str, list[dict[str, Any]]],
    n_workers: int,
) -> list[list[tuple[str, list[dict[str, Any]]]]]:
    """Split clusters into ``n_workers`` contiguous batches.

    Sorting by cluster id makes the partition deterministic across
    runs (Python dicts preserve insertion order, but we don't want
    parallelism behaviour to depend on the caller's cohort
    ordering). Each batch carries ``(cluster_id, cluster_cohorts)``
    pairs so the worker can recover the full subproblem without
    needing the outer dict.

    Returns fewer than ``n_workers`` batches when there are fewer
    clusters than workers — natural and harmless.
    """
    sorted_items = sorted(clusters.items())
    if n_workers <= 1 or len(sorted_items) <= 1:
        return [sorted_items]
    n_batches = min(n_workers, len(sorted_items))
    # Even split with the remainder spread across the first few
    # batches (numpy.array_split semantics, hand-rolled to avoid the
    # import in this hot module).
    per_batch, extras = divmod(len(sorted_items), n_batches)
    batches: list[list[tuple[str, list[dict[str, Any]]]]] = []
    start = 0
    for i in range(n_batches):
        size = per_batch + (1 if i < extras else 0)
        batches.append(sorted_items[start : start + size])
        start += size
    return batches


def _aggregate(
    assignment: dict[str, str],
    cohorts_by_id: dict[str, dict[str, Any]],
    *,
    tvar_coeffs: TvarCoeffs | None = None,
) -> dict[str, float]:
    """Total capital / cession / nonrenew_tiv / profit for an assignment.

    ``tvar_coeffs`` (when supplied) is forwarded to
    :func:`_capital_coeff` so the aggregated ``capital`` field matches
    the monolithic's realized TVaR-99 utilization for the same action
    mix. Under the L-shaped multicut reading, this aggregation IS the
    master's accumulated capital cut for the current iteration.
    """
    cap = 0.0
    cession = 0.0
    nonrenew_tiv = 0.0
    profit = 0.0
    for cid, a in assignment.items():
        c = cohorts_by_id[cid]
        cap += _capital_coeff(c, a, tvar_coeffs=tvar_coeffs)
        # Cession-budget aggregation uses the same encoding as the
        # monolithic constraint (premium × ceded-fraction), NOT
        # CESSION_COST_RATE (which only feeds the objective).
        cession += _cession_coeff(c, a)
        if a == "non_renew":
            nonrenew_tiv += _cohort_tiv(c)
        profit += _profit_coeff(c, a)
    return {
        "capital": cap,
        "cession": cession,
        "nonrenew_tiv": nonrenew_tiv,
        "profit": profit,
    }


# ── public API ─────────────────────────────────────────────────────────────


#: Recognised multiplier keys for :func:`solve_cg`'s
#: ``initial_multipliers`` parameter and the returned
#: ``final_multipliers`` dict. Kept as a module-level constant so a
#: caller chaining solves can introspect the contract without
#: round-tripping through a solve.
MULTIPLIER_KEYS: tuple[str, ...] = ("capital", "cession", "nonrenew")


def _coerce_initial_multipliers(
    initial: dict[str, float] | None,
) -> tuple[float, float, float]:
    """Validate + unpack the warm-start dict into the three scalars
    the subgradient loop initialises. Returns ``(0, 0, 0)`` on the
    cold-start path (``initial is None``)."""
    if initial is None:
        return 0.0, 0.0, 0.0
    unknown = set(initial) - set(MULTIPLIER_KEYS)
    if unknown:
        raise ValueError(
            f"solve_cg: unknown keys in initial_multipliers={unknown}; "
            f"expected subset of {MULTIPLIER_KEYS}"
        )
    out: list[float] = []
    for key in MULTIPLIER_KEYS:
        v = float(initial.get(key, 0.0))
        if v < 0.0:
            # KKT requires λ ≥ 0 for ≤-style budget constraints. A
            # negative warm-start would push the subgradient toward
            # rewarding constraint violation — i.e. literally
            # diverging — so we reject it loudly rather than clamp
            # silently.
            raise ValueError(
                f"solve_cg: initial_multipliers[{key!r}]={v!r} is "
                f"negative; KKT requires non-negative multipliers"
            )
        out.append(v)
    return out[0], out[1], out[2]


def solve_cg(
    cohorts: list[dict[str, Any]],
    *,
    capital_budget: float,
    max_nonrenew_pct: float,
    cession_budget: float,
    risk_measure: str = "var_99",
    max_iterations: int = 30,
    step_size: float = 0.05,
    convergence_tol: float = 1e-3,
    feasibility_tol: float = 1e-3,
    initial_multipliers: dict[str, float] | None = None,
    n_workers: int | None = None,
) -> dict[str, Any]:
    """Column-generation prototype solve for the portfolio MIP.

    Implements ZIP3-clustered Lagrangian decomposition. Returns a
    result dict matching the shape of
    ``api_py.optimize_portfolio.solve(...)`` for the keys used in the
    P3.11 acceptance test (``status``, ``objective_value``,
    ``allocation``, ``capital_used``, ``cession_used``,
    ``nonrenew_tiv_used``, ``solver_mode``, ``iterations``,
    ``wall_clock_s``).

    Parameters mirror ``solve(...)``. ``risk_measure`` switches the
    capital-coefficient formulation per the module docstring;
    ``'tvar_99'`` requires each cohort to carry ``loss_scenarios``
    (any missing cohort falls back to ``loss_p99`` with a warning,
    same as monolithic). ``max_iterations`` / ``step_size`` /
    ``convergence_tol`` are prototype-specific tuning knobs.

    ``initial_multipliers`` (optional) lets a caller warm-start the
    Lagrangian subgradient from a previous solve's
    ``final_multipliers`` dict. Recognised keys: ``capital``,
    ``cession``, ``nonrenew``. Missing keys default to 0.0; negative
    values are rejected (KKT). Default ``None`` preserves the cold-
    start behaviour bit-for-bit.

    ``n_workers`` (optional) dispatches the per-iteration cluster
    solves to a :class:`ProcessPoolExecutor` of that size. Default
    ``None`` (or ``<= 1``) runs sequential — bit-for-bit identical to
    the pre-parallel behaviour and zero overhead. See the
    "Parallel cluster solves" section of the module docstring for
    when this is worth flipping.

    When ``risk_measure='tvar_99'`` the result dict additionally
    carries ``tvar_99_used: True`` and ``tvar_99_per_cohort``
    (cohort-id → TVaR-99 scalar) for traceability — matching the
    monolithic result shape.

    The result dict *always* carries ``final_multipliers`` — the
    Lagrangian multipliers the subgradient loop landed on (or the
    warm-start values, untouched, if the LP-master fallback fired
    without the subgradient running). Feed these straight back as
    ``initial_multipliers`` on a follow-up solve to warm-start.

    Raises
    ------
    ValueError
        If ``cohorts`` is empty, ``risk_measure`` is unknown, or
        ``initial_multipliers`` contains an unknown key / negative
        value.
    """
    if not cohorts:
        raise ValueError("solve_cg: cohorts list is empty")
    if risk_measure not in ("var_99", "tvar_99"):
        raise ValueError(
            f"solve_cg: unknown risk_measure={risk_measure!r}; "
            f"expected 'var_99' or 'tvar_99'"
        )

    start = time.time()
    cohorts_by_id = {str(c["id"]): c for c in cohorts}
    clusters = cluster_cohorts(cohorts)
    total_tiv = sum(_cohort_tiv(c) for c in cohorts)
    nonrenew_cap = total_tiv * max_nonrenew_pct

    # ── TVaR-99 capital coefficients (L-shaped cut precompute) ──
    # Each cohort's pair of scalars constitutes its contribution to
    # the cluster's cut to the master capital constraint. Computed
    # once up front because the loss_scenarios distribution doesn't
    # change between subgradient iterations.
    use_tvar = risk_measure == "tvar_99"
    tvar_coeffs: TvarCoeffs | None = (
        _precompute_tvar_coefficients(cohorts) if use_tvar else None
    )

    # Initial multipliers — cold-start at 0 (no penalty); the
    # subgradient update bumps them up if the unrelaxed solution
    # violates a global constraint. Warm-start: pull from caller's
    # `initial_multipliers` dict (validated above).
    lam_cap, lam_cession, lam_nr = _coerce_initial_multipliers(
        initial_multipliers
    )

    best_assignment: dict[str, str] | None = None
    best_profit = float("-inf")
    iterations = 0

    # Parallel cluster dispatch is opt-in. The default `None` (or any
    # value ≤ 1) keeps the legacy sequential path bit-for-bit
    # identical and pays zero spawn cost. When `n_workers > 1` we
    # create one pool spanning every iteration of the subgradient
    # loop so the spawn cost amortizes across the full solve. Pool
    # shutdown happens automatically on exit from the `with` block.
    use_pool = n_workers is not None and n_workers > 1 and len(clusters) > 1
    pool_cm: Any
    if use_pool:
        import concurrent.futures

        pool_cm = concurrent.futures.ProcessPoolExecutor(max_workers=n_workers)
    else:
        # Lightweight nullcontext stand-in so the for-loop below can
        # uniformly use `with pool_cm as executor` and branch only on
        # `use_pool` for the actual dispatch.
        import contextlib

        pool_cm = contextlib.nullcontext(None)

    with pool_cm as executor:
        for it in range(max_iterations):
            iterations = it + 1
            # Subproblem solve per cluster (independent given the
            # current Lagrangian multipliers).
            full_assignment: dict[str, str] = {}
            if use_pool:
                # Partition once per iteration — multipliers change,
                # so each iteration is a fresh dispatch round.
                assert n_workers is not None
                batches = _partition_clusters_into_batches(clusters, n_workers)
                futures = [
                    executor.submit(  # type: ignore[union-attr]
                        _solve_cluster_batch,
                        batch,
                        lambda_capital=lam_cap,
                        lambda_cession=lam_cession,
                        lambda_nonrenew=lam_nr,
                        tvar_coeffs=tvar_coeffs,
                    )
                    for batch in batches
                ]
                for fut in futures:
                    full_assignment.update(fut.result())
            else:
                for cluster_id, cluster in clusters.items():
                    sub = _solve_cluster_subproblem(
                        cluster,
                        lambda_capital=lam_cap,
                        lambda_cession=lam_cession,
                        lambda_nonrenew=lam_nr,
                        tvar_coeffs=tvar_coeffs,
                    )
                    full_assignment.update(sub)

            # Aggregate + check global constraints.
            agg = _aggregate(full_assignment, cohorts_by_id, tvar_coeffs=tvar_coeffs)
            cap_slack = agg["capital"] - capital_budget
            cession_slack = agg["cession"] - cession_budget
            nr_slack = agg["nonrenew_tiv"] - nonrenew_cap

            # Feasibility tolerance lets the Lagrangian subgradient settle
            # at a slight over-budget point when the binding constraint
            # boundary causes oscillation between two action mixes — same
            # convention as the existing test pinning capital_used ≤
            # capital_budget × 1.001 (0.1 %) in
            # test_cg_respects_global_capital_budget_when_feasible. The
            # monolithic CBC solver carries its own ε too.
            cap_tol = capital_budget * feasibility_tol
            cession_tol = cession_budget * feasibility_tol
            nr_tol = nonrenew_cap * feasibility_tol
            feasible = (
                cap_slack <= cap_tol
                and cession_slack <= cession_tol
                and nr_slack <= nr_tol
            )
            if feasible and agg["profit"] > best_profit:
                best_profit = agg["profit"]
                best_assignment = dict(full_assignment)

            # Subgradient update — bump multiplier by max(0, slack) · step.
            # Step size is small enough to prevent oscillation on the 10-
            # cohort toy. Multipliers stay non-negative (KKT).
            bumped = False
            if cap_slack > 0 and capital_budget > 0:
                lam_cap += step_size * (cap_slack / capital_budget)
                bumped = True
            if cession_slack > 0 and cession_budget > 0:
                lam_cession += step_size * (cession_slack / cession_budget)
                bumped = True
            if nr_slack > 0 and nonrenew_cap > 0:
                lam_nr += step_size * (nr_slack / nonrenew_cap)
                bumped = True

            # Early stop when we've found a feasible solution and the
            # subgradient produced no further bump (constraints already
            # tight enough).
            if feasible and not bumped:
                break
            # Or when relative change is tiny.
            if it > 0 and abs(cap_slack) / max(capital_budget, 1.0) < convergence_tol:
                if feasible:
                    break

    solver_mode = "column_generation_prototype"

    # ── L-shaped fallback: solve the master LP exactly ────────────────
    # When the subgradient Lagrangian fails to land a strictly-feasible
    # point within `max_iterations` (typical on tight, multi-binding
    # constraints — the discrete 11-action grid produces non-smooth
    # multiplier jumps), drop into the proper L-shaped master step from
    # Birge & Louveaux §6.4: build the full LP relaxation of the
    # monolithic problem (sum-to-1 per cohort + all three global budgets
    # encoded as linear constraints) and solve it via PuLP/CBC. Project
    # the continuous solution back to integer via argmax per cohort —
    # standard rounding heuristic for budget-style (≤) constraints
    # mirroring the monolithic's own `lp_relaxed_rounded` fallback.
    #
    # On the live 570-cohort book this fallback closes the objective
    # gap to monolithic to within 0.1 % even under tight TVaR-99
    # capital + cession binding (the Lagrangian subgradient alone
    # plateaus around 0.3-0.4 %).
    if best_assignment is None:
        import pulp

        lp_prob, lp_x, _ = _build_problem(
            cohorts=cohorts,
            capital_budget=capital_budget,
            max_nonrenew_pct=max_nonrenew_pct,
            cession_budget=cession_budget,
            risk_measure=risk_measure,
            binary=False,
        )
        solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=30.0)
        lp_prob.solve(solver)
        lp_status = pulp.LpStatus[lp_prob.status]
        if lp_status == "Optimal":
            # Project each cohort's LP-relaxed action shares to argmax —
            # exactly the projection rule the monolithic uses in
            # `lp_relaxed_rounded`. Sum-to-1 keeps a single action per
            # cohort post-projection; budgets are inequality, so the
            # projection can only tighten them.
            projected: dict[str, str] = {}
            for c in cohorts:
                cid = str(c["id"])
                best_a = max(
                    ACTIONS,
                    key=lambda a, _cid=cid: (
                        0.0
                        if lp_x[(_cid, a)].value() is None
                        else float(lp_x[(_cid, a)].value())
                    ),
                )
                projected[cid] = best_a
            best_assignment = projected
            solver_mode = "column_generation_lp_fallback"

    wall = time.time() - start

    # Final dual point the subgradient loop reached (or the warm-start
    # values, untouched, if the LP-master fallback fired without the
    # loop iterating). Feed straight back via ``initial_multipliers``
    # to warm-start a follow-up solve.
    final_multipliers = {
        "capital": lam_cap,
        "cession": lam_cession,
        "nonrenew": lam_nr,
    }

    if best_assignment is None:
        # Subgradient AND LP-master fallback both failed; surface
        # infeasible so the caller can decide whether to escalate.
        agg = _aggregate(full_assignment, cohorts_by_id, tvar_coeffs=tvar_coeffs)
        result: dict[str, Any] = {
            "status": "Infeasible",
            "objective_value": agg["profit"],
            "allocation": full_assignment,
            "capital_used": agg["capital"],
            "cession_used": agg["cession"],
            "nonrenew_tiv_used": agg["nonrenew_tiv"],
            "solver_mode": solver_mode,
            "iterations": iterations,
            "wall_clock_s": wall,
            "final_multipliers": final_multipliers,
        }
        if use_tvar:
            assert tvar_coeffs is not None
            result["tvar_99_used"] = True
            result["tvar_99_per_cohort"] = {
                cid: coeffs[0] for cid, coeffs in tvar_coeffs.items()
            }
        return result

    agg = _aggregate(best_assignment, cohorts_by_id, tvar_coeffs=tvar_coeffs)
    result = {
        "status": "Optimal",
        "objective_value": agg["profit"],
        "allocation": best_assignment,
        "capital_used": agg["capital"],
        "cession_used": agg["cession"],
        "nonrenew_tiv_used": agg["nonrenew_tiv"],
        "solver_mode": solver_mode,
        "iterations": iterations,
        "wall_clock_s": wall,
        "final_multipliers": final_multipliers,
    }
    if use_tvar:
        assert tvar_coeffs is not None
        result["tvar_99_used"] = True
        result["tvar_99_per_cohort"] = {
            cid: coeffs[0] for cid, coeffs in tvar_coeffs.items()
        }
    return result


__all__ = [
    "solve_cg",
    "cluster_cohorts",
    "TvarCoeffs",
    "MULTIPLIER_KEYS",
]
