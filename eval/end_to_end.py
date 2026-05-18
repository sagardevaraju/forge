"""Task 25 — decision-level evaluation for FORGE.

Pipeline per holdout event:

1. Pull the event from ``storm_events`` (top-5 by ``damage_property`` for
   year in {2024, 2025}).
2. Aggregate the policy book into cohorts (zip3, build_type, TIV
   quintile) — Python re-implementation of ``lib/db/cohorts.ts``.
3. Generate 1 000 FORGE scenarios for the event.
4. Derive ``loss_p50`` / ``loss_p99`` per cohort from HAZUS wind +
   surge curves applied to scenario peak winds.
5. Solve the Portfolio MIP (``api_py.optimize_portfolio.solve``).
6. Compute FORGE ex-post P&L (premium net of reprice + cession,
   minus realised loss apportioned by ``damage_property`` share, minus
   cession premium spend).
7. Compute baseline "retain everything" P&L for the same realised loss.

Outputs:
    ``eval/results/end_to_end.json`` — per-event records + summary.
    ``eval/results/end_to_end.png``  — improvement bar chart.

The script is defensive: if any step fails for one event the event is
recorded with NaN P&L fields and the run continues.
"""

from __future__ import annotations

import json
import math
import sqlite3
import traceback
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "forge-local.db"
RESULTS_DIR = Path(__file__).resolve().parent / "results"
OUT_JSON = RESULTS_DIR / "end_to_end.json"
OUT_PNG = RESULTS_DIR / "end_to_end.png"

# Number of scenarios per event.
N_SCENARIOS = 1000

# Number of holdout events to evaluate.
N_EVENTS = 5

# Number of TIV buckets — matches ``lib/db/cohorts.ts``.
TIV_BUCKETS = 5

# Coarse mapping from event_type to peak-wind point estimate (mph).
_REALIZED_WIND_BY_TYPE = {
    "Hurricane (Typhoon)": 120.0,
    "Hurricane": 120.0,
    "Tropical Storm": 70.0,
    "Tropical Depression": 40.0,
}

# Portfolio MIP budgets.  Calibrated relative to total book TIV.
CAPITAL_BUDGET_PCT = 0.01    # 1% of book TIV as VaR-99 ceiling
NONRENEW_CAP_PCT   = 0.10    # 10% non-renewal cap
CESSION_BUDGET_PCT = 0.005   # 0.5% of book TIV as cession premium budget


# ---------------------------------------------------------------------------
# Cohort aggregation
# ---------------------------------------------------------------------------


def _tiv_cutpoints(sorted_asc: list[float]) -> list[float]:
    n = len(sorted_asc)
    cuts: list[float] = []
    for q in range(1, TIV_BUCKETS):
        rank = (q / TIV_BUCKETS) * (n - 1)
        lo = int(math.floor(rank))
        hi = int(math.ceil(rank))
        if lo == hi:
            cuts.append(sorted_asc[lo])
        else:
            w = rank - lo
            cuts.append(sorted_asc[lo] * (1.0 - w) + sorted_asc[hi] * w)
    return cuts


def _tiv_bin(tiv: float, cuts: list[float]) -> int:
    for i, c in enumerate(cuts):
        if tiv < c:
            return i
    return TIV_BUCKETS - 1


def aggregate_cohorts() -> list[dict[str, Any]]:
    """Python mirror of ``lib/db/cohorts.ts``.

    Returns
    -------
    list[dict]
        Each cohort carries id, zip3, build_type, tiv_quintile,
        policy_count, total_tiv, total_premium, modal_flood_zone,
        avg_elevation_m, and the list of constituent policy ids
        (needed for the per-cohort realised-loss share calculation).
    """
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, state, zip3, build_type, tiv, premium_annual, "
            "       flood_zone, elevation_m, lat, lon "
            "  FROM policies"
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    tivs_sorted = sorted(r[4] for r in rows)
    cuts = _tiv_cutpoints(tivs_sorted)

    buckets: dict[str, dict[str, Any]] = {}
    for (pid, state, zip3, build_type, tiv, premium, fz, elev, lat, lon) in rows:
        quintile = _tiv_bin(tiv, cuts)
        key = f"{zip3}_{build_type}_q{quintile}"
        b = buckets.get(key)
        if b is None:
            b = {
                "id": key,
                "zip3": str(zip3),
                "state": str(state) if state is not None else "",
                "build_type": str(build_type),
                "tiv_quintile": int(quintile),
                "policy_count": 0,
                "total_tiv": 0.0,
                "total_premium": 0.0,
                "elevation_sum": 0.0,
                "elevation_n": 0,
                "flood_zone_counts": {},
                "policy_ids": [],
            }
            buckets[key] = b
        b["policy_count"] += 1
        b["total_tiv"] += float(tiv)
        b["total_premium"] += float(premium) if premium is not None else 0.0
        if elev is not None:
            b["elevation_sum"] += float(elev)
            b["elevation_n"] += 1
        if fz:
            b["flood_zone_counts"][fz] = b["flood_zone_counts"].get(fz, 0) + 1
        b["policy_ids"].append(int(pid))

    out: list[dict[str, Any]] = []
    for key, b in buckets.items():
        modal = ""
        best = -1
        for z in sorted(b["flood_zone_counts"]):
            c = b["flood_zone_counts"][z]
            if c > best:
                best = c
                modal = z
        out.append({
            "id": b["id"],
            "zip3": b["zip3"],
            "state": b["state"],
            "build_type": b["build_type"],
            "tiv_quintile": b["tiv_quintile"],
            "policy_count": b["policy_count"],
            "total_tiv": b["total_tiv"],
            "total_premium": b["total_premium"],
            "modal_flood_zone": modal,
            "avg_elevation_m": (
                b["elevation_sum"] / b["elevation_n"] if b["elevation_n"] > 0 else 0.0
            ),
            "policy_ids": b["policy_ids"],
        })
    out.sort(key=lambda c: c["id"])
    return out


# ---------------------------------------------------------------------------
# Scenario -> cohort loss derivation
# ---------------------------------------------------------------------------


def compute_cohort_losses(
    cohorts: list[dict[str, Any]],
    scenarios: list[dict[str, Any]],
) -> None:
    """Mutates each cohort in-place adding ``loss_p50`` and ``loss_p99``.

    Strategy: for each scenario, compute a single damage_ratio per cohort
    using HAZUS wind (using scenario peak_wind) and HAZUS surge (using
    the surge depth at the cohort's ZIP3, if present in the scenario's
    surge grid).  Then for each cohort compute p50/p99 across the n
    scenarios * cohort total_tiv.
    """
    from ml.xgb.hazus_curves import surge_damage_ratio, wind_damage_ratio

    # Pre-allocate per-cohort damage-ratio matrices.
    n_sc = len(scenarios)
    ratios: dict[str, np.ndarray] = {
        c["id"]: np.zeros(n_sc, dtype=np.float64) for c in cohorts
    }

    # Wind decays exponentially with distance from track.  We don't have
    # full track geometry per cohort, so use an effective wind that
    # equals scenario peak_wind for ZIPs in the scenario's surge_grid
    # (i.e. directly exposed) and a damped value for the rest.
    EXPOSED_WIND_MULT  = 0.85   # cohort sits within the strong-wind swath
    UNEXPOSED_WIND_MULT = 0.30   # far inland / out-of-region

    for si, sc in enumerate(scenarios):
        peak_wind = float(sc["peak_wind"])
        surge_grid = sc.get("surge_grid", {})
        for c in cohorts:
            zip3 = c["zip3"]
            build_type = c["build_type"]
            elev = float(c["avg_elevation_m"])
            modal_fz = c["modal_flood_zone"]

            if zip3 in surge_grid:
                wind_at_property = peak_wind * EXPOSED_WIND_MULT
            else:
                wind_at_property = peak_wind * UNEXPOSED_WIND_MULT

            dr_wind = wind_damage_ratio(wind_at_property, build_type)

            # Only coastal flood zones get a surge contribution.
            surge_depth = surge_grid.get(zip3, 0.0)
            if modal_fz in ("VE", "AE") and surge_depth > 0.0:
                dr_surge = surge_damage_ratio(surge_depth, elev)
            else:
                dr_surge = 0.0

            ratios[c["id"]][si] = max(dr_wind, dr_surge)

    # Convert per-cohort ratio distributions into dollar p50/p99.
    for c in cohorts:
        r = ratios[c["id"]]
        c["loss_p50"] = float(np.quantile(r, 0.5) * c["total_tiv"])
        c["loss_p99"] = float(np.quantile(r, 0.99) * c["total_tiv"])


# ---------------------------------------------------------------------------
# Ex-post P&L
# ---------------------------------------------------------------------------


def realised_event_loss_by_cohort(
    cohorts: list[dict[str, Any]],
    damage_property: float,
    event_state: str,
) -> dict[str, float]:
    """Apportion the realised damage_property dollar amount across cohorts.

    Cohorts in the event's state absorb the entire realised loss in
    proportion to their TIV share within that state.  This matches the
    spec's "damage_property * cohort.tiv / state_book_tiv" formulation.
    """
    state_cohorts = [c for c in cohorts if c.get("state") == event_state]
    state_tiv = sum(c["total_tiv"] for c in state_cohorts)
    losses: dict[str, float] = {c["id"]: 0.0 for c in cohorts}
    if state_tiv <= 0:
        return losses
    for c in state_cohorts:
        share = c["total_tiv"] / state_tiv
        losses[c["id"]] = damage_property * share
    return losses


def compute_pnl(
    cohorts: list[dict[str, Any]],
    actions: list[dict[str, Any]],
    realised_losses: dict[str, float],
) -> dict[str, float]:
    """Compute portfolio P&L given the MIP's per-cohort action mix.

    Premium collected: premium * Σ_a x[c,a] * REPRICE_FACTOR[a]
    Loss paid:        realised_loss * Σ_a x[c,a] * LOSS_FACTOR[a]
    Cession cost:     premium * (x[c,cede_qs]*0.6 + x[c,cede_xs]*0.15)
    Net = premium_collected - loss_paid - cession_cost
    """
    from api_py.optimize_portfolio import (
        REPRICE_FACTOR, LOSS_FACTOR,
    )

    actions_by_id = {a["cohort_id"]: a for a in actions}
    total_premium = 0.0
    total_loss = 0.0
    total_cession = 0.0

    for c in cohorts:
        a = actions_by_id.get(c["id"])
        if a is None:
            continue
        premium = c["total_premium"]
        rloss = realised_losses.get(c["id"], 0.0)

        prem_eff = sum(a.get(act, 0.0) * REPRICE_FACTOR[act]
                       for act in REPRICE_FACTOR)
        loss_eff = sum(a.get(act, 0.0) * LOSS_FACTOR[act]
                       for act in LOSS_FACTOR)
        cession_eff = (
            a.get("cede_qs", 0.0) * 0.6 + a.get("cede_xs", 0.0) * 0.15
        )

        total_premium += premium * prem_eff
        total_loss    += rloss   * loss_eff
        total_cession += premium * cession_eff

    return {
        "premium_collected": float(total_premium),
        "loss_paid": float(total_loss),
        "cession_cost": float(total_cession),
        "net_pnl": float(total_premium - total_loss - total_cession),
    }


def baseline_pnl(
    cohorts: list[dict[str, Any]],
    realised_losses: dict[str, float],
) -> dict[str, float]:
    """Retain-everything baseline: all premium collected, all losses borne."""
    total_premium = sum(c["total_premium"] for c in cohorts)
    total_loss = sum(realised_losses.values())
    return {
        "premium_collected": float(total_premium),
        "loss_paid": float(total_loss),
        "cession_cost": 0.0,
        "net_pnl": float(total_premium - total_loss),
    }


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def evaluate_event(
    event: tuple,
    cohorts: list[dict[str, Any]],
    capital_budget: float,
    cession_budget: float,
) -> dict[str, Any]:
    """Run the FORGE pipeline for one holdout event.  Returns one record."""
    from ml.scenarios.generate import generate_scenarios
    from api_py.optimize_portfolio import solve

    event_id, year, state, county, event_type, peak_wind_db, damage = event
    realized_wind = (
        float(peak_wind_db) if peak_wind_db is not None
        else _REALIZED_WIND_BY_TYPE.get(event_type, 70.0)
    )
    damage = float(damage) if damage is not None else 0.0

    base = {
        "event_id": event_id,
        "year": int(year),
        "state": state,
        "county": county,
        "event_type": event_type,
        "realized_peak_wind_mph": realized_wind,
        "damage_property": damage,
    }

    try:
        # 1. Generate scenarios (deep-copy cohorts so we don't leak state
        #    across events).
        scenarios = generate_scenarios(f"holdout_{event_id}", n=N_SCENARIOS)

        # 2. Derive loss_p50 / loss_p99 per cohort for this event.
        local_cohorts = [dict(c) for c in cohorts]
        compute_cohort_losses(local_cohorts, scenarios)

        # 3. Solve the MIP.  Strip non-MIP fields to keep the payload lean.
        mip_cohorts = [
            {
                "id": c["id"],
                "tiv": c["total_tiv"],
                "total_tiv": c["total_tiv"],
                "total_premium": c["total_premium"],
                "loss_p50": c["loss_p50"],
                "loss_p99": c["loss_p99"],
                "zip3": c["zip3"],
            }
            for c in local_cohorts
        ]
        mip_result = solve(
            mip_cohorts,
            capital_budget=capital_budget,
            max_nonrenew_pct=NONRENEW_CAP_PCT,
            cession_budget=cession_budget,
        )

        # 4. Realised loss apportionment.
        realised = realised_event_loss_by_cohort(local_cohorts, damage, state)

        forge = compute_pnl(local_cohorts, mip_result["actions"], realised)
        base_ = baseline_pnl(local_cohorts, realised)

        return {
            **base,
            "mip_status": mip_result["status"],
            "mip_objective": mip_result["objective"],
            "forge_pnl": forge["net_pnl"],
            "baseline_pnl": base_["net_pnl"],
            "improvement": forge["net_pnl"] - base_["net_pnl"],
            "forge_breakdown": forge,
            "baseline_breakdown": base_,
        }
    except Exception as exc:
        return {
            **base,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(),
            "forge_pnl": None,
            "baseline_pnl": None,
            "improvement": None,
        }


def main() -> dict[str, Any]:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    print("[end_to_end] aggregating cohorts …")
    cohorts = aggregate_cohorts()
    total_tiv = sum(c["total_tiv"] for c in cohorts)
    capital_budget = total_tiv * CAPITAL_BUDGET_PCT
    cession_budget = total_tiv * CESSION_BUDGET_PCT
    print(f"  {len(cohorts):,} cohorts  total_tiv=${total_tiv:,.0f}  "
          f"capital_budget=${capital_budget:,.0f}  "
          f"cession_budget=${cession_budget:,.0f}")

    print("[end_to_end] selecting top-5 holdout events …")
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT event_id, year, state, county, event_type, peak_wind, "
            "       damage_property "
            "  FROM storm_events "
            " WHERE (year = 2024 OR year = 2025) "
            "   AND damage_property IS NOT NULL "
            " ORDER BY damage_property DESC "
            " LIMIT ?",
            (N_EVENTS,),
        )
        events = cur.fetchall()
    finally:
        conn.close()
    print(f"  {len(events)} events selected")

    print("[end_to_end] running per-event evaluation …")
    event_records: list[dict[str, Any]] = []
    for ev in events:
        rec = evaluate_event(ev, cohorts, capital_budget, cession_budget)
        if rec.get("forge_pnl") is None:
            print(f"  {rec['event_id']} ({rec['state']}): ERROR — "
                  f"{rec.get('error', 'unknown')}")
        else:
            print(f"  {rec['event_id']} ({rec['state']}): "
                  f"FORGE=${rec['forge_pnl']:,.0f}  "
                  f"baseline=${rec['baseline_pnl']:,.0f}  "
                  f"Δ=${rec['improvement']:,.0f}")
        event_records.append(rec)

    valid_improvements = [
        e["improvement"] for e in event_records if e.get("improvement") is not None
    ]
    summary: dict[str, Any] = {
        "n_events": len(event_records),
        "n_evaluated": len(valid_improvements),
        "mean_improvement": (
            float(np.mean(valid_improvements)) if valid_improvements else None
        ),
        "median_improvement": (
            float(np.median(valid_improvements)) if valid_improvements else None
        ),
        "total_improvement": (
            float(np.sum(valid_improvements)) if valid_improvements else None
        ),
    }

    payload = {"events": event_records, "summary": summary}
    OUT_JSON.write_text(json.dumps(payload, indent=2, default=float))
    print(f"[end_to_end] wrote {OUT_JSON}")

    # Plot
    if valid_improvements:
        _plot_improvements(event_records)
        print(f"[end_to_end] wrote {OUT_PNG}")
    else:
        print("[end_to_end] no valid events — skipping plot")

    return payload


def _plot_improvements(records: list[dict[str, Any]]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels: list[str] = []
    values: list[float] = []
    for r in records:
        if r.get("improvement") is None:
            continue
        labels.append(f"{r['event_id'][:7]}\n{r['state']}")
        values.append(r["improvement"])

    fig, ax = plt.subplots(figsize=(8, 4.5))
    colors = ["#1f7a3a" if v >= 0 else "#a83232" for v in values]
    ax.bar(labels, values, color=colors)
    ax.axhline(0, color="black", linewidth=0.8)
    ax.set_ylabel("FORGE − Baseline net P&L (USD)")
    ax.set_title("FORGE vs. retain-everything baseline (5 holdout 2024 events)")
    ax.ticklabel_format(axis="y", style="sci", scilimits=(0, 0))
    fig.tight_layout()
    fig.savefig(OUT_PNG, dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    main()
