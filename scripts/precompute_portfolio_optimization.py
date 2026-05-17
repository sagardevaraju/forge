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
import os
import sqlite3
import sys
from pathlib import Path

# Make ``api_py`` importable when this script is run as ``python -m`` or directly.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api_py.optimize_portfolio import solve  # noqa: E402

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
) -> tuple[float, float]:
    """Return (loss_p50, loss_p99) for the cohort under the HAZUS prior."""
    zone_factor = FLOOD_ZONE_SEVERITY.get(modal_flood_zone, 1.0)
    build_factor = BUILD_VULNERABILITY.get(build_type, 1.0)
    # Elevation gives a partial mitigation: 1.0 at sea level, ~0.6 at 5m.
    elev_factor = max(0.5, 1.0 - 0.08 * max(0.0, avg_elevation_m))
    annual_loss_rate = 0.012 * zone_factor * build_factor * elev_factor
    p50 = total_tiv * annual_loss_rate
    # Heavy-tailed: p99 ≈ 4× p50 in the FL/TX coastal book empirically.
    p99 = p50 * 4.0
    return p50, p99


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
        p50, p99 = _cohort_loss_quantiles(
            b["total_tiv"], modal, b["build_type"], avg_elev
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
    capital_budget = expected_loss_p99 * 0.30   # tolerate 30% of book p99
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
    print(f"MIP status: {result['status']}  objective: ${result['objective']:,.0f}")

    # Decorate each action row with the dominant action label + dominant share
    # so the front-end doesn't need to recompute argmax.
    ACTIONS = ("retain", "reprice_up", "reprice_down", "non_renew", "cede_qs", "cede_xs")
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
    payload = {
        # schema_version 2 (Task 12): cohort ids switched from `{zip3}_{build_type}_d{N}`
        # to `{zip3}_{build_type}_q{N}` and the cohort field `tiv_decile` was
        # renamed to `tiv_quintile`. Holders of v1 artifacts must re-run
        # `python -m scripts.precompute_portfolio_optimization` to refresh.
        "schema_version": 2,
        "status": result["status"],
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
        "cohorts": cohorts,
        "actions": enriched_actions,
    }
    out_path.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {out_path.relative_to(ROOT)}  ({os.path.getsize(out_path):,} bytes)")
    print("Action distribution:")
    for a, s in action_summary.items():
        share = s["tiv"] / total_tiv * 100 if total_tiv else 0.0
        print(f"  {a:14s}  {s['count']:4d} cohorts  ${s['tiv']:>14,.0f} TIV  ({share:5.1f}%)")


if __name__ == "__main__":
    main()
