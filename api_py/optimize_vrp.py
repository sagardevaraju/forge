"""Task 17 — Operational VRP (Vehicle Routing / Adjuster Staging).

Each adjuster goes to exactly one zone per day, so the "VRP" reduces to a
generalized assignment problem — solvable cleanly with a PuLP/CBC LP
relaxation that's actually integer-feasible by construction (each adjuster's
one-zone-per-day constraint forces a unimodular pattern with binary
solutions).

``solve()`` is module-level so it can be imported and unit-tested without
spinning up the HTTP handler. The Vercel handler at the bottom wraps
``solve`` with JSON request/response plumbing — mirrors ``optimize_portfolio.py``.

Objective notes
---------------
The "true" objective is *expected response time per claim*, which has a
decision-dependent denominator (number of adjusters at a zone). That's
non-linear in the LP sense. We **simplify** to::

    minimize Σ_a Σ_z Σ_d  y[a, z, d] · drive_hours(home_a, zone_z) · claim_volume_z

Because un-served zones contribute zero, the optimizer naturally prefers
shorter drives to high-volume zones. Acceptable approximation for the demo.

Solver: PuLP with the bundled CBC binary, ``timeLimit=30`` to stay inside
Vercel's 60s serverless ceiling.
"""

from __future__ import annotations

import json
import math
from http.server import BaseHTTPRequestHandler
from typing import Any

# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------
_EARTH_RADIUS_MI = 3958.7613  # miles
_AVG_SPEED_MPH = 50.0  # rough "highway average" for adjuster drives


def drive_hours(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lon points, in hours at 50 mph.

    Approximate but good enough for staging decisions at zip3 granularity.
    """
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    miles = 2 * _EARTH_RADIUS_MI * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return miles / _AVG_SPEED_MPH


# ---------------------------------------------------------------------------
# Core solver
# ---------------------------------------------------------------------------
def solve(
    adjusters: list[dict[str, Any]],
    zones: list[dict[str, Any]],
    days: int = 7,
    max_drive_hours: float = 8.0,
) -> dict[str, Any]:
    """Solve the operational adjuster-staging assignment problem.

    Parameters
    ----------
    adjusters
        ``[{"id": int, "home_lat": float, "home_lon": float,
            "skills": [str, ...], "daily_capacity": int}, ...]``
    zones
        ``[{"id": int, "name": str, "lat": float, "lon": float,
            "capacity": int, "required_skill": str | None,
            "expected_claim_volume": float}, ...]``
    days
        Planning-horizon length in days (default 7).
    max_drive_hours
        Hard upper bound on a single one-way drive (default 8.0).

    Returns
    -------
    dict
        ``{"status": str, "objective": float,
        "assignments": [{"adjuster_id": int, "zone_id": int,
                          "day": int, "drive_hours": float}, ...]}``
    """
    import pulp

    prob = pulp.LpProblem("operational_vrp", pulp.LpMinimize)

    # Pre-compute per-pair drive times and the feasibility mask. A pair is
    # *feasible* if (a) drive within budget and (b) skill matches.
    pair_hours: dict[tuple[int, int], float] = {}
    feasible: dict[tuple[int, int], bool] = {}
    for a in adjusters:
        for z in zones:
            hrs = drive_hours(a["home_lat"], a["home_lon"], z["lat"], z["lon"])
            pair_hours[(a["id"], z["id"])] = hrs
            req = z.get("required_skill")
            skill_ok = (req is None) or (req in a.get("skills", []))
            drive_ok = hrs <= max_drive_hours
            feasible[(a["id"], z["id"])] = skill_ok and drive_ok

    # Decision variables y[a, z, d] ∈ {0, 1}. Skip infeasible pairs entirely
    # (cheaper than fixing them to zero post-hoc).
    y: dict[tuple[int, int, int], pulp.LpVariable] = {}
    for a in adjusters:
        for z in zones:
            if not feasible[(a["id"], z["id"])]:
                continue
            for d in range(days):
                y[(a["id"], z["id"], d)] = pulp.LpVariable(
                    f"y_{a['id']}_{z['id']}_{d}", cat=pulp.LpBinary
                )

    # ── Objective ──────────────────────────────────────────────────────
    # Σ y[a,z,d] * drive_hours * claim_volume  — linearized stand-in for
    # "average wait time", documented in the module docstring.
    vol_by_zone: dict[int, float] = {
        z["id"]: float(z.get("expected_claim_volume", 0.0)) for z in zones
    }
    obj_terms = []
    for (aid, zid, d), var in y.items():
        obj_terms.append(pair_hours[(aid, zid)] * vol_by_zone[zid] * var)
    prob += pulp.lpSum(obj_terms) if obj_terms else 0

    # ── Constraint 1: each adjuster works exactly one zone per day ─────
    # If an adjuster has *no* feasible zones, the problem is infeasible —
    # which is the right signal; we don't silently allow idle adjusters.
    for a in adjusters:
        for d in range(days):
            terms = [
                y[(a["id"], z["id"], d)]
                for z in zones
                if (a["id"], z["id"], d) in y
            ]
            # If there are no terms the constraint becomes 0 == 1, marking
            # the problem infeasible. That's the desired diagnostic.
            prob += pulp.lpSum(terms) == 1, f"oneZone_a{a['id']}_d{d}"

    # ── Constraint 2: zone daily capacity ──────────────────────────────
    for z in zones:
        cap = int(z.get("capacity", 0))
        for d in range(days):
            terms = [
                y[(a["id"], z["id"], d)]
                for a in adjusters
                if (a["id"], z["id"], d) in y
            ]
            if terms:
                prob += pulp.lpSum(terms) <= cap, f"cap_z{z['id']}_d{d}"

    # Skill + drive-time constraints are enforced by *omitting* infeasible
    # variables from ``y``, which is equivalent and avoids feeding the
    # solver a pile of fixed-to-zero binaries.

    # ── Solve ──────────────────────────────────────────────────────────
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=30)
    prob.solve(solver)

    status = pulp.LpStatus[prob.status]
    objective = pulp.value(prob.objective)

    assignments: list[dict[str, Any]] = []
    for (aid, zid, d), var in y.items():
        v = var.value()
        # Binary in principle; treat anything ≥ 0.5 as selected for robustness
        # against CBC's float wobble.
        if v is not None and v >= 0.5:
            assignments.append(
                {
                    "adjuster_id": aid,
                    "zone_id": zid,
                    "day": d,
                    "drive_hours": round(pair_hours[(aid, zid)], 4),
                }
            )

    # Sort for deterministic output — eases test assertions & log diffing.
    assignments.sort(key=lambda r: (r["day"], r["adjuster_id"]))

    return {
        "status": status,
        "objective": float(objective) if objective is not None else 0.0,
        "assignments": assignments,
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
                adjusters=body["adjusters"],
                zones=body["zones"],
                days=int(body.get("days", 7)),
                max_drive_hours=float(body.get("max_drive_hours", 8.0)),
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
