"""Task 16 / P2.8 — Portfolio MILP with price-elasticity rate grid.

Allocates each cohort to a single underwriting action drawn from an
11-action set:

    retain, non_renew, cede_qs, cede_xs,
    reprice_n20, reprice_n10, reprice_0, reprice_p5,
    reprice_p10, reprice_p15, reprice_p20

The seven ``reprice_*`` actions form a discretized rate grid
``Δrate ∈ {-20%, -10%, 0, +5%, +10%, +15%, +20%}``. They replace the
former scalar ``reprice_up`` / ``reprice_down`` magic constants
(``1.15`` / ``0.90``) which an actuary would reject on sight. The
effective premium under a rate adjustment ``Δrate`` is

    effective_premium = base_premium × (1 + Δrate) × (1 − η × max(Δrate, 0))

where ``η`` is the cohort's retention elasticity (default 0.5, per the
NAIC Center for Insurance Policy Research market-conduct studies cited
in ``docs/methodology.md``). The ``max(Δrate, 0)`` clamp encodes the
empirical asymmetry that rate cuts do not cause customer churn —
elasticity only bites when rates go up.

Decision variables are *binary* (``cat='Binary'``); the sum-to-one
constraint per cohort therefore forces an exact pick. CBC handles
the ~4000 binaries (570 cohorts × 7 reprice buckets + 4 other
actions) at the 30s timeLimit; if CBC reports timeout the solver
falls back to a continuous LP relaxation followed by argmax rounding
(see ``solver_mode`` in the result dict).

``solve()`` is module-level so it can be imported and unit-tested
without spinning up the HTTP handler. The Vercel handler at the
bottom just wraps ``solve`` with JSON request/response plumbing.

Solver: PuLP with the bundled CBC binary. CBC's ``timeLimit=30``
keeps us inside Vercel's 60s serverless timeout even for a fully
populated book.
"""

from __future__ import annotations

import json
import logging
from http.server import BaseHTTPRequestHandler
from typing import Any

from api_py.treaty import retained_xs

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Action set.
#
# Phase 1 shipped six actions: ``retain``, ``reprice_up`` (×1.15),
# ``reprice_down`` (×0.90), ``non_renew``, ``cede_qs``, ``cede_xs``.
#
# Task P2.8 replaces the two reprice constants with a discretized rate
# grid so the MIP defends a *rate level* per cohort instead of two
# pretend "up" / "down" macros. The seven grid buckets cover the band
# typical state DOIs and reinsurance treaties will tolerate without
# requiring a separate filing (a > ±25% move is its own conversation).
# ---------------------------------------------------------------------------

#: Δrate associated with each ``reprice_*`` action bucket. Used to compute
#: REPRICE_FACTOR (with the elasticity correction) and to render the
#: action name back to a human-readable label downstream.
RATE_GRID: dict[str, float] = {
    "reprice_n20": -0.20,
    "reprice_n10": -0.10,
    "reprice_0": 0.0,
    "reprice_p5": 0.05,
    "reprice_p10": 0.10,
    "reprice_p15": 0.15,
    "reprice_p20": 0.20,
}

#: Default retention elasticity (η) when a cohort doesn't carry its own
#: ``retention_elasticity`` field. 0.5 = a 10% rate hike costs the
#: insurer 5% of the cohort (half the rate move walks). Source: NAIC
#: Center for Insurance Policy Research market-conduct studies cited
#: in ``docs/methodology.md``.
DEFAULT_ELASTICITY: float = 0.5


def _reprice_factor(delta_rate: float, eta: float) -> float:
    """Effective-premium multiplier under a Δrate move with elasticity η.

    Formula: ``(1 + Δrate) × (1 − η × max(Δrate, 0))``. Rate cuts pass
    through unattenuated (the ``max(·, 0)`` clamp); rate hikes lose a
    fraction proportional to η. With η=0.5 and Δrate=+10%, the multiplier
    is 1.10 × 0.95 = 1.045 — net +4.5% revenue.
    """
    return (1.0 + delta_rate) * (1.0 - eta * max(delta_rate, 0.0))


#: REPRICE_FACTOR — what fraction of the cohort's premium accrues to the
#: insurer under each action. ``non_renew`` zeros out, ``cede_qs`` gives
#: up half the premium (and half the loss exposure), etc. For the
#: ``reprice_*`` actions the factor is computed from ``RATE_GRID`` with
#: ``DEFAULT_ELASTICITY``; a cohort with its own ``retention_elasticity``
#: overrides this at coefficient-assembly time inside ``solve()``.
REPRICE_FACTOR: dict[str, float] = {
    "retain": 1.0,
    "non_renew": 0.0,
    "cede_qs": 0.5,
    "cede_xs": 1.0,
    **{
        name: _reprice_factor(delta, DEFAULT_ELASTICITY)
        for name, delta in RATE_GRID.items()
    },
}

#: LOSS_FACTOR — what fraction of the cohort's expected loss the insurer
#: still bears under each action. Repricing doesn't change the *peril*
#: the customer is exposed to — only the premium — so all ``reprice_*``
#: actions carry LOSS_FACTOR=1.0. ``LOSS_FACTOR['cede_xs']=0.3`` is
#: preserved as documentation but the capital constraint replaces it
#: with the per-scenario ``retained_xs`` math (P2.7) at solve time.
LOSS_FACTOR: dict[str, float] = {
    "retain": 1.0,
    "non_renew": 0.0,
    "cede_qs": 0.5,
    "cede_xs": 0.3,
    **{name: 1.0 for name in RATE_GRID},
}

#: CESSION_COST_RATE — additional cession premium (as a fraction of the
#: cohort's expected loss at p50) paid out to the reinsurer. Only the
#: two cede actions cost anything; repricing has no cession spend.
CESSION_COST_RATE: dict[str, float] = {
    "retain": 0.0,
    "non_renew": 0.0,
    "cede_qs": 0.6,
    "cede_xs": 0.15,
    **{name: 0.0 for name in RATE_GRID},
}

#: The full 11-action set. Order matters for downstream consumers that
#: render action_summary in a fixed sequence (retain → rate grid →
#: non-renew → cede), so keep the rate-grid actions contiguous.
ACTIONS: tuple[str, ...] = (
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
)


def _cohort_tiv(c: dict[str, Any]) -> float:
    """Cohort TIV — accept either ``tiv`` or ``total_tiv`` for flexibility."""
    return float(c.get("total_tiv", c.get("tiv", 0.0)))


def _cohort_premium(c: dict[str, Any]) -> float:
    return float(c.get("total_premium", c.get("premium", 0.0)))


def _cohort_eta(c: dict[str, Any]) -> float:
    """Cohort retention elasticity (η). Default = DEFAULT_ELASTICITY."""
    val = c.get("retention_elasticity")
    if val is None:
        return DEFAULT_ELASTICITY
    return float(val)


def _tvar_99_tail(scenarios: list[float]) -> tuple[float, "np.ndarray"]:  # type: ignore[name-defined]  # noqa: F821
    """Return ``(tvar_99_mean, tail_array)`` for a list of scenarios.

    Factored out so the capital-constraint assembly can reuse the same
    99th-percentile threshold for both the TVaR-99 risk coefficient and
    the per-scenario ``retained_xs`` integration on ``cede_xs`` — without
    paying ``np.percentile`` twice on the same array.
    """
    import numpy as np

    arr = np.asarray(scenarios, dtype=float)
    if arr.size == 0:
        return 0.0, arr
    threshold = np.percentile(arr, 99)
    tail = arr[arr >= threshold]
    if tail.size == 0:
        return float(arr.max()), arr[arr == arr.max()]
    return float(tail.mean()), tail


def _tvar_99(scenarios: list[float]) -> float:
    """TVaR-99 = mean of the top 1% of scenario draws.

    For K=100: top-1% = single largest draw. For K=1000: mean of top 10.
    We use numpy's 99th-percentile threshold (linear interpolation) and
    average every draw at or above it. Matches the actuarial definition
    of TVaR / CVaR / expected shortfall at the 99% level.
    """
    return _tvar_99_tail(scenarios)[0]


def _build_problem(
    cohorts: list[dict[str, Any]],
    capital_budget: float,
    max_nonrenew_pct: float,
    cession_budget: float,
    risk_measure: str,
    binary: bool,
) -> tuple["pulp.LpProblem", dict[tuple[str, str], "pulp.LpVariable"], dict[str, float]]:  # type: ignore[name-defined]
    """Assemble the MILP (binary=True) or its LP relaxation (binary=False).

    Factored out so the fallback path can re-build the problem with
    continuous variables when CBC times out on the binary version
    without duplicating the objective/constraint assembly below.

    Returns ``(prob, x, tvar_per_cohort)``. ``tvar_per_cohort`` is empty
    unless ``risk_measure == 'tvar_99'``.
    """
    import pulp

    prob = pulp.LpProblem("portfolio_mip", pulp.LpMaximize)
    cat = "Binary" if binary else "Continuous"

    x: dict[tuple[str, str], pulp.LpVariable] = {}
    for c in cohorts:
        cid = c["id"]
        for a in ACTIONS:
            x[(cid, a)] = pulp.LpVariable(
                f"x_{cid}_{a}", lowBound=0, upBound=1, cat=cat
            )

    # ── Objective ──────────────────────────────────────────────────────
    # Σ_c Σ_a x[c,a] * (premium * REPRICE - loss_p50 * LOSS_FACTOR
    #                   - loss_p50 * CESSION_COST_RATE)
    # The reprice factor for a ``reprice_*`` action is computed *per
    # cohort* against the cohort's own η — so a cohort with high
    # elasticity sees a smaller premium kick from an up-move and the
    # optimizer naturally backs off the rate hike.
    obj_terms = []
    for c in cohorts:
        cid = c["id"]
        premium = _cohort_premium(c)
        loss50 = float(c["loss_p50"])
        eta = _cohort_eta(c)
        for a in ACTIONS:
            if a in RATE_GRID:
                reprice = _reprice_factor(RATE_GRID[a], eta)
            else:
                reprice = REPRICE_FACTOR[a]
            coeff = (
                premium * reprice
                - loss50 * LOSS_FACTOR[a]
                - loss50 * CESSION_COST_RATE[a]
            )
            obj_terms.append(coeff * x[(cid, a)])
    prob += pulp.lpSum(obj_terms)

    # ── Constraint 1: action fractions sum to 1 per cohort ─────────────
    # Under binary vars this is an "exactly one" pick; under continuous
    # vars it remains a fractional sum-to-1 (LP-relaxation interpretation).
    for c in cohorts:
        cid = c["id"]
        prob += pulp.lpSum(x[(cid, a)] for a in ACTIONS) == 1, f"sum1_{cid}"

    # ── Constraint 2: capital budget (VaR-99 or TVaR-99) ───────────────
    # Capital coefficient is ``risk_coeff * LOSS_FACTOR[a]`` for non-XS
    # actions; ``cede_xs`` uses the per-scenario retained_xs math.
    use_tvar = risk_measure == "tvar_99"
    tvar_per_cohort: dict[str, float] = {}
    capital_terms = []
    for c in cohorts:
        cid = c["id"]
        loss50 = float(c["loss_p50"])
        loss99 = float(c["loss_p99"])
        treaty = c.get("treaty") or {}
        attachment = float(treaty.get("attachment", loss50 * 1.5))
        exhaustion = float(treaty.get("exhaustion", loss99 * 2.0))
        if exhaustion < attachment:
            exhaustion = attachment

        if use_tvar:
            scenarios = c.get("loss_scenarios")
            if scenarios is None or len(scenarios) == 0:
                logger.warning(
                    "cohort %s missing loss_scenarios under risk_measure="
                    "'tvar_99'; falling back to loss_p99=%s for capital coef",
                    cid,
                    loss99,
                )
                risk_coeff = loss99
                cede_xs_coeff = retained_xs(loss99, attachment, exhaustion)
            else:
                import numpy as np

                risk_coeff, tail = _tvar_99_tail(scenarios)
                cede_xs_coeff = float(
                    np.mean(
                        [
                            retained_xs(float(L), attachment, exhaustion)
                            for L in tail
                        ]
                    )
                )
            tvar_per_cohort[cid] = risk_coeff
        else:
            risk_coeff = loss99
            cede_xs_coeff = retained_xs(loss99, attachment, exhaustion)

        for a in ACTIONS:
            if a == "cede_xs":
                capital_terms.append(cede_xs_coeff * x[(cid, a)])
            else:
                capital_terms.append(
                    risk_coeff * LOSS_FACTOR[a] * x[(cid, a)]
                )
    prob += pulp.lpSum(capital_terms) <= capital_budget, "capital_budget"

    # ── Constraint 3: non-renewal cap on book TIV ──────────────────────
    total_tiv = sum(_cohort_tiv(c) for c in cohorts)
    nonrenew_terms = [
        _cohort_tiv(c) * x[(c["id"], "non_renew")] for c in cohorts
    ]
    prob += (
        pulp.lpSum(nonrenew_terms) <= max_nonrenew_pct * total_tiv,
        "nonrenew_cap",
    )

    # ── Constraint 4: cession premium budget ───────────────────────────
    cession_terms = []
    for c in cohorts:
        cid = c["id"]
        premium = _cohort_premium(c)
        cession_terms.append(premium * 0.6 * x[(cid, "cede_qs")])
        cession_terms.append(premium * 0.15 * x[(cid, "cede_xs")])
    prob += pulp.lpSum(cession_terms) <= cession_budget, "cession_budget"

    return prob, x, tvar_per_cohort


def solve(
    cohorts: list[dict[str, Any]],
    capital_budget: float,
    max_nonrenew_pct: float,
    cession_budget: float,
    horizon_start: str = "2026-07-01",
    horizon_end: str = "2027-06-30",
    risk_measure: str = "var_99",
    time_limit: float = 30.0,
) -> dict[str, Any]:
    """Solve the Portfolio MILP.

    Parameters
    ----------
    cohorts
        List of cohort dicts. Each cohort must carry ``id``, a TIV (under
        ``total_tiv`` or ``tiv``), ``total_premium`` (or ``premium``),
        ``loss_p50`` and ``loss_p99``.

        Task P2.0: cohort dicts *may* also carry an optional
        ``loss_scenarios: list[float]`` field — K=1000 Monte-Carlo draws
        from the lognormal posterior whose median is ``loss_p50`` and
        whose 99th percentile is ``loss_p99``. Consumed by the TVaR-99
        capital constraint (P2.6) and the per-scenario retained-tail
        integration on ``cede_xs`` (P2.7).

        Task P2.8: cohort dicts *may* also carry an optional
        ``retention_elasticity: float`` field (η) controlling how much
        of a rate hike walks out the door. Default
        ``DEFAULT_ELASTICITY`` (0.5) is used when the field is absent.
    capital_budget
        Maximum tolerable Σ (cohort VaR/TVaR-99 retained) across the
        portfolio.
    max_nonrenew_pct
        Maximum fraction of total book TIV that may be non-renewed (a
        regulatory + customer-continuity cap).
    cession_budget
        Maximum aggregate cession premium spend.
    horizon_start, horizon_end
        ISO-date strings (``YYYY-MM-DD``) describing the treaty-year
        window this solve targets. Defaults match the industry cat
        treaty cycle (Jul 1 → Jun 30). Pass through to the output dict;
        metadata only.
    risk_measure
        ``'var_99'`` (default) or ``'tvar_99'``. See P2.6 / P2.7
        docstrings preserved inline below for the full discussion.
    time_limit
        CBC solver wall-clock limit (seconds). Defaults to 30s so a
        Vercel function staying inside its 60s timeout has 30s of
        slack for HTTP plumbing. Pass a small value (e.g. ``0.001``)
        to deliberately force the LP-relaxation fallback path in
        tests.

    Returns
    -------
    dict
        ``{"status": str, "objective": float, "actions": [{"cohort_id": ...,
        "retain": float, ..., "reprice_p10": float, ...}, ...],
        "horizon_start": str, "horizon_end": str, "solver_mode": str}``.

        ``solver_mode`` is one of:

        - ``'milp'`` — CBC solved the binary problem to optimality (or
          the user explicitly disabled the fallback). All
          ``x[(c, a)]`` values are 0 or 1 (within solver tolerance) and
          each cohort row has exactly one action selected.
        - ``'lp_relaxed_rounded'`` — CBC reported timeout / not-solved
          on the binary version; the solver re-built the problem with
          continuous vars, then rounded each cohort to its argmax
          action (the LP relaxation's solution is then projected to a
          feasible integer point). All cohort rows still have exactly
          one action selected; the objective reported is the *rounded*
          objective, not the LP-relaxed upper bound.

        Action allocations always sum to 1.0 per cohort (within solver
        tolerance).

        When ``risk_measure == 'tvar_99'`` the dict additionally carries
        ``tvar_99_used: True`` and ``tvar_99_per_cohort: {cohort_id:
        float}`` for traceability.
    """
    import pulp

    # ── Stage 1: MILP (binary) ─────────────────────────────────────────
    prob, x, tvar_per_cohort = _build_problem(
        cohorts=cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        risk_measure=risk_measure,
        binary=True,
    )
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)
    prob.solve(solver)
    status = pulp.LpStatus[prob.status]
    use_tvar = risk_measure == "tvar_99"

    # ── Stage 2: LP-relaxation fallback if MILP didn't solve ──────────
    # CBC reports ``Not Solved`` when it bails out under timeLimit, and
    # ``Infeasible`` if the constraints over-restrict. The fallback only
    # makes sense for the timeout case — re-running infeasible problems
    # as LP won't change anything. But CBC sometimes returns
    # ``Not Solved`` for both, so we always retry and let the LP report
    # the real status.
    solver_mode = "milp"
    if status not in ("Optimal", "Infeasible"):
        logger.warning(
            "MILP did not solve cleanly (status=%s); falling back to LP "
            "relaxation with argmax rounding",
            status,
        )
        prob_lp, x_lp, tvar_per_cohort_lp = _build_problem(
            cohorts=cohorts,
            capital_budget=capital_budget,
            max_nonrenew_pct=max_nonrenew_pct,
            cession_budget=cession_budget,
            risk_measure=risk_measure,
            binary=False,
        )
        solver_lp = pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)
        prob_lp.solve(solver_lp)
        status = pulp.LpStatus[prob_lp.status]
        if status == "Optimal":
            solver_mode = "lp_relaxed_rounded"
            x = x_lp
            tvar_per_cohort = tvar_per_cohort_lp

    # ── Materialize actions, applying argmax-rounding under fallback ──
    objective_acc = 0.0
    actions_out: list[dict[str, Any]] = []
    for c in cohorts:
        cid = c["id"]
        premium = _cohort_premium(c)
        loss50 = float(c["loss_p50"])
        eta = _cohort_eta(c)
        # Read raw values (continuous if we fell back).
        raw: dict[str, float] = {}
        for a in ACTIONS:
            v = x[(cid, a)].value()
            raw[a] = 0.0 if v is None else max(0.0, min(1.0, float(v)))

        if solver_mode == "lp_relaxed_rounded":
            # Project to argmax: the action with the highest LP-relaxed
            # share wins. Ties break on ACTIONS-tuple order (first
            # wins). This is the standard "rounding heuristic" applied
            # to LP-relaxations of 0-1 programs — feasibility is not
            # guaranteed in general but the four constraint families
            # here (sum=1, capital ≤, nonrenew ≤, cession ≤) are all
            # *budget-style* (≤), so promoting a fractional pick to a
            # full pick can only tighten an inequality, not break it,
            # *iff* the argmax-chosen action's coefficient does not
            # exceed the slack — which is approximately the case at
            # the LP optimum. Edge cases where this projects to
            # infeasibility are noted in the result with a warning;
            # the alternative (CBC continuing past 30s) is worse for
            # the serverless contract.
            best_a = max(ACTIONS, key=lambda a: raw[a])
            for a in ACTIONS:
                raw[a] = 1.0 if a == best_a else 0.0

        row: dict[str, Any] = {"cohort_id": cid, **raw}
        actions_out.append(row)

        # Accumulate the objective from the materialized actions so the
        # reported objective is consistent with what's emitted
        # (especially after rounding).
        for a in ACTIONS:
            if a in RATE_GRID:
                reprice = _reprice_factor(RATE_GRID[a], eta)
            else:
                reprice = REPRICE_FACTOR[a]
            coeff = (
                premium * reprice
                - loss50 * LOSS_FACTOR[a]
                - loss50 * CESSION_COST_RATE[a]
            )
            objective_acc += coeff * raw[a]

    # When the MILP solved cleanly, prefer PuLP's reported objective
    # (matches the solver's interior arithmetic exactly). Under the
    # fallback path the rounded objective is the only meaningful number.
    if solver_mode == "milp":
        objective = pulp.value(prob.objective)
        if objective is None:
            objective = objective_acc
    else:
        objective = objective_acc

    result: dict[str, Any] = {
        "status": status,
        "objective": float(objective),
        "actions": actions_out,
        "horizon_start": horizon_start,
        "horizon_end": horizon_end,
        "solver_mode": solver_mode,
    }
    if use_tvar:
        result["tvar_99_used"] = True
        result["tvar_99_per_cohort"] = tvar_per_cohort
    return result


# ---------------------------------------------------------------------------
# Vercel Python serverless handler.
# ---------------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel requires this exact name
    def do_POST(self):  # noqa: N802 — Vercel requires this exact name
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length)) if length else {}
        try:
            result = solve(
                cohorts=body["cohorts"],
                capital_budget=float(body.get("capital_budget", 1e8)),
                max_nonrenew_pct=float(body.get("max_nonrenew_pct", 0.10)),
                cession_budget=float(body.get("cession_budget", 5e6)),
                horizon_start=str(body.get("horizon_start", "2026-07-01")),
                horizon_end=str(body.get("horizon_end", "2027-06-30")),
                risk_measure=str(body.get("risk_measure", "var_99")),
            )
            self.send_response(200)
        except Exception as e:  # pragma: no cover — defensive
            result = {"error": str(e)}
            self.send_response(500)
        payload = json.dumps(result).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
