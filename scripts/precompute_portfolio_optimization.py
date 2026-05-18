"""Pre-compute the Portfolio MIP result and cache it as artifacts/portfolio_optimization.json.

The Next.js Portfolio page reads this file at render time; we avoid invoking
PuLP/CBC from the Node runtime by snapshotting the optimization upstream.

Loss quantiles per cohort: a tractable HAZUS-derived annual-loss prior. We
intentionally do *not* call the XGBoost loss model here because the live
artifacts/xgb_p50.joblib was trained against storm-conditioned features
(requires a storm scenario set as input), and an unconditioned portfolio
view is what the Portfolio Map shows. The prior matches the spirit of the
loss model: heavier-tailed for higher-vulnerability building types and
worse flood zones, with p99 ≈ 4× p50.

Re-run after seeding policies or changing budgets:
    python -m scripts.precompute_portfolio_optimization
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np

# Make ``api_py`` importable when this script is run as ``python -m`` or directly.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api_py.optimize_portfolio import ACTIONS, solve  # noqa: E402

# Task P2.0 — Monte-Carlo scenario count per cohort. Sized so that the
# 99th-percentile order statistic is stable (~30% sampling noise on 1000
# draws under a lognormal with σ≈0.6) without inflating the artifact
# beyond ~4.5 MB for the live ~570-cohort book. P2.6 / P2.7 / P2.8 will
# consume these arrays for the TVaR-99 swap, the per-scenario retained
# tail, and the elasticity MILP respectively.
K_SCENARIOS = 1000

# Φ⁻¹(0.99) — the standard-normal quantile at the 99th percentile.
# Reconstructing the lognormal posterior whose median = p50 and whose 99th
# percentile = p99 gives σ = (log(p99) − log(p50)) / Φ⁻¹(0.99). With
# p99 = 4 × p50 that lands at σ ≈ log(4) / 2.326 ≈ 0.596.
PHI_INV_99 = 2.326

# Task 24: industry-standard cat treaty cycle (Jul 1 → Jun 30). Persist in the
# artifact so the Portfolio UI can label the recommendation with its horizon
# without hard-coding the convention on the client side.
HORIZON_START = "2026-07-01"
HORIZON_END = "2027-06-30"


# ---------------------------------------------------------------------------
# HAZUS-derived annual loss prior. Values calibrated so that the worst
# cohorts (manufactured + VE flood zone, top-quintile TIV) carry ~4-5% annual
# expected loss ratios, matching FL coastal book benchmarks.
# ---------------------------------------------------------------------------
FLOOD_ZONE_SEVERITY: dict[str, float] = {
    "X": 0.6,   # minimal flood risk
    "A": 1.0,   # 100-year floodplain (no BFE)
    "AE": 1.4,  # 100-year floodplain (with BFE)
    "VE": 2.2,  # high-velocity coastal
}
BUILD_VULNERABILITY: dict[str, float] = {
    "wood_frame": 1.0,
    "masonry": 0.55,
    "manufactured": 1.9,
}


def _cohort_loss_quantiles(
    total_tiv: float,
    modal_flood_zone: str,
    build_type: str,
    avg_elevation_m: float,
    zip3: str,
    tiv_quintile: int,
) -> tuple[float, float, list[float]]:
    """Return ``(loss_p50, loss_p99, loss_scenarios)`` for the cohort.

    The scalar quantiles match the HAZUS-style prior used since Task 16:
    ``p50 = total_tiv × annual_loss_rate`` and ``p99 = 4 × p50`` (heavy-
    tailed coastal book).

    Task P2.0 additionally emits ``loss_scenarios`` — a list of K = 1000
    draws from the lognormal posterior whose median is ``p50`` and whose
    99th percentile is ``p99``. The (μ, σ) of the lognormal are derived
    from the two scalar quantiles:

        X ~ Lognormal(μ, σ²)
        median(X) = exp(μ)              ⇒ μ = log(p50)
        P99(X)    = exp(μ + Φ⁻¹(0.99) σ) ⇒ σ = (log(p99) − log(p50)) / 2.326

    With ``p99 = 4 × p50`` that gives σ ≈ log(4) / 2.326 ≈ 0.596 — the
    same shape as the prior, just resolved into samples.

    The draws are seeded with ``hash((zip3, build_type, q)) & 0xFFFFFFFF``
    so that the artifact is reproducible *within a single precompute
    run*. Python's ``hash()`` for strings is randomized per interpreter,
    which is the granularity we want: re-running the precompute produces
    a deterministic artifact from start to finish, but the seed is not
    leaked across runs (it's a Monte-Carlo, not a regression fixture).
    """
    zone_factor = FLOOD_ZONE_SEVERITY.get(modal_flood_zone, 1.0)
    build_factor = BUILD_VULNERABILITY.get(build_type, 1.0)
    # Elevation gives a partial mitigation: 1.0 at sea level, ~0.6 at 5m.
    elev_factor = max(0.5, 1.0 - 0.08 * max(0.0, avg_elevation_m))
    annual_loss_rate = 0.012 * zone_factor * build_factor * elev_factor
    p50 = total_tiv * annual_loss_rate
    # Heavy-tailed: p99 ≈ 4× p50 in the FL/TX coastal book empirically.
    p99 = p50 * 4.0

    # Reconstruct (μ, σ) of the lognormal posterior and draw K samples.
    if p50 > 0:
        mu = math.log(p50)
        sigma = (math.log(p99) - math.log(p50)) / PHI_INV_99
        seed = hash((zip3, build_type, tiv_quintile)) & 0xFFFFFFFF
        rng = np.random.default_rng(seed=seed)
        # ``lognormal`` parameterized by (mean, sigma) of the underlying
        # normal — exactly what we derived above.
        scenarios = rng.lognormal(mean=mu, sigma=sigma, size=K_SCENARIOS)
        loss_scenarios = [float(x) for x in scenarios]
    else:
        # Pathological zero-TIV cohort: deterministic zeros.
        loss_scenarios = [0.0] * K_SCENARIOS

    return p50, p99, loss_scenarios


def _aggregate_cohorts_from_sqlite(db_path: Path) -> list[dict]:
    """Read the policy book and aggregate into cohorts.

    Mirrors the JS aggregation in lib/db/cohorts.ts (same cohort key, quintile
    TIV bucket) so the JS-rendered map matches the Python-side MIP keys 1:1.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT zip3, build_type, tiv, premium_annual, flood_zone, elevation_m FROM policies"
    ).fetchall()
    conn.close()

    if not rows:
        return []

    tivs = sorted(float(r["tiv"]) for r in rows)
    # Quintile cut-points using linear interpolation (matches lib/db/cohorts.ts).
    cuts: list[float] = []
    n = len(tivs)
    for q in range(1, 5):
        rank = (q / 5) * (n - 1)
        lo, hi = int(rank), int(rank) + (0 if rank.is_integer() else 1)
        if lo == hi or hi >= n:
            cuts.append(tivs[lo])
        else:
            w = rank - lo
            cuts.append(tivs[lo] * (1 - w) + tivs[hi] * w)

    def bucket(t: float) -> int:
        for i, c in enumerate(cuts):
            if t < c:
                return i
        return 4

    buckets: dict[str, dict] = {}
    for r in rows:
        zip3 = str(r["zip3"])
        bt = str(r["build_type"])
        quintile = bucket(float(r["tiv"]))
        key = f"{zip3}_{bt}_q{quintile}"
        b = buckets.setdefault(
            key,
            {
                "id": key,
                "zip3": zip3,
                "build_type": bt,
                "tiv_quintile": quintile,
                "policy_count": 0,
                "total_tiv": 0.0,
                "total_premium": 0.0,
                "flood_zone_counts": {},
                "elev_sum": 0.0,
                "elev_n": 0,
            },
        )
        b["policy_count"] += 1
        b["total_tiv"] += float(r["tiv"])
        b["total_premium"] += float(r["premium_annual"] or 0.0)
        fz = r["flood_zone"]
        if fz:
            b["flood_zone_counts"][fz] = b["flood_zone_counts"].get(fz, 0) + 1
        elev = r["elevation_m"]
        if elev is not None:
            b["elev_sum"] += float(elev)
            b["elev_n"] += 1

    out: list[dict] = []
    for b in buckets.values():
        modal = ""
        best = -1
        for z in sorted(b["flood_zone_counts"].keys()):
            if b["flood_zone_counts"][z] > best:
                best = b["flood_zone_counts"][z]
                modal = z
        avg_elev = b["elev_sum"] / b["elev_n"] if b["elev_n"] > 0 else 0.0
        p50, p99, scenarios = _cohort_loss_quantiles(
            total_tiv=b["total_tiv"],
            modal_flood_zone=modal,
            build_type=b["build_type"],
            avg_elevation_m=avg_elev,
            zip3=b["zip3"],
            tiv_quintile=b["tiv_quintile"],
        )
        out.append(
            {
                "id": b["id"],
                "zip3": b["zip3"],
                "build_type": b["build_type"],
                "tiv_quintile": b["tiv_quintile"],
                "policy_count": b["policy_count"],
                "total_tiv": b["total_tiv"],
                "total_premium": b["total_premium"],
                "modal_flood_zone": modal,
                "avg_elevation_m": avg_elev,
                "loss_p50": p50,
                "loss_p99": p99,
                # Task P2.0: K=1000 lognormal draws for downstream tail
                # measures (TVaR-99 in P2.6, per-scenario retained tail in
                # P2.7, elasticity MILP in P2.8). Stripped server-side
                # before the front-end ever sees this array.
                "loss_scenarios": scenarios,
            }
        )
    out.sort(key=lambda c: c["id"])
    return out


def main() -> None:
    db_path = ROOT / "forge-local.db"
    if not db_path.exists():
        raise SystemExit(f"forge-local.db not found at {db_path}")

    cohorts = _aggregate_cohorts_from_sqlite(db_path)
    print(f"Aggregated {len(cohorts)} cohorts from {db_path.name}")

    total_tiv = sum(c["total_tiv"] for c in cohorts)
    total_premium = sum(c["total_premium"] for c in cohorts)
    expected_loss_p50 = sum(c["loss_p50"] for c in cohorts)
    expected_loss_p99 = sum(c["loss_p99"] for c in cohorts)
    print(f"  Book TIV: ${total_tiv:,.0f}")
    print(f"  Book premium: ${total_premium:,.0f}")
    print(f"  Aggregate expected loss (p50): ${expected_loss_p50:,.0f}")
    print(f"  Aggregate tail loss (p99):     ${expected_loss_p99:,.0f}")

    # Budgets calibrated to the synthetic FL/TX/LA/NC book.
    #
    # Task P2.7 update: bumped capital_budget multiplier 0.30 → 0.40 to
    # accommodate the new honest ``cede_xs`` capital coefficient. Before
    # P2.7, ``cede_xs`` zeroed its retained-tail capital (a mock-grade
    # shortcut — see ``api_py.optimize_portfolio.solve()`` docstring),
    # which left the 0.30 budget feasible only because XS was a "free"
    # capital lever. P2.7 prices ``cede_xs`` at its real retained tail
    # (~0.375 × loss_p99 with default treaty layers), so the minimum
    # achievable book capital is ~0.32 × loss_p99 with the 0.15 non_renew
    # cap. The 0.40 budget gives the solver a usable margin without
    # forcing every cohort into ``non_renew``.
    capital_budget = expected_loss_p99 * 0.40   # tolerate 40% of book p99
    max_nonrenew_pct = 0.15                     # may non-renew up to 15% of TIV
    cession_budget = total_premium * 0.10       # 10% of premium for cession

    result = solve(
        cohorts=cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        horizon_start=HORIZON_START,
        horizon_end=HORIZON_END,
    )
    print(
        f"MIP status: {result['status']}  "
        f"solver_mode: {result.get('solver_mode', 'milp')}  "
        f"objective: ${result['objective']:,.0f}"
    )

    # Decorate each action row with the dominant action label + dominant share
    # so the front-end doesn't need to recompute argmax. ACTIONS is sourced
    # from optimize_portfolio.py so the schema stays in lock-step with the
    # MILP definition (Task P2.8: 11 actions = retain + 7-bucket rate grid +
    # non_renew + cede_qs + cede_xs).
    cohort_by_id = {c["id"]: c for c in cohorts}
    enriched_actions = []
    action_summary = {a: {"count": 0, "tiv": 0.0} for a in ACTIONS}
    for row in result["actions"]:
        cid = row["cohort_id"]
        dominant = max(ACTIONS, key=lambda a: row.get(a, 0.0))
        enriched = {
            **row,
            "dominant_action": dominant,
            "dominant_share": row.get(dominant, 0.0),
        }
        enriched_actions.append(enriched)
        action_summary[dominant]["count"] += 1
        action_summary[dominant]["tiv"] += cohort_by_id[cid]["total_tiv"]

    artifacts_dir = ROOT / "artifacts"
    artifacts_dir.mkdir(exist_ok=True)
    out_path = artifacts_dir / "portfolio_optimization.json"

    # Task P2.0 review fix: the on-disk artifact carries each lognormal draw
    # at full ~17-significant-digit float precision, which blows the file up
    # to ~15 MB. Losses are dollar amounts — sub-cent precision is noise.
    # Round to 2 decimal places for the artifact copy only; the in-memory
    # ``cohorts`` list (already consumed by ``solve()`` above) keeps full
    # precision for any downstream in-process use (P2.6+).
    cohorts_for_artifact = [
        {
            **c,
            "loss_scenarios": [round(x, 2) for x in c["loss_scenarios"]],
        }
        for c in cohorts
    ]
    payload = {
        # schema_version history:
        #   1 — original Task 16 shape, cohort id = `{zip3}_{build_type}_d{N}`.
        #   2 — Task 12 renamed `tiv_decile` → `tiv_quintile` and cohort ids
        #       switched to `{zip3}_{build_type}_q{N}`.
        #   3 — Task P2.0 (Phase 2): cohorts now carry
        #       `loss_scenarios: list[float]` of K=1000 lognormal draws
        #       (seeded reproducibly via `hash((zip3, build_type, q))`).
        #       Adds ~4.5 MB to the artifact; consumed by P2.6 (TVaR-99),
        #       P2.7 (per-scenario retained tail), P2.8 (elasticity MILP).
        #       The server component must strip this field before passing
        #       data to the client so we don't ship MBs of scenarios over
        #       the wire (see `app/portfolio/page.tsx`).
        #   4 — Task P2.8 (Phase 2): the action set expanded from 6 to 11.
        #       The two reprice scalars (`reprice_up=1.15`, `reprice_down=
        #       0.90`) are gone; in their place is a discretized rate
        #       grid {`reprice_n20, reprice_n10, reprice_0, reprice_p5,
        #       reprice_p10, reprice_p15, reprice_p20`} priced with a
        #       price-elasticity correction. Decision variables are now
        #       binary; ``action_summary`` keys grew from 6 → 11, and
        #       each action row now reports the new ``reprice_*`` shares
        #       (typically exactly one at 1.0 under the MILP path).
        #       Holders of v3 artifacts must re-run
        #       `python -m scripts.precompute_portfolio_optimization`.
        # Holders of v1/v2/v3 artifacts must re-run
        # `python -m scripts.precompute_portfolio_optimization` to refresh.
        "schema_version": 4,
        "status": result["status"],
        # P2.8: surface which solver path produced this artifact (milp vs
        # lp_relaxed_rounded). UI consumers can render a footnote if the
        # fallback engaged.
        "solver_mode": result.get("solver_mode", "milp"),
        "objective": result["objective"],
        "horizon_start": result["horizon_start"],
        "horizon_end": result["horizon_end"],
        "budgets": {
            "capital_budget": capital_budget,
            "max_nonrenew_pct": max_nonrenew_pct,
            "cession_budget": cession_budget,
        },
        "book_totals": {
            "tiv": total_tiv,
            "premium": total_premium,
            "loss_p50": expected_loss_p50,
            "loss_p99": expected_loss_p99,
        },
        "action_summary": action_summary,
        "cohorts": cohorts_for_artifact,
        "actions": enriched_actions,
    }
    # The artifact is consumed by code (``loadPortfolioOptimization``), not
    # humans — drop the indent whitespace so the K=1000-draw cohort arrays
    # don't pay for one-float-per-line newlines + spaces.
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {out_path.relative_to(ROOT)}  ({os.path.getsize(out_path):,} bytes)")
    print("Action distribution:")
    for a, s in action_summary.items():
        share = s["tiv"] / total_tiv * 100 if total_tiv else 0.0
        print(f"  {a:14s}  {s['count']:4d} cohorts  ${s['tiv']:>14,.0f} TIV  ({share:5.1f}%)")


if __name__ == "__main__":
    main()
