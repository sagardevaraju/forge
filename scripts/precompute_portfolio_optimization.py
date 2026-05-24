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

import argparse
import json
import math
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as _pq

# Make ``api_py`` importable when this script is run as ``python -m`` or directly.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ARTIFACTS_ROOT = ROOT / "artifacts"
SIMS_ROOT = ARTIFACTS_ROOT / "simulations"


def _resolve_sim_ids(include: str | None) -> list[str]:
    """Expand the --include-sims argument to a list of sim_id strings."""
    if not include:
        return []
    if include == "all":
        if not SIMS_ROOT.exists():
            return []
        return sorted({p.stem for p in SIMS_ROOT.glob("*.parquet")})
    return [s.strip() for s in include.split(",") if s.strip()]


def _load_sim_losses(sim_id: str) -> tuple[dict[str, list[float]], dict]:
    """Read a sim parquet and return (losses_by_cohort, meta_dict)."""
    parquet = SIMS_ROOT / f"{sim_id}.parquet"
    meta = SIMS_ROOT / f"{sim_id}.meta.json"
    if not parquet.exists():
        raise FileNotFoundError(f"sim parquet missing: {parquet}")
    table = _pq.read_table(parquet)
    cohort_col = table.column("cohort_key").to_pylist()
    k_cols = [c for c in table.column_names if c.startswith("k")]
    losses_by_cohort = {
        cohort_col[i]: [float(table.column(c)[i].as_py()) for c in k_cols]
        for i in range(len(cohort_col))
    }
    return losses_by_cohort, json.loads(meta.read_text())

from api_py.cohort_keys import cohort_key as _cohort_key, policy_quintile_lookup  # noqa: E402
from api_py.multi_peril_aal import (  # noqa: E402
    PERIL_IDS as _MULTI_PERIL_IDS,
    additional_peril_scenarios as _additional_peril_scenarios,
)
from api_py.optimize_portfolio import ACTIONS, solve  # noqa: E402

# Load the zip3 → state geography once. The book is currently CONUS coastal
# SE (TX/LA/NC/FL — 4 states, 38 zip3s). Out-of-book zip3s fall back to a
# 'default' AAL rate inside multi_peril_aal.
_ZIP3_GEO_PATH = ROOT / "lib" / "regulatory" / "zip3_geo.json"
_ZIP3_GEO: dict[str, dict] = json.loads(_ZIP3_GEO_PATH.read_text())


def _state_for_zip3(zip3: str) -> str:
    """Resolve a zip3 → 2-letter USPS state code. Returns 'XX' (synthetic
    fallback that hits multi_peril_aal's 'default' branch) for unknown zip3s,
    rather than raising — the precompute should never crash on a
    well-formed but unseeded zip3."""
    entry = _ZIP3_GEO.get(zip3)
    return entry["state"] if entry else "XX"

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
# HAZUS-derived annual loss prior. Calibrated against published FL/SE
# coastal homeowners benchmarks:
#
#   * Citizens Property Insurance Corp. — 2024 forecast net loss ratio
#     37.7 % (2023: 42.8 %); FL OIR public hearing slides Aug 2024.
#   * A.M. Best — *Florida Property Insurance Market Update*, May 2024:
#     domestic-specialist combined ratio improved from 204 % (2022, Ian
#     year) to 59.5 % (2023); 18 of 22 largest carriers posted profit.
#   * FHCF — *2024 Aggregate Net PML Report*: Citizens 1-in-100 PML
#     $12.86 B end-2024 (was $17.7 B end-2023); mean book AAL ≈ $1.8 B
#     ⇒ PML/AAL ≈ 7×.
#
# Resulting book-weighted statistics (with `premium_annual ≈ 1.65 % of
# TIV` from `seed_policy_book.py`):
#
#   * Expected loss ratio at p50 ~ 35-45 % (Citizens FL 2024 forecast)
#   * Tail σ = 0.85 ⇒ p99/p50 ≈ 7× (matches Citizens FHCF PML/AAL
#     anchor; thinner than full-cat AEP curves but appropriate for the
#     base prior — the heavy cat tail enters via merged sim scenarios,
#     §K_SCENARIOS docstring + the `_resolve_sim_ids` path).
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Per-zone expected-loss fanout — derived from real NFIP claim data, NOT
# hand-picked. Computed from OpenFEMA endpoints on 2026-05-23:
#   - FimaNfipClaims: 166,234 paid claims with non-zero building loss,
#     2018-2023 (6-year window). Average building-claim severity per
#     zone: X=$41,192, A=$41,907, AE=$65,034, VE=$100,370.
#   - FimaNfipPolicies: 3,649,432 policies in force in 2021.
#     Per-zone claims-per-policy frequency: X=0.36%, A=0.86%, AE=1.20%,
#     VE=1.83% annual.
#   - Expected loss per policy = frequency × severity.
#     X=$150/yr, A=$359/yr, AE=$783/yr, VE=$1,838/yr.
#   - Ratios vs Zone X (baseline 1.000):
#     X=1.00, A=2.40, AE=5.23, VE=12.29.
#
# These are the actual NFIP loss-cost ratios — superseding the previous
# hand-picked {X:0.6, A:1.0, AE:1.4, VE:2.2} which understated AE and
# VE by 3.7× and 5.6× respectively. See research.md §9b for the
# OpenFEMA query and full derivation.
FLOOD_ZONE_SEVERITY: dict[str, float] = {
    "X":  1.00,
    "A":  2.40,
    "AE": 5.23,
    "VE": 12.29,
}

# Per-build-type vulnerability — derived from HAZUS-MH Hurricane
# Technical Manual wind damage curves at a Cat-2 wind speed (110 mph,
# a representative coastal southeast peril). HAZUS-MH wind damage
# fractions at 110 mph:
#   wood_frame:   ~5%  → ratio 1.00 (baseline)
#   masonry:      ~2%  → ratio 0.40 (more wind-resistant walls)
#   manufactured: ~15% → ratio 3.00 (mobile-home vulnerability)
#
# Wood frame is the reference (1.00). Masonry takes ~40% of wood-frame
# damage; manufactured takes ~3× wood-frame damage. These match the
# ratios in `lib/sim/severity.ts::HAZUS_MATRIX` and the HAZUS Hurricane
# tables. Previous {wood:1.0, masonry:0.55, manufactured:1.9} used the
# wrong masonry ratio (0.55 implies 55% — too high; reality is closer
# to 40%) and the wrong manufactured ratio (1.9 vs 3.0). See
# research.md §9c.
BUILD_VULNERABILITY: dict[str, float] = {
    "wood_frame":   1.00,
    "masonry":      0.40,
    "manufactured": 3.00,
}

# Tail σ for the lognormal posterior on each cohort's annual loss.
# Previously implicit-from-p99=4×p50 ⇒ σ ≈ 0.596 (too thin for a coastal
# book; lower bound of FL HO industry tails). Bumped to σ = 0.85 so
# p99/p50 = exp(2.326 × σ) ≈ 7.2 — anchored to the Citizens FL FHCF PML/
# AAL ratio (~7×) for the no-cat-year baseline. Heavier cat tails enter
# the artifact via promoted simulation scenarios when --include-sims=all
# is passed; recomputation of `book_totals.loss_p99` from the merged
# samples (below in main()) captures them.
PRIOR_SIGMA: float = 0.85
# p99/p50 multiplier under PRIOR_SIGMA. Used by `_cohort_loss_quantiles`
# to derive p99 from p50 consistently with the lognormal draws.
PRIOR_P99_P50: float = math.exp(PHI_INV_99 * PRIOR_SIGMA)  # ≈ 7.21


def _cohort_loss_quantiles(
    total_tiv: float,
    modal_flood_zone: str,
    build_type: str,
    avg_elevation_m: float,
    zip3: str,
    tiv_quintile: int,
) -> tuple[float, float, list[float]]:
    """Return ``(loss_p50, loss_p99, loss_scenarios)`` for the cohort.

    The scalar quantiles use a HAZUS-derived prior calibrated to FL/SE
    homeowners benchmarks (see module-level FLOOD_ZONE_SEVERITY /
    BUILD_VULNERABILITY citations):

        p50 = total_tiv × annual_loss_rate
        p99 = p50 × PRIOR_P99_P50   (≈ 7.21 under PRIOR_SIGMA = 0.85)

    Tail-heaviness anchor: FHCF 2024 Aggregate Net PML report puts
    Citizens FL 1-in-100 PML / mean book loss at ≈ 7×. Pre-2026 the
    ratio was hard-coded to 4× (σ ≈ 0.596), which is the lower end of
    the Florida HO range and produced a structurally infeasible MIP
    once promoted simulation scenarios entered the mix (their empirical
    p99/p50 was 22× and they tripped the capital constraint, but the
    capital BUDGET was being computed from the still-thin 4× prior).
    σ = 0.85 ⇒ p99/p50 ≈ 7.21 closes most of that gap; the rest enters
    via `main()` recomputing book_totals from merged samples.

    Task P2.0 additionally emits ``loss_scenarios`` — a list of K = 1000
    draws from the lognormal posterior whose median is ``p50`` and whose
    σ equals ``PRIOR_SIGMA``. The (μ, σ) of the lognormal:

        X ~ Lognormal(μ, σ²)
        median(X) = exp(μ)              ⇒ μ = log(p50)
        P99(X)    = exp(μ + Φ⁻¹(0.99) σ) ⇒ p99 = p50 × exp(2.326 × σ)

    The draws are seeded with ``hash((zip3, build_type, q)) & 0xFFFFFFFF``
    so that the artifact is reproducible *within a single precompute
    run*. Python's ``hash()`` for strings is randomized per interpreter,
    which is the granularity we want: re-running the precompute produces
    a deterministic artifact from start to finish, but the seed is not
    leaked across runs (it's a Monte-Carlo, not a regression fixture).
    """
    zone_factor = FLOOD_ZONE_SEVERITY.get(modal_flood_zone, 1.0)
    build_factor = BUILD_VULNERABILITY.get(build_type, 1.0)
    # Elevation gives a partial mitigation against the FLOOD component of
    # total expected loss only (wind/hail/fire are elevation-independent).
    # HAZUS-Flood TM 4.0 depth-damage curves indicate ~10% damage reduction
    # per foot of first-floor elevation above BFE at the low-depth regime
    # (0-3ft). Translating to per-meter and applying only to the flood
    # component (~30% of total loss for the AE/VE-heavy book mix),
    # 0.05/m × full multiplier ≈ HAZUS gradient. Floor at 0.70 reflects
    # that elevation can't mitigate wind/hail/fire. See research.md §9d.
    elev_factor = max(0.70, 1.0 - 0.05 * max(0.0, avg_elevation_m))
    # Base catastrophe-exposed homeowner loss rate, calibrated so that the
    # book-weighted expected loss (×zone, build, elev) lands near 0.55% of
    # TIV/year — the industry HO-3 incurred-loss-ratio benchmark for the
    # coastal Southeast (Citizens FL 2024 forecast ~37.7% net of cessions
    # on ~1% TIV premium = ~0.38% TIV; broader Florida industry runs
    # closer to 0.55-0.65% TIV in normal years; cat years are layered in
    # later via merged sim scenarios). Previous base of 0.012 with the
    # earlier (uncited) zone × build factors produced 0.88% book-avg
    # expected loss, overstating normal-year severity by ~60%. See
    # research.md §9e.
    annual_loss_rate = 0.0023 * zone_factor * build_factor * elev_factor
    p50 = total_tiv * annual_loss_rate
    # p99 = p50 × exp(Φ⁻¹(0.99) × σ). Derived from PRIOR_SIGMA so the
    # scalar quantile and the K=1000 draws stay consistent.
    p99 = p50 * PRIOR_P99_P50

    # Reconstruct (μ, σ) of the lognormal posterior and draw K samples.
    if p50 > 0:
        mu = math.log(p50)
        seed = hash((zip3, build_type, tiv_quintile)) & 0xFFFFFFFF
        rng = np.random.default_rng(seed=seed)
        # ``lognormal`` parameterized by (mean, sigma) of the underlying
        # normal. σ comes from PRIOR_SIGMA so the empirical p99 of these
        # draws matches the scalar p99 above (to within sampling noise).
        scenarios = rng.lognormal(mean=mu, sigma=PRIOR_SIGMA, size=K_SCENARIOS)
        loss_scenarios = [float(x) for x in scenarios]
    else:
        # Pathological zero-TIV cohort: deterministic zeros.
        loss_scenarios = [0.0] * K_SCENARIOS

    return p50, p99, loss_scenarios


def _aggregate_cohorts_from_sqlite(
    db_path: Path,
    multi_peril: bool = True,
) -> list[dict]:
    """Read the policy book and aggregate into cohorts.

    Mirrors the JS aggregation in lib/db/cohorts.ts (same cohort key, quintile
    TIV bucket) so the JS-rendered map matches the Python-side MIP keys 1:1.

    The quintile cut-point logic is delegated to
    ``api_py.cohort_keys.policy_quintile_lookup`` so that the promote path
    (``api_py._solve_stdin._handle_sim_loss``) uses bit-identical cuts and
    emits keys that match the MIP cohort store directly.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, zip3, build_type, tiv, premium_annual, flood_zone, elevation_m FROM policies"
    ).fetchall()
    conn.close()

    if not rows:
        return []

    # Build (id, lat=0, lon=0, tiv, build_type, zip3) tuples — lat/lon not
    # needed for quintile computation; only id and tiv are used by the helper.
    policy_tuples = [
        (int(r["id"]), 0.0, 0.0, float(r["tiv"]), str(r["build_type"]), str(r["zip3"]))
        for r in rows
    ]
    quintile_by_id = policy_quintile_lookup(policy_tuples)

    buckets: dict[str, dict] = {}
    for r in rows:
        zip3 = str(r["zip3"])
        bt = str(r["build_type"])
        quintile = quintile_by_id[int(r["id"])]
        key = _cohort_key((int(r["id"]), 0.0, 0.0, float(r["tiv"]), bt, zip3), quintile)
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

        cohort_id = b["id"]
        peril_p99: dict[str, float] = {"hurricane": p99}
        if multi_peril:
            # Joint multi-peril TVaR-99: layer SCS / Winter / Wildfire /
            # Earthquake AAL contributions on top of the hurricane-anchored
            # prior. The existing prior stays hurricane-only (no
            # double-counting); per-peril scenarios are independent draws
            # summed elementwise. See api_py/multi_peril_aal.py for the
            # calibration and citation sources.
            state = _state_for_zip3(b["zip3"])
            base_scenarios = np.asarray(scenarios, dtype=float)
            extras = _additional_peril_scenarios(
                total_tiv=b["total_tiv"],
                state=state,
                build_type=b["build_type"],
                cohort_key=cohort_id,
                n=K_SCENARIOS,
            )
            for peril_id in _MULTI_PERIL_IDS:
                base_scenarios = base_scenarios + extras[peril_id]
                peril_p99[peril_id] = float(np.percentile(extras[peril_id], 99))
            # Refresh scalar quantiles to reflect the joint distribution.
            p50 = float(np.percentile(base_scenarios, 50))
            p99 = float(np.percentile(base_scenarios, 99))
            scenarios = [float(x) for x in base_scenarios]

        out.append(
            {
                "id": cohort_id,
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
                # before the front-end ever sees this array. When
                # multi_peril=True, these are JOINT (hurricane + SCS +
                # winter + wildfire + earthquake) draws.
                "loss_scenarios": scenarios,
                # Joint multi-peril breakdown — per-peril p99 contribution
                # (hurricane is the existing prior; others come from
                # api_py/multi_peril_aal.py). Used by UI to render a
                # "Tail by peril" breakdown without re-running the MC.
                # Stays single-key ({"hurricane": p99}) when
                # multi_peril=False for backward compat.
                "loss_p99_by_peril": peril_p99,
            }
        )
    out.sort(key=lambda c: c["id"])
    return out


def _build_cohorts(multi_peril: bool = True) -> list[dict]:
    """Load the policy book from forge-local.db and return aggregated cohorts.

    Extracted from ``main()`` (Task 7) so ``main(argv)`` can call it cleanly
    before optionally merging in sim losses.

    ``multi_peril=True`` (default) layers SCS / winter / wildfire /
    earthquake AAL on top of the hurricane-anchored prior to produce JOINT
    multi-peril ``loss_scenarios`` per cohort.
    """
    db_path = ROOT / "forge-local.db"
    if not db_path.exists():
        raise SystemExit(f"forge-local.db not found at {db_path}")
    cohorts = _aggregate_cohorts_from_sqlite(db_path, multi_peril=multi_peril)
    mode = "joint multi-peril" if multi_peril else "hurricane-only (legacy)"
    print(f"Aggregated {len(cohorts)} cohorts from {db_path.name} [{mode}]")
    return cohorts


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Pre-compute Portfolio MIP result and cache artifacts."
    )
    parser.add_argument(
        "--include-sims",
        default=None,
        help=(
            "Comma-separated sim_ids, or 'all'. Concatenates their K-loss "
            "draws onto the per-cohort hurricane scenario set before TVaR-99."
        ),
    )
    parser.add_argument(
        "--no-multi-peril",
        action="store_true",
        help=(
            "Disable joint multi-peril aggregation. Reverts to "
            "hurricane-only loss scenarios (Phase 2 behaviour) for "
            "backward-compatibility verification. Default OFF: the joint "
            "SCS / winter / wildfire / earthquake AAL overlay is applied."
        ),
    )
    args = parser.parse_args(argv)

    multi_peril = not args.no_multi_peril
    cohorts = _build_cohorts(multi_peril=multi_peril)

    # Task 7: merge simulated event losses into the joint scenario set.
    sim_ids = _resolve_sim_ids(args.include_sims)
    sim_meta_records: list[dict] = []
    if sim_ids:
        for sim_id in sim_ids:
            losses_by_cohort, sim_meta = _load_sim_losses(sim_id)
            sim_meta_records.append(sim_meta)
            for c in cohorts:
                extra = losses_by_cohort.get(c["id"])
                if extra:
                    c["loss_scenarios"] = list(c.get("loss_scenarios", [])) + extra

    total_tiv = sum(c["total_tiv"] for c in cohorts)
    total_premium = sum(c["total_premium"] for c in cohorts)

    # ── Recompute book_totals from MERGED loss_scenarios ──────────────────
    # Pre-2026 the artifact emitted book_totals.loss_p50 / loss_p99 as
    # `sum(c.loss_p50)` / `sum(c.loss_p99)` — i.e., the **scalar** prior
    # quantiles, even when sims had been merged onto each cohort's
    # `loss_scenarios`. Those scalars are tail-thin (p99/p50 ≈ 7×) and do
    # not reflect the heavy cat tail that promoted-sim scenarios bring.
    # The UI then displayed "Tail exposure $78M" while the solver's
    # constraint was actually fighting the $400M+ merged TVaR-99, producing
    # mechanical infeasibility on every refresh.
    #
    # Fix: compute book_totals.loss_p50 / loss_p99 / tvar_99 as the
    # **diversified** empirical percentiles of the book-level aggregated
    # loss distribution (Σ cohort losses per scenario). This captures
    # both the lognormal prior and any merged sim event scenarios, and
    # gives credit for portfolio diversification (independent lognormal
    # draws → book tail much thinner than sum-of-cohort tails). Anchors
    # are documented in research.md § "Portfolio loss prior calibration".
    scenarios_matrix = np.array(
        [c.get("loss_scenarios") or [] for c in cohorts], dtype=float,
    )
    if scenarios_matrix.size > 0 and scenarios_matrix.shape[1] > 0:
        book_loss_scenarios = scenarios_matrix.sum(axis=0)
        expected_loss_p50 = float(np.percentile(book_loss_scenarios, 50))
        expected_loss_p99 = float(np.percentile(book_loss_scenarios, 99))
        # TVaR-99 of the merged book distribution — mean of the top 1 %
        # of book-loss scenarios (the diversified statistic).
        threshold = float(np.percentile(book_loss_scenarios, 99))
        tail = book_loss_scenarios[book_loss_scenarios >= threshold]
        book_tvar_99 = float(tail.mean()) if tail.size > 0 else float(book_loss_scenarios.max())
        # Conservative gross sum-of-cohort p99 — ignores diversification.
        # This is the actuarial worst-case retained tail under the
        # default treaty layers (every cohort independently breaches p99
        # in the same year). The capital budget anchors here, NOT on the
        # diversified book_tvar_99, because:
        #
        #   * The diversified book_tvar_99 collapses to ≈ p50 + light
        #     tail on a prior-only artifact (no cat events) — making
        #     0.40 × book_tvar_99 tighter than the minimum retained tail
        #     even with full cede_xs, so the baseline solve is
        #     infeasible on a fresh book without sim merges.
        #   * The sum-of-cohort p99 grows monotonically with merged
        #     sims (each promoted hurricane pushes the per-cohort
        #     empirical p99 up), so the budget tracks cat exposure
        #     correctly under the merge path.
        sum_cohort_p99 = float(np.percentile(scenarios_matrix, 99, axis=1).sum())
    else:
        expected_loss_p50 = sum(c["loss_p50"] for c in cohorts)
        expected_loss_p99 = sum(c["loss_p99"] for c in cohorts)
        book_tvar_99 = expected_loss_p99
        sum_cohort_p99 = expected_loss_p99

    print(f"  Book TIV: ${total_tiv:,.0f}")
    print(f"  Book premium: ${total_premium:,.0f}")
    print(f"  Book p50 loss (diversified):       ${expected_loss_p50:,.0f}")
    print(f"  Book p99 loss (diversified):       ${expected_loss_p99:,.0f}")
    print(f"  Book TVaR-99 (mean top 1 %, div):  ${book_tvar_99:,.0f}")
    print(f"  Σ per-cohort p99 (gross):           ${sum_cohort_p99:,.0f}")
    print(f"  Implied loss ratio at p50:          {expected_loss_p50/total_premium*100:.1f}%")

    # Capital budget anchored on Σ per-cohort p99 (gross, no
    # diversification credit) at 0.40 ×. This is the actuarial
    # conservative anchor: retain up to 40 % of the worst-case
    # one-in-100 tail if every cohort breached independently. Yields a
    # feasible solve at the prior-only baseline AND tracks cat exposure
    # when sims are merged (Σ per-cohort empirical p99 climbs with each
    # promoted hurricane).
    capital_budget = sum_cohort_p99 * 0.40
    max_nonrenew_pct = 0.15                     # may non-renew up to 15% of TIV
    cession_budget = total_premium * 0.10       # 10% of premium for cession
    print(f"  ⇒ capital_budget = ${capital_budget:,.0f} (40 % of Σ per-cohort p99)")

    result = solve(
        cohorts=cohorts,
        capital_budget=capital_budget,
        max_nonrenew_pct=max_nonrenew_pct,
        cession_budget=cession_budget,
        horizon_start=HORIZON_START,
        horizon_end=HORIZON_END,
        risk_measure="tvar_99" if sim_ids else "var_99",
    )
    is_infeasible = result["status"] == "Infeasible"
    obj_value = result.get("objective")
    obj_display = "—" if obj_value is None else f"${obj_value:,.0f}"
    print(
        f"MIP status: {result['status']}  "
        f"solver_mode: {result.get('solver_mode', 'milp')}  "
        f"objective: {obj_display}"
    )
    if is_infeasible:
        print(
            "  ⚠ Infeasible — capital_budget tighter than the minimum"
            " achievable retained tail under the 15 % non-renew cap +"
            " cession headroom. The artifact is being written with"
            " objective=null and zeroed action shares so the UI can"
            " surface a banner instead of a fake margin number."
        )

    # Decorate each action row with the dominant action label + dominant share
    # so the front-end doesn't need to recompute argmax. ACTIONS is sourced
    # from optimize_portfolio.py so the schema stays in lock-step with the
    # MILP definition (Task P2.8: 11 actions = retain + 7-bucket rate grid +
    # non_renew + cede_qs + cede_xs).
    #
    # Infeasible solves are special-cased: every action row has all-zero
    # shares from the solver, so the `max(ACTIONS, key=...)` argmax
    # would arbitrarily pick "retain" and inflate the action_summary
    # with a 570-cohort "retain" allocation that doesn't exist. We
    # instead leave the summary empty (every action count = 0) and mark
    # each row's dominant_action as None so downstream consumers can
    # render "— infeasible" rather than a fabricated dominant action.
    cohort_by_id = {c["id"]: c for c in cohorts}
    enriched_actions = []
    action_summary = {a: {"count": 0, "tiv": 0.0} for a in ACTIONS}
    for row in result["actions"]:
        cid = row["cohort_id"]
        if is_infeasible:
            enriched = {**row, "dominant_action": None, "dominant_share": 0.0}
            enriched_actions.append(enriched)
            continue
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
        #   5 — 2026-05-23: book_totals.loss_p50/loss_p99 are now the
        #       empirical p50/p99 of the BOOK-LEVEL aggregated loss
        #       distribution (Σ cohort losses per scenario), not the
        #       sum of per-cohort scalar quantiles. Adds
        #       book_totals.tvar_99 (mean of top 1 % of book-loss
        #       scenarios). Adds top-level `retained_tvar_99`: the
        #       realized retained tail under the materialized action mix
        #       (what the "Tail exposure" UI card should actually read).
        #       Adds top-level `infeasibility_reason` (string | null) so
        #       the UI can explain why an Infeasible solve happened
        #       without inventing a reason from constraint deltas.
        #   6 — 2026-05-24: cohorts now carry `loss_p99_by_peril:
        #       dict[str, float]` (hurricane + scs + winter + wildfire +
        #       earthquake). `loss_scenarios` are joint draws (sum of
        #       per-peril independent lognormals) when multi_peril=True.
        #       Top-level `multi_peril_enabled: bool` records whether the
        #       overlay was applied. UI components consuming v5 should
        #       continue to work (loss_scenarios + loss_p50 + loss_p99
        #       remain populated); the new fields are additive.
        # Holders of v1-v5 artifacts must re-run
        # `python -m scripts.precompute_portfolio_optimization` to refresh.
        "schema_version": 6,
        "multi_peril_enabled": multi_peril,
        # Per-peril identifiers shipped in cohort.loss_p99_by_peril. Always
        # present (single 'hurricane' entry when multi_peril=False) so
        # consumers can iterate uniformly.
        "perils_modeled": ["hurricane"] + (
            list(_MULTI_PERIL_IDS) if multi_peril else []
        ),
        "status": result["status"],
        # P2.8: surface which solver path produced this artifact (milp vs
        # lp_relaxed_rounded). UI consumers can render a footnote if the
        # fallback engaged.
        "solver_mode": result.get("solver_mode", "milp"),
        "objective": result["objective"],
        # Realized retained tail under the materialized action mix.
        # Mirrors api_py/optimize_portfolio.py::solve() return value;
        # null when the solver could not compute it (no loss_scenarios on
        # cohorts, or status=Infeasible).
        "retained_tvar_99": result.get("retained_tvar_99"),
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
            "tvar_99": book_tvar_99,
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

    # Task 7: write sidecar meta artifact so the UI and downstream scripts know
    # which simulations were folded in and which risk measure was used.
    import datetime as _dt
    meta_out = ARTIFACTS_ROOT / "portfolio_optimization.meta.json"
    meta_out.write_text(json.dumps({
        "hurricane_scenario_set": "AL092024",
        "included_sims": sim_ids,
        "simulations_log": sim_meta_records,
        "solved_at": _dt.datetime.utcnow().isoformat() + "Z",
    }, indent=2))
    print(f"Wrote {meta_out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
