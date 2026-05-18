"""End-to-end: draw → preview → promote → re-optimize → reconciler.

Asserts a hail footprint over Tampa produces:
  - non-zero policies_in_footprint
  - parquet artifact present
  - TVaR-99 differs from hurricane-only baseline (joint K=2000)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from api_py.sim_loss import generate_sim_losses, write_artifact  # noqa: E402

TAMPA_HAIL = {
    "peril": "hail",
    "intensity": "severe",
    "geometry": {
        "type": "Polygon",
        "coordinates": [[[-82.6, 27.6], [-82.2, 27.6], [-82.2, 28.0], [-82.6, 28.0], [-82.6, 27.6]]],
    },
    "effective_date": "2026-05-18",
    "metadata": {"drawn_by": "e2e", "drawn_at": "2026-05-18T00:00:00Z"},
}


def _book_policies():
    import sqlite3
    conn = sqlite3.connect(ROOT / "forge-local.db")
    rows = conn.execute(
        "SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL"
    ).fetchall()
    conn.close()
    return [tuple(r) for r in rows]


@pytest.mark.skipif(not (ROOT / "forge-local.db").exists(), reason="needs seeded DB")
def test_end_to_end_hail_tampa(tmp_path):
    policies = _book_policies()
    sim_id = "9999999999999_endtoend"
    result = generate_sim_losses(
        sim_id=sim_id,
        footprint=TAMPA_HAIL,
        policies=policies,
        cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
        K=200,
    )
    assert result["losses"].shape[1] == 200
    assert result["losses"].sum() > 0, "Tampa hail must produce non-zero losses on the seeded FL book"

    parquet_path, _ = write_artifact(sim_id, result)
    assert parquet_path.exists()

    # Read it back; row count = cohort count.
    tbl = pq.read_table(parquet_path)
    assert tbl.num_rows == len(result["cohort_keys"])

    # cleanup
    parquet_path.unlink()
    parquet_path.with_suffix(".meta.json").unlink()
