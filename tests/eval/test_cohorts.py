"""Task 12 — verify the Python cohort id format matches the TS rename.

The canonical cohort key format is ``{zip3}_{build_type}_q{N}`` where ``N`` is
the 0..4 TIV-quintile bucket. This test exercises ``eval.end_to_end.aggregate_cohorts``
(the Python mirror of ``lib/db/cohorts.ts``) against the seeded local DB.

If the local DB has not been seeded yet, the test is skipped — CI seeds the
book before running pytest.
"""
from __future__ import annotations

from pathlib import Path

import pytest

DB_PATH = Path(__file__).resolve().parents[2] / "forge-local.db"


@pytest.mark.skipif(
    not DB_PATH.exists(),
    reason="forge-local.db not seeded; run `python scripts/seed_policy_book.py`",
)
def test_cohort_id_uses_quintile_suffix():
    from eval.end_to_end import aggregate_cohorts

    cohorts = aggregate_cohorts()
    assert cohorts, "expected at least one cohort from the seeded book"
    for c in cohorts:
        assert c["id"].endswith(("_q0", "_q1", "_q2", "_q3", "_q4")), (
            f"cohort id {c['id']!r} does not use the _q{{N}} suffix"
        )
        # Negative assertion: the old _d{N} suffix must be gone.
        assert not c["id"].rsplit("_", 1)[-1].startswith("d"), (
            f"cohort id {c['id']!r} still uses the legacy _d{{N}} suffix"
        )
