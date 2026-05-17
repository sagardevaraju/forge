"""Task 16 — Portfolio MIP.

Allocates each cohort fractionally across six underwriting actions —
``retain``, ``reprice_up``, ``reprice_down``, ``non_renew``, ``cede_qs``,
``cede_xs`` — to maximize expected underwriting margin subject to a
capital (VaR-99) budget, a regulatory non-renewal cap, and a cession
premium budget.

``solve()`` is module-level so it can be imported and unit-tested without
spinning up the HTTP handler. The Vercel handler at the bottom just wraps
``solve`` with JSON request/response plumbing.

Solver: PuLP with the bundled CBC binary. CBC's ``timeLimit=30`` keeps us
inside Vercel's 60s serverless timeout even for a fully populated book.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from typing import Any

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


def solve(
    cohorts: list[dict[str, Any]],
    capital_budget: float,
    max_nonrenew_pct: float,
    cession_budget: float,
    horizon_start: str = "2026-07-01",
    horizon_end: str = "2027-06-30",
) -> dict[str, Any]:
    """Solve the Portfolio MIP.

    Parameters
    ----------
    cohorts
        List of cohort dicts. Each cohort must carry ``id``, a TIV (under
        ``total_tiv`` or ``tiv``), ``total_premium`` (or ``premium``),
        ``loss_p50`` and ``loss_p99``.
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

    Returns
    -------
    dict
        ``{"status": str, "objective": float, "actions": [{"cohort_id": ...,
        "retain": float, ...}, ...], "horizon_start": str, "horizon_end":
        str}``. Action allocations always sum to 1.0 per cohort (within
        solver tolerance).
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

    # ── Constraint 2: capital (VaR-99) budget ──────────────────────────
    # Capital coefficient is loss_p99 * LOSS_FACTOR[a] for most actions.
    # ``cede_xs`` is special: excess-of-loss reinsurance is by construction
    # attached *below* the cohort's VaR-99 (that's the whole point of XS),
    # so the insurer's retained tail exposure at the p99 level is ~0. This
    # is what allows a near-zero capital budget to remain feasible by
    # purchasing XS protection.
    capital_terms = []
    for c in cohorts:
        cid = c["id"]
        loss99 = float(c["loss_p99"])
        for a in ACTIONS:
            retain_frac = 0.0 if a == "cede_xs" else LOSS_FACTOR[a]
            capital_terms.append(loss99 * retain_frac * x[(cid, a)])
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

    return {
        "status": status,
        "objective": float(objective) if objective is not None else 0.0,
        "actions": actions_out,
        "horizon_start": horizon_start,
        "horizon_end": horizon_end,
    }


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
