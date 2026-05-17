"""Task 16 — Portfolio MIP.

Allocates each cohort fractionally across six underwriting actions —
``retain``, ``reprice_up``, ``reprice_down``, ``non_renew``, ``cede_qs``,
``cede_xs`` — to maximize expected underwriting margin subject to a
capital budget (VaR-99 by default, or coherent TVaR-99 when
``risk_measure='tvar_99'``), a regulatory non-renewal cap, and a cession
premium budget.

``solve()`` is module-level so it can be imported and unit-tested without
spinning up the HTTP handler. The Vercel handler at the bottom just wraps
``solve`` with JSON request/response plumbing.

Solver: PuLP with the bundled CBC binary. CBC's ``timeLimit=30`` keeps us
inside Vercel's 60s serverless timeout even for a fully populated book.
"""

from __future__ import annotations

import json
import logging
from http.server import BaseHTTPRequestHandler
from typing import Any

from api_py.treaty import retained_xs

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Action economics (per spec).
#
# REPRICE_FACTOR — what fraction of the cohort's premium accrues to the
#   insurer under each action. ``non_renew`` zeros out, ``cede_qs`` gives
#   up half the premium (and half the loss exposure), etc.
# LOSS_FACTOR — what fraction of the cohort's expected loss the insurer
#   still bears under each action.
# CESSION_COST_RATE — additional cession premium (as a fraction of the
#   cohort's expected loss at p50) paid out to the reinsurer.
# ---------------------------------------------------------------------------
REPRICE_FACTOR: dict[str, float] = {
    "retain": 1.0,
    "reprice_up": 1.15,
    "reprice_down": 0.90,
    "non_renew": 0.0,
    "cede_qs": 0.5,
    "cede_xs": 1.0,
}
LOSS_FACTOR: dict[str, float] = {
    "retain": 1.0,
    "reprice_up": 1.0,
    "reprice_down": 1.0,
    "non_renew": 0.0,
    "cede_qs": 0.5,
    "cede_xs": 0.3,
}
CESSION_COST_RATE: dict[str, float] = {
    "cede_qs": 0.6,
    "cede_xs": 0.15,
    "retain": 0.0,
    "reprice_up": 0.0,
    "reprice_down": 0.0,
    "non_renew": 0.0,
}

ACTIONS: tuple[str, ...] = (
    "retain",
    "reprice_up",
    "reprice_down",
    "non_renew",
    "cede_qs",
    "cede_xs",
)


def _cohort_tiv(c: dict[str, Any]) -> float:
    """Cohort TIV — accept either ``tiv`` or ``total_tiv`` for flexibility."""
    return float(c.get("total_tiv", c.get("tiv", 0.0)))


def _cohort_premium(c: dict[str, Any]) -> float:
    return float(c.get("total_premium", c.get("premium", 0.0)))


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


def solve(
    cohorts: list[dict[str, Any]],
    capital_budget: float,
    max_nonrenew_pct: float,
    cession_budget: float,
    horizon_start: str = "2026-07-01",
    horizon_end: str = "2027-06-30",
    risk_measure: str = "var_99",
) -> dict[str, Any]:
    """Solve the Portfolio MIP.

    Parameters
    ----------
    cohorts
        List of cohort dicts. Each cohort must carry ``id``, a TIV (under
        ``total_tiv`` or ``tiv``), ``total_premium`` (or ``premium``),
        ``loss_p50`` and ``loss_p99``.

        Task P2.0: cohort dicts *may* also carry an optional
        ``loss_scenarios: list[float]`` field — K=1000 Monte-Carlo draws
        from the lognormal posterior whose median is ``loss_p50`` and
        whose 99th percentile is ``loss_p99``. The current MIP does not
        consume this field (the legacy ``(p50, p99)`` scalars remain
        authoritative); it's plumbed through for the P2.6 TVaR-99 swap,
        the P2.7 per-scenario retained tail, and the P2.8 elasticity MILP
        which will read it directly off the cohort dict.

        Carrying the optional field on the cohort dict (rather than as a
        parallel ``scenarios: list[list[float]]`` kwarg) is intentional —
        it keeps the scenarios co-located with ``loss_p50`` / ``loss_p99``
        on the same dict, matches the way the precompute artifact is
        already shaped, and means legacy callers without the field
        continue to work with no special-casing here.
    capital_budget
        Maximum tolerable Σ (cohort VaR-99 retained) across the portfolio.
    max_nonrenew_pct
        Maximum fraction of total book TIV that may be non-renewed (a
        regulatory + customer-continuity cap).
    cession_budget
        Maximum aggregate cession premium spend.
    horizon_start, horizon_end
        ISO-date strings (``YYYY-MM-DD``) describing the treaty-year window
        this solve targets. Defaults match the industry cat treaty cycle
        (Jul 1 → Jun 30) — the implicit horizon for renewals priced against
        a wind-season-aligned reinsurance program. Pass through to the
        output dict so downstream artifacts/UIs can label the recommendation
        without re-deriving the convention. The values are metadata only;
        the MIP economics themselves are unaffected (premiums and losses
        are already annualized at the cohort level).
    risk_measure
        Task P2.6: which risk measure drives the capital-budget constraint.

        - ``'var_99'`` (default, legacy): coefficient is ``loss_p99``.
          Note: P2.7 broke byte-identity with pre-P2.7 artifacts because
          the ``cede_xs`` zeroing trick is gone (see below).
        - ``'tvar_99'``: coefficient is the mean of the top 1% of each
          cohort's ``loss_scenarios`` (a coherent, sub-additive measure
          that an actuary will accept where VaR-99 will be rejected on
          sight). Cohorts that lack ``loss_scenarios`` fall back to
          ``loss_p99`` for THAT cohort with a warning logged; the overall
          run is still tagged ``tvar_99_used=True`` so the caller can see
          which measure was requested. P2.6 uses raw scenarios — the
          Horvitz-Thompson IS correction lands in P2.9.

        Task P2.7: the ``cede_xs`` action no longer zeros its retained
        tail. Instead the capital coefficient is
        ``retained_xs(L, attachment, exhaustion)`` evaluated against the
        cohort's representative loss (``loss_p99`` under ``var_99``,
        ``mean(retained_xs(L_s, att, exh) for L_s in top_1%_of_scenarios)``
        under ``tvar_99``). The XS treaty layer
        ``(attachment, exhaustion)`` may be supplied per cohort under a
        ``treaty: {attachment, exhaustion}`` key; absent that, defaults
        are derived from the cohort scalars:

            attachment = loss_p50 × 1.5   (≈ 0.375 × loss_p99 for p99=4×p50)
            exhaustion = loss_p99 × 2     (covers well into the TVaR tail)

        Defensibility: a real XS treaty attaches in the *working layer*
        — above expected losses (where premium covers normal volatility)
        but below the cedant's tail tolerance. For the FL/TX coastal
        book the working layer typically begins ~1.5× expected loss
        (the point where a bad-but-not-catastrophic year stops being
        covered by premium) and exhausts at ~2× p99 (deep enough that
        only true cat events bust the layer). With p99 = 4 × p50 these
        defaults give:

          retained_xs(p99) = 1.5 × p50 = 0.375 × p99   (var_99 coeff)
          retained_xs(tail_scenario_with_5×_p99) ≈ 1.5×p50 + 3×p99
                                                  ≈ 3.4 × p99 (tvar_99)

        So XS provides a meaningful capital reduction at the VaR-99
        level (~63% off retain) but the *retained-tail blow-through*
        kicks in hard under TVaR-99 — capturing the "horizon-event"
        risk a coherent measure exposes. P2.17 will surface a per-cohort
        configurator for these values.

        ``LOSS_FACTOR['cede_xs'] = 0.3`` is preserved as documentation
        but is no longer consulted by the capital constraint (replaced
        by the ``retained_xs`` math). It remains in the objective for
        the loss term (expected-loss accounting under the chosen
        action — the XS treaty doesn't make the loss disappear, it
        only redistributes the tail).

    Returns
    -------
    dict
        ``{"status": str, "objective": float, "actions": [{"cohort_id": ...,
        "retain": float, ...}, ...], "horizon_start": str, "horizon_end":
        str}``. Action allocations always sum to 1.0 per cohort (within
        solver tolerance).

        When ``risk_measure == 'tvar_99'`` the dict additionally carries
        ``tvar_99_used: True`` and ``tvar_99_per_cohort: {cohort_id:
        float}`` for traceability (the per-cohort value is whatever was
        plugged into the capital coefficient — either the computed TVaR-99
        or the ``loss_p99`` fallback).
    """
    import pulp

    prob = pulp.LpProblem("portfolio_mip", pulp.LpMaximize)

    # Decision variables: x[c, a] in [0, 1].
    x: dict[tuple[str, str], pulp.LpVariable] = {}
    for c in cohorts:
        cid = c["id"]
        for a in ACTIONS:
            x[(cid, a)] = pulp.LpVariable(f"x_{cid}_{a}", lowBound=0, upBound=1)

    # ── Objective ──────────────────────────────────────────────────────
    # Σ_c Σ_a x[c,a] * (premium * REPRICE - loss_p50 * LOSS_FACTOR
    #                   - loss_p50 * CESSION_COST_RATE)
    obj_terms = []
    for c in cohorts:
        cid = c["id"]
        premium = _cohort_premium(c)
        loss50 = float(c["loss_p50"])
        for a in ACTIONS:
            coeff = (
                premium * REPRICE_FACTOR[a]
                - loss50 * LOSS_FACTOR[a]
                - loss50 * CESSION_COST_RATE[a]
            )
            obj_terms.append(coeff * x[(cid, a)])
    prob += pulp.lpSum(obj_terms)

    # ── Constraint 1: action fractions sum to 1 per cohort ─────────────
    for c in cohorts:
        cid = c["id"]
        prob += pulp.lpSum(x[(cid, a)] for a in ACTIONS) == 1, f"sum1_{cid}"

    # ── Constraint 2: capital budget (VaR-99 or TVaR-99) ───────────────
    # Capital coefficient is ``risk_coeff * LOSS_FACTOR[a]`` for non-XS
    # actions, where ``risk_coeff`` is either ``loss_p99`` (VaR-99
    # legacy) or ``mean(top 1% of loss_scenarios)`` (TVaR-99, P2.6).
    # TVaR is the coherent, sub-additive measure an actuary will sign
    # off on; VaR-99 is the legacy path.
    #
    # ``cede_xs`` (P2.7): before P2.7 this action zeroed its retained
    # tail on the assumption that excess-of-loss reinsurance attaches
    # below the tail. That was a mock-grade shortcut — the same XS
    # treaty actually leaves the cedant exposed *below the attachment*
    # AND *above the exhaustion*. P2.7 replaces the zero with
    # ``retained_xs(L, attachment, exhaustion)`` evaluated at the
    # cohort's representative loss:
    #   - var_99: L = loss_p99 (single value)
    #   - tvar_99: L is integrated as ``mean(retained_xs(L_s, ...) for
    #     L_s in top_1%_of_scenarios)``
    # The integration over scenarios happens at constraint-assembly
    # time, so the coefficient is still a scalar multiplying
    # ``x[(c, cede_xs)]`` — the MIP stays MIP-shaped.
    #
    # Treaty layer defaults (until P2.17 surfaces a configurator):
    #   attachment = loss_p50 × 1.5  (≈ 0.375 × p99 for p99 = 4×p50)
    #   exhaustion = loss_p99 × 2    (covers well into the TVaR tail)
    # Both can be overridden per cohort via a ``treaty`` field.
    use_tvar = risk_measure == "tvar_99"
    tvar_per_cohort: dict[str, float] = {}
    capital_terms = []
    for c in cohorts:
        cid = c["id"]
        loss50 = float(c["loss_p50"])
        loss99 = float(c["loss_p99"])
        # Derive (attachment, exhaustion) for this cohort's XS layer.
        treaty = c.get("treaty") or {}
        attachment = float(treaty.get("attachment", loss50 * 1.5))
        exhaustion = float(treaty.get("exhaustion", loss99 * 2.0))
        # Guard pathological inversions — clamp to a degenerate layer.
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
                # cede_xs retained tail: single-value retained_xs on p99.
                cede_xs_coeff = retained_xs(loss99, attachment, exhaustion)
            else:
                # Compute the TVaR-99 mean and its top-1% tail in one
                # pass — both the risk coefficient and the cede_xs
                # retained-tail integration reuse the same tail set,
                # avoiding a duplicate ``np.percentile`` call.
                import numpy as np

                risk_coeff, tail = _tvar_99_tail(scenarios)
                # cede_xs retained tail: mean of retained_xs over top 1%
                # of scenarios (the same tail set TVaR-99 itself uses).
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
            # var_99 path: evaluate retained_xs at loss_p99 directly.
            cede_xs_coeff = retained_xs(loss99, attachment, exhaustion)

        for a in ACTIONS:
            if a == "cede_xs":
                # P2.7: real retained-tail math instead of a flat zero.
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

    # ── Solve ──────────────────────────────────────────────────────────
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=30)
    prob.solve(solver)

    status = pulp.LpStatus[prob.status]
    objective = pulp.value(prob.objective)

    # Materialize per-cohort actions. Clip tiny negatives the solver
    # sometimes returns; PuLP guarantees primal feasibility but float
    # round-off can leak a -1e-12 here or there.
    actions_out: list[dict[str, Any]] = []
    for c in cohorts:
        cid = c["id"]
        row: dict[str, Any] = {"cohort_id": cid}
        for a in ACTIONS:
            v = x[(cid, a)].value()
            if v is None:
                row[a] = 0.0
            else:
                row[a] = max(0.0, min(1.0, float(v)))
        actions_out.append(row)

    result: dict[str, Any] = {
        "status": status,
        "objective": float(objective) if objective is not None else 0.0,
        "actions": actions_out,
        "horizon_start": horizon_start,
        "horizon_end": horizon_end,
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
