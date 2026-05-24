"""Task P3.9 — Quarterly post-mortem job tests.

Pure-function coverage on ``scripts.postmortem.compute_postmortem`` —
the CLI wiring is exercised by a single smoke that writes to a tmp
directory.

The post-mortem v1 measures **drift** between a decision's solve-time
view of the world and the current artifact's view. For each decision:

  - If ``cohorts_hash`` at decision time still matches the live
    artifact, there is no drift — the same action mix would still
    produce the same numbers.
  - If ``cohorts_hash`` differs (the policy book has changed via
    upload / seed / reconciliation), the script computes today's
    expected retained loss under the historical action mix and
    reports ``realized_minus_proposed`` so calibration / scenario
    teams see how stale past decisions look against today's data.

The action-weighted retained-loss factors mirror
``api_py/optimize_portfolio.py::LOSS_FACTOR`` (retain=1.0, non_renew=0.0,
cede_qs=0.5, cede_xs=0.3, reprice_*=1.0). Documented in research.md §10a.
"""

from __future__ import annotations

import json

import pytest

from scripts.postmortem import (
    LOSS_FACTOR,
    compute_postmortem,
    quarter_of,
)


# ────────────────────────────────────────────────────────────────────────
# Fixtures
# ────────────────────────────────────────────────────────────────────────


def _decision(
    *,
    decision_id: str = "d1",
    solve_ts: str = "2026-02-15T10:00:00Z",
    operator: str = "alice",
    cohorts_hash: str = "a" * 64,
    objective: float = 12_000_000,
    actions: list[dict] | None = None,
) -> dict:
    """Build a DecisionRow-shaped dict matching what listDecisions returns."""
    if actions is None:
        actions = [
            {
                "cohort_id": "275_wood_frame_q0",
                "retain": 1.0,
                "non_renew": 0.0,
                "cede_qs": 0.0,
                "cede_xs": 0.0,
            },
        ]
    return {
        "id": decision_id.ljust(64, "0"),
        "solve_ts": solve_ts,
        "operator": operator,
        "inputs_hash": "i" * 64,
        "inputs_json": json.dumps(
            {
                "budgets": {
                    "capital_budget": 1e7,
                    "max_nonrenew_pct": 0.1,
                    "cession_budget": 5e6,
                },
                "cohorts_hash": cohorts_hash,
                "horizon_start": "2026-01-01",
                "horizon_end": "2026-12-31",
            }
        ),
        "outputs_hash": "o" * 64,
        "outputs_json": json.dumps(
            {
                "status": "Optimal",
                "objective": objective,
                "actions": actions,
            }
        ),
        "executed_at": None,
        "reversed_at": None,
        "reversed_by": None,
        "notices_sent_at": None,
    }


def _artifact(
    *,
    cohorts_hash: str = "z" * 64,
    cohorts: list[dict] | None = None,
) -> dict:
    if cohorts is None:
        cohorts = [
            {
                "id": "275_wood_frame_q0",
                "loss_p50": 100_000,
                "total_tiv": 500_000,
                "total_premium": 5_000,
            },
            {
                "id": "276_masonry_q1",
                "loss_p50": 200_000,
                "total_tiv": 750_000,
                "total_premium": 8_000,
            },
        ]
    return {"cohorts_hash": cohorts_hash, "cohorts": cohorts}


# ────────────────────────────────────────────────────────────────────────
# quarter_of
# ────────────────────────────────────────────────────────────────────────


class TestQuarterOf:
    def test_q1(self):
        assert quarter_of("2026-01-15T00:00:00Z") == "2026-Q1"
        assert quarter_of("2026-03-31T23:59:59Z") == "2026-Q1"

    def test_q2(self):
        assert quarter_of("2026-04-01T00:00:00Z") == "2026-Q2"
        assert quarter_of("2026-06-30T23:59:59Z") == "2026-Q2"

    def test_q3(self):
        assert quarter_of("2026-07-15T00:00:00Z") == "2026-Q3"

    def test_q4(self):
        assert quarter_of("2026-10-15T00:00:00Z") == "2026-Q4"
        assert quarter_of("2026-12-31T23:59:59Z") == "2026-Q4"


# ────────────────────────────────────────────────────────────────────────
# compute_postmortem
# ────────────────────────────────────────────────────────────────────────


class TestComputePostmortemEmpty:
    def test_empty_decisions_yields_empty_report(self):
        report = compute_postmortem(decisions=[], artifact=_artifact())
        assert report["entries"] == []
        assert report["summary"]["total_decisions"] == 0
        assert report["summary"]["drift_detected"] == 0


class TestComputePostmortemDriftDetection:
    def test_no_drift_when_cohorts_hash_matches(self):
        same_hash = "z" * 64
        d = _decision(cohorts_hash=same_hash)
        report = compute_postmortem(
            decisions=[d], artifact=_artifact(cohorts_hash=same_hash)
        )
        assert len(report["entries"]) == 1
        entry = report["entries"][0]
        assert entry["drift_detected"] is False
        # When no drift, realized_minus_proposed is 0.0 by construction.
        assert entry["realized_minus_proposed"] == 0.0
        assert report["summary"]["drift_detected"] == 0

    def test_drift_when_cohorts_hash_differs(self):
        d = _decision(cohorts_hash="a" * 64)
        report = compute_postmortem(
            decisions=[d], artifact=_artifact(cohorts_hash="b" * 64)
        )
        entry = report["entries"][0]
        assert entry["drift_detected"] is True
        assert entry["cohorts_hash_at_decision"] == "a" * 64
        assert entry["cohorts_hash_now"] == "b" * 64
        assert report["summary"]["drift_detected"] == 1


class TestComputePostmortemRealizedLoss:
    def test_retain_only_uses_full_loss_p50(self):
        # 100% retain on cohort with loss_p50=100k → realized retained
        # loss = 100k × 1.0 = 100k.
        d = _decision(
            cohorts_hash="a" * 64,  # forces drift detection
            actions=[
                {
                    "cohort_id": "275_wood_frame_q0",
                    "retain": 1.0,
                    "non_renew": 0.0,
                    "cede_qs": 0.0,
                    "cede_xs": 0.0,
                }
            ],
        )
        report = compute_postmortem(decisions=[d], artifact=_artifact())
        entry = report["entries"][0]
        assert entry["realized_retained_loss_p50"] == pytest.approx(100_000)

    def test_non_renew_zeros_the_cohort(self):
        d = _decision(
            cohorts_hash="a" * 64,
            actions=[
                {
                    "cohort_id": "275_wood_frame_q0",
                    "retain": 0.0,
                    "non_renew": 1.0,
                    "cede_qs": 0.0,
                    "cede_xs": 0.0,
                }
            ],
        )
        report = compute_postmortem(decisions=[d], artifact=_artifact())
        entry = report["entries"][0]
        assert entry["realized_retained_loss_p50"] == pytest.approx(0.0)

    def test_cede_qs_halves_the_loss(self):
        # cede_qs LOSS_FACTOR = 0.5 → realized = 100k × 0.5 = 50k.
        d = _decision(
            cohorts_hash="a" * 64,
            actions=[
                {
                    "cohort_id": "275_wood_frame_q0",
                    "retain": 0.0,
                    "non_renew": 0.0,
                    "cede_qs": 1.0,
                    "cede_xs": 0.0,
                }
            ],
        )
        report = compute_postmortem(decisions=[d], artifact=_artifact())
        entry = report["entries"][0]
        assert entry["realized_retained_loss_p50"] == pytest.approx(50_000)

    def test_mixed_action_shares_weighted_correctly(self):
        # 50% retain + 50% non_renew → realized = 100k × (0.5 × 1.0 + 0.5 × 0.0) = 50k.
        d = _decision(
            cohorts_hash="a" * 64,
            actions=[
                {
                    "cohort_id": "275_wood_frame_q0",
                    "retain": 0.5,
                    "non_renew": 0.5,
                    "cede_qs": 0.0,
                    "cede_xs": 0.0,
                }
            ],
        )
        report = compute_postmortem(decisions=[d], artifact=_artifact())
        entry = report["entries"][0]
        assert entry["realized_retained_loss_p50"] == pytest.approx(50_000)

    def test_reprice_actions_keep_full_loss(self):
        # reprice_* LOSS_FACTOR = 1.0 — repricing changes premium not loss.
        d = _decision(
            cohorts_hash="a" * 64,
            actions=[
                {
                    "cohort_id": "275_wood_frame_q0",
                    "retain": 0.0,
                    "reprice_p10": 1.0,
                    "non_renew": 0.0,
                    "cede_qs": 0.0,
                    "cede_xs": 0.0,
                }
            ],
        )
        report = compute_postmortem(decisions=[d], artifact=_artifact())
        entry = report["entries"][0]
        assert entry["realized_retained_loss_p50"] == pytest.approx(100_000)

    def test_multi_cohort_realized_sums_correctly(self):
        # Two cohorts: 100k retained + 200k×0.5=100k ceded → total 200k.
        d = _decision(
            cohorts_hash="a" * 64,
            actions=[
                {
                    "cohort_id": "275_wood_frame_q0",
                    "retain": 1.0,
                    "non_renew": 0.0,
                    "cede_qs": 0.0,
                    "cede_xs": 0.0,
                },
                {
                    "cohort_id": "276_masonry_q1",
                    "retain": 0.0,
                    "non_renew": 0.0,
                    "cede_qs": 1.0,
                    "cede_xs": 0.0,
                },
            ],
        )
        report = compute_postmortem(decisions=[d], artifact=_artifact())
        entry = report["entries"][0]
        assert entry["realized_retained_loss_p50"] == pytest.approx(200_000)

    def test_missing_cohort_does_not_crash(self):
        # Decision references a cohort that no longer exists in the artifact
        # (e.g., quintile cut moved). Skip it silently — flagged in summary.
        d = _decision(
            cohorts_hash="a" * 64,
            actions=[
                {
                    "cohort_id": "999_unknown_q4",
                    "retain": 1.0,
                    "non_renew": 0.0,
                    "cede_qs": 0.0,
                    "cede_xs": 0.0,
                }
            ],
        )
        report = compute_postmortem(decisions=[d], artifact=_artifact())
        entry = report["entries"][0]
        assert entry["realized_retained_loss_p50"] == pytest.approx(0.0)
        assert entry["missing_cohorts"] == ["999_unknown_q4"]


class TestComputePostmortemSummary:
    def test_summary_counts_decisions_and_drift(self):
        d1 = _decision(decision_id="d1", cohorts_hash="a" * 64)
        d2 = _decision(decision_id="d2", cohorts_hash="z" * 64)  # no drift
        d3 = _decision(decision_id="d3", cohorts_hash="b" * 64)
        report = compute_postmortem(
            decisions=[d1, d2, d3], artifact=_artifact()
        )
        assert report["summary"]["total_decisions"] == 3
        assert report["summary"]["drift_detected"] == 2

    def test_quarter_filter_keeps_only_in_window(self):
        d_q1 = _decision(decision_id="d1", solve_ts="2026-02-15T10:00:00Z")
        d_q2 = _decision(decision_id="d2", solve_ts="2026-05-15T10:00:00Z")
        report = compute_postmortem(
            decisions=[d_q1, d_q2],
            artifact=_artifact(),
            quarter="2026-Q1",
        )
        assert len(report["entries"]) == 1
        assert report["entries"][0]["decision_id"].startswith("d1")
        assert report["quarter"] == "2026-Q1"


class TestLossFactorTableMirrorsOptimizer:
    """Pin the LOSS_FACTOR table against the optimizer."""

    def test_imports_match_optimizer(self):
        from api_py.optimize_portfolio import LOSS_FACTOR as canonical

        assert LOSS_FACTOR == canonical
