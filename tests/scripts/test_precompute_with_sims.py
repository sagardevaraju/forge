"""Verify --include-sims concatenates K matrices column-wise."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest


ROOT = Path(__file__).resolve().parent.parent.parent
ARTIFACTS = ROOT / "artifacts"
SIMS_DIR = ARTIFACTS / "simulations"

# The git-tracked artifacts the precompute script overwrites on every run.
_TRACKED_ARTIFACTS = [
    ARTIFACTS / "portfolio_optimization.json",
    ARTIFACTS / "portfolio_optimization.meta.json",
]


@pytest.fixture(autouse=True)
def _preserve_tracked_artifacts():
    """Snapshot the tracked portfolio artifacts and restore their exact bytes
    after each test.

    These tests run `precompute_portfolio_optimization` as a subprocess, which
    writes the real `artifacts/portfolio_optimization.json` / `.meta.json`
    paths (a fresh `solved_at` timestamp + solver float jitter). Without this
    fixture the suite would leave git-tracked files dirty.
    """
    saved = {p: (p.read_bytes() if p.exists() else None) for p in _TRACKED_ARTIFACTS}
    try:
        yield
    finally:
        for p, data in saved.items():
            if data is None:
                p.unlink(missing_ok=True)
            else:
                p.write_bytes(data)


def _write_sim_artifact(sim_id: str, cohort_keys: list[str], K: int = 50) -> None:
    """Write a tiny synthetic sim parquet so the precompute script can join it."""
    SIMS_DIR.mkdir(parents=True, exist_ok=True)
    losses = np.full((len(cohort_keys), K), 1_000_000.0)
    table = pa.table({
        "cohort_key": cohort_keys,
        **{f"k{i:04d}": losses[:, i] for i in range(K)},
    })
    pq.write_table(table, SIMS_DIR / f"{sim_id}.parquet")
    (SIMS_DIR / f"{sim_id}.meta.json").write_text(json.dumps({
        "sim_id": sim_id, "K": K, "cohort_keys": cohort_keys,
        "peril": "hail", "intensity": "severe", "beta": 0.2, "sigma": 0.4,
    }))


def test_include_sims_writes_meta_with_sim_ids(tmp_path, monkeypatch):
    # Run the precompute script with --include-sims pointing at a known fixture.
    fixture_id = "9999999999999_deadbeef"
    # We need at least one cohort key the actual book also produces. The seed
    # ships ~570 cohorts; pick one via the cohort aggregator first, but for
    # this lightweight test we just write a sentinel key that won't match.
    # The script must still complete (just contribute 0 to joint K) and
    # record the sim_id in meta.
    _write_sim_artifact(fixture_id, ["999_bogus_q0"], K=10)
    try:
        out = subprocess.run(
            [sys.executable, "-m", "scripts.precompute_portfolio_optimization",
             "--include-sims", fixture_id],
            cwd=ROOT, check=True, capture_output=True, text=True,
        )
        meta_path = ARTIFACTS / "portfolio_optimization.meta.json"
        assert meta_path.exists()
        meta = json.loads(meta_path.read_text())
        assert fixture_id in meta.get("included_sims", [])
    finally:
        (SIMS_DIR / f"{fixture_id}.parquet").unlink(missing_ok=True)
        (SIMS_DIR / f"{fixture_id}.meta.json").unlink(missing_ok=True)


@pytest.mark.skipif(not (ROOT / "forge-local.db").exists(), reason="needs seeded DB")
def test_include_sims_actually_modifies_cohort_losses(tmp_path):
    """Regression for the cohort-key mismatch bug: when --include-sims is
    used, the resulting portfolio_optimization.json must show a non-zero
    delta in at least one cohort's loss_scenarios length vs the baseline.

    Before the fix, the promote path emitted prefix-only cohort keys
    (``{zip3}_{build_type}``) while the MIP cohort store uses
    ``{zip3}_{build_type}_q{N}``. Every lookup missed → sim contributed
    zero loss → joint TVaR-99 == hurricane-only TVaR-99.
    """
    # Step 1: baseline run — record per-cohort loss_scenarios length.
    subprocess.run(
        [sys.executable, "-m", "scripts.precompute_portfolio_optimization"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    baseline = json.loads((ARTIFACTS / "portfolio_optimization.json").read_text())
    # Pick a real cohort with a substantial scenario set to detect the delta.
    target_cohort = next(
        c for c in baseline["cohorts"]
        if len(c.get("loss_scenarios", [])) >= 100
    )
    target_id = target_cohort["id"]
    baseline_len = len(target_cohort["loss_scenarios"])

    # Step 2: write a sim parquet keyed against the *real* cohort id from step 1.
    fixture_id = "9999999999999_cohortfx"
    SIMS_DIR.mkdir(parents=True, exist_ok=True)
    K = 25
    losses = np.full((1, K), 500_000.0)
    table = pa.table({
        "cohort_key": [target_id],
        **{f"k{i:04d}": losses[:, i] for i in range(K)},
    })
    pq.write_table(table, SIMS_DIR / f"{fixture_id}.parquet")
    (SIMS_DIR / f"{fixture_id}.meta.json").write_text(json.dumps({
        "sim_id": fixture_id, "K": K, "cohort_keys": [target_id],
        "peril": "hail", "intensity": "severe", "beta": 0.2, "sigma": 0.4,
    }))

    try:
        # Step 3: run with --include-sims pointing at the fixture.
        subprocess.run(
            [sys.executable, "-m", "scripts.precompute_portfolio_optimization",
             "--include-sims", fixture_id],
            cwd=ROOT, check=True, capture_output=True, text=True,
        )
        merged = json.loads((ARTIFACTS / "portfolio_optimization.json").read_text())
        target_after = next(c for c in merged["cohorts"] if c["id"] == target_id)

        # Step 4: the cohort's loss_scenarios must have grown by exactly K.
        assert len(target_after["loss_scenarios"]) == baseline_len + K, (
            f"expected {baseline_len + K} loss draws for cohort '{target_id}', "
            f"got {len(target_after['loss_scenarios'])} — cohort-key mismatch "
            "bug may have recurred (promote keys not matching MIP cohort store)"
        )
    finally:
        (SIMS_DIR / f"{fixture_id}.parquet").unlink(missing_ok=True)
        (SIMS_DIR / f"{fixture_id}.meta.json").unlink(missing_ok=True)
        # The autouse _preserve_tracked_artifacts fixture restores the
        # baseline artifact bytes — no precompute re-run needed here.
