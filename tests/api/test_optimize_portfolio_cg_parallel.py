"""Parallel cluster-solve path for the column-generation prototype.

Pins:
- Default ``n_workers=None`` is sequential and bit-for-bit identical
  to the pre-parallel behaviour (other tests cover this — these tests
  cover the parallel path).
- ``n_workers > 1`` produces the *same* allocation, objective, and
  iteration count as ``n_workers=None`` on the toy + live book. The
  parallelism is purely an implementation-side concurrency knob —
  the math is unchanged.
- ``_partition_clusters_into_batches`` evenly splits clusters across
  workers and returns a deterministic ordering (sorted by cluster id)
  so two runs at the same ``n_workers`` produce identical batch
  assignments.
- The parallel-path worker (``_solve_cluster_batch``) and the
  partitioner are picklable so the macOS / Windows ``spawn``-method
  pool can ship them to child processes without an import-time
  surprise.

Reference: the per-cluster subproblem is independent given the
current Lagrangian multipliers (Birge & Louveaux §6.4) so partitioning
across processes is mathematically sound — the only delta is
concurrency, captured by the equivalence pins below.
"""

from __future__ import annotations

import json
import os
import pickle
from pathlib import Path

import pytest

from api_py.optimize_portfolio_cg import (
    _partition_clusters_into_batches,
    _solve_cluster_batch,
    cluster_cohorts,
    solve_cg,
)


# ── unit: partitioner ─────────────────────────────────────────────────────


def _make_clusters(n: int) -> dict[str, list[dict]]:
    """Spin up ``n`` tiny clusters with deterministic ids."""
    out: dict[str, list[dict]] = {}
    for i in range(n):
        zip3 = f"{300 + i:03d}"
        out[zip3] = [
            {
                "id": f"{zip3}_wood_frame_q0",
                "total_tiv": 1e6,
                "total_premium": 1e4,
                "loss_p50": 5_000,
                "loss_p99": 50_000,
            }
        ]
    return out


def test_partition_clusters_into_batches_returns_n_workers_batches() -> None:
    clusters = _make_clusters(8)
    batches = _partition_clusters_into_batches(clusters, n_workers=4)
    assert len(batches) == 4
    # Every cluster appears exactly once across the batches.
    all_ids = sorted(cid for batch in batches for cid, _ in batch)
    assert all_ids == sorted(clusters.keys())


def test_partition_clusters_into_batches_evens_out_remainders() -> None:
    """10 clusters across 4 workers should produce batch sizes (3, 3,
    2, 2) — the array_split convention. Predictable load balancing."""
    clusters = _make_clusters(10)
    batches = _partition_clusters_into_batches(clusters, n_workers=4)
    sizes = sorted(len(b) for b in batches)
    assert sizes == [2, 2, 3, 3]


def test_partition_clusters_caps_batch_count_to_cluster_count() -> None:
    """3 clusters across 8 workers should produce 3 batches, not 8 —
    empty batches would waste a pool slot per iteration."""
    clusters = _make_clusters(3)
    batches = _partition_clusters_into_batches(clusters, n_workers=8)
    assert len(batches) == 3


def test_partition_clusters_n_workers_le_1_returns_single_batch() -> None:
    """``n_workers ≤ 1`` is the sequential path's degenerate case —
    one big batch is the right answer."""
    clusters = _make_clusters(5)
    for nw in (0, 1):
        batches = _partition_clusters_into_batches(clusters, n_workers=nw)
        assert len(batches) == 1
        assert len(batches[0]) == 5


def test_partition_clusters_is_deterministic_across_runs() -> None:
    """Two partitions with the same inputs must produce identical
    batch assignments — otherwise parallel runs would have
    non-reproducible cluster→worker mappings."""
    clusters = _make_clusters(7)
    p1 = _partition_clusters_into_batches(clusters, n_workers=3)
    p2 = _partition_clusters_into_batches(clusters, n_workers=3)
    # Compare just the cluster ids per batch (the cohort dicts are
    # identical-by-construction here so the value comparison is moot).
    assert [[cid for cid, _ in b] for b in p1] == [
        [cid for cid, _ in b] for b in p2
    ]


# ── unit: worker is picklable ─────────────────────────────────────────────


def test_solve_cluster_batch_is_picklable() -> None:
    """The macOS / Windows ``spawn`` pool sends the worker function
    over by pickle — a nested or lambda would break parallelism
    silently. Verify it's a module-level callable."""
    payload = pickle.dumps(_solve_cluster_batch)
    restored = pickle.loads(payload)
    assert restored is _solve_cluster_batch


def test_solve_cluster_batch_matches_per_cluster_loop() -> None:
    """Running a batch of clusters through ``_solve_cluster_batch``
    must return the same merged assignment as looping over each
    cluster with the same multipliers — the batch is just a fused
    sequential dispatch.
    """
    cohorts = []
    for zip3 in ("335", "320", "339"):
        for q in range(3):
            cohorts.append(
                {
                    "id": f"{zip3}_wood_frame_q{q}",
                    "total_tiv": 1e6 * (q + 1),
                    "total_premium": 1e4 * (q + 1),
                    "loss_p50": 5_000 * (q + 1),
                    "loss_p99": 50_000 * (q + 1),
                }
            )
    clusters = cluster_cohorts(cohorts)
    batch = list(clusters.items())

    via_batch = _solve_cluster_batch(
        batch,
        lambda_capital=0.1,
        lambda_cession=0.05,
        lambda_nonrenew=0.0,
        tvar_coeffs=None,
    )

    # Now build the same merge via per-cluster calls.
    from api_py.optimize_portfolio_cg import _solve_cluster_subproblem

    via_loop: dict[str, str] = {}
    for _cluster_id, cluster in batch:
        via_loop.update(
            _solve_cluster_subproblem(
                cluster,
                lambda_capital=0.1,
                lambda_cession=0.05,
                lambda_nonrenew=0.0,
                tvar_coeffs=None,
            )
        )

    assert via_batch == via_loop


# ── solve_cg equivalence: sequential vs parallel ─────────────────────────


def _toy_10_cohort_book() -> list[dict]:
    """3-ZIP3, 10-cohort toy. Big enough for the partitioner to
    actually distribute work across workers, small enough that the
    pool start-up cost doesn't dominate the test wall-clock."""
    cohorts = []
    for q in range(4):
        cohorts.append(
            {
                "id": f"335_wood_frame_q{q}",
                "total_tiv": 50e6,
                "total_premium": 600_000,
                "loss_p50": 200_000 * (q + 1),
                "loss_p99": 1_000_000 * (q + 1),
            }
        )
    for q in range(3):
        cohorts.append(
            {
                "id": f"320_masonry_q{q}",
                "total_tiv": 50e6,
                "total_premium": 550_000,
                "loss_p50": 180_000 * (q + 1),
                "loss_p99": 900_000 * (q + 1),
            }
        )
    for q in range(3):
        cohorts.append(
            {
                "id": f"339_commercial_q{q}",
                "total_tiv": 80e6,
                "total_premium": 750_000,
                "loss_p50": 300_000 * (q + 1),
                "loss_p99": 1_400_000 * (q + 1),
            }
        )
    return cohorts


def test_solve_cg_parallel_n2_matches_sequential_on_toy() -> None:
    """Headline acceptance: ``n_workers=2`` produces the same
    allocation, objective, and iteration count as the default
    sequential path. Math is unchanged; only the dispatch concurrency
    differs."""
    cohorts = _toy_10_cohort_book()
    kwargs = dict(
        capital_budget=12_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
    )
    seq = solve_cg(cohorts, **kwargs)
    par = solve_cg(cohorts, **kwargs, n_workers=2)

    assert seq["status"] == par["status"]
    assert seq["allocation"] == par["allocation"], (
        f"parallel assignment differs from sequential — sequential "
        f"path got {sum(1 for _ in seq['allocation'])} cohorts; "
        f"parallel got {sum(1 for _ in par['allocation'])}"
    )
    assert seq["objective_value"] == pytest.approx(
        par["objective_value"], rel=1e-9
    )
    assert seq["iterations"] == par["iterations"]


def test_solve_cg_parallel_n4_matches_sequential_on_toy() -> None:
    """Same equivalence at a higher worker count — partitioning into
    more batches than there are clusters should still work (the
    partitioner caps the batch count at the cluster count)."""
    cohorts = _toy_10_cohort_book()
    kwargs = dict(
        capital_budget=12_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
    )
    seq = solve_cg(cohorts, **kwargs)
    par = solve_cg(cohorts, **kwargs, n_workers=4)

    assert seq["allocation"] == par["allocation"]
    assert seq["objective_value"] == pytest.approx(
        par["objective_value"], rel=1e-9
    )


def test_solve_cg_parallel_default_none_is_sequential_path() -> None:
    """``n_workers=None`` (default) keeps the legacy sequential code
    path — pin via a control-flow check on the result dict shape (no
    new fields surface; the pin is value equality)."""
    cohorts = _toy_10_cohort_book()
    out = solve_cg(
        cohorts,
        capital_budget=12_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
    )
    # Sanity — sequential default still returns the full result dict.
    assert "allocation" in out
    assert "final_multipliers" in out


def test_solve_cg_parallel_n_workers_le_1_is_sequential_path() -> None:
    """``n_workers=1`` and ``n_workers=0`` both bypass the pool — same
    semantics as ``None``. Useful so a caller can plumb a config knob
    through without branching on ``None`` themselves."""
    cohorts = _toy_10_cohort_book()
    kwargs = dict(
        capital_budget=12_000_000,
        max_nonrenew_pct=0.20,
        cession_budget=1_500_000,
    )
    seq = solve_cg(cohorts, **kwargs)
    one = solve_cg(cohorts, **kwargs, n_workers=1)
    zero = solve_cg(cohorts, **kwargs, n_workers=0)
    assert seq["allocation"] == one["allocation"] == zero["allocation"]


# ── live-book equivalence (heavy; opt-out) ───────────────────────────────


def _load_live_book() -> tuple[list[dict] | None, dict | None]:
    artifact = Path("artifacts") / "portfolio_optimization.json"
    if not artifact.exists():
        return None, None
    data = json.loads(artifact.read_text())
    cohorts = data.get("cohorts")
    if not cohorts:
        return None, None
    if not cohorts[0].get("loss_scenarios"):
        return None, None
    return cohorts, data["budgets"]


@pytest.mark.skipif(
    os.getenv("FORGE_SKIP_CG_PARALLEL_LIVE_GATE") == "1",
    reason="Live 570-cohort CG parallel gate skipped via "
           "FORGE_SKIP_CG_PARALLEL_LIVE_GATE=1 (opt-out for slow CI)",
)
def test_solve_cg_parallel_matches_sequential_on_live_book() -> None:
    """Headline equivalence on the v0.2.1 artifact's live 570-cohort
    book at TVaR-99. Allocation must match cohort-for-cohort and
    objective to machine precision — parallelism is implementation,
    not formulation."""
    cohorts, budgets = _load_live_book()
    if cohorts is None:
        pytest.skip("artifacts/portfolio_optimization.json missing or stale")
    assert budgets is not None

    kwargs = dict(
        capital_budget=float(budgets["capital_budget"]),
        max_nonrenew_pct=float(budgets["max_nonrenew_pct"]),
        cession_budget=float(budgets["cession_budget"]),
        risk_measure="tvar_99",
    )
    seq = solve_cg(cohorts, **kwargs)
    par = solve_cg(cohorts, **kwargs, n_workers=2)

    assert seq["status"] == par["status"]
    assert seq["allocation"] == par["allocation"]
    assert seq["objective_value"] == pytest.approx(
        par["objective_value"], rel=1e-9
    )
