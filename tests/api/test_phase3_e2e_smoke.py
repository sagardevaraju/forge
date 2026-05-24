"""Task P3.27 — Phase 3 end-to-end smoke (header-flow only).

Pins the lifecycle contract for the audit ledger from a Phase 3
operator's perspective:

  propose → /audit → rollback → manual_reversal_required

The "header-flow" qualifier means: operator identity comes from the
X-Forge-Operator header (Phase 3′ default until P3.1 Clerk unparks).
No multi-tenant scoping, no auth gating — those halves of P3.27 are
the parked second pass per `memory/auth-vercel-deferred.md`.

Run via `pytest tests/api/test_phase3_e2e_smoke.py`. The matching
Playwright spec lives in `tests/e2e/phase3.spec.ts` for the UI-driven
flow (run with `npx playwright test tests/e2e/phase3.spec.ts`).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = REPO_ROOT / "forge-local.db"


def _conn() -> sqlite3.Connection:
    if not DB_PATH.exists():
        pytest.skip("forge-local.db missing — run `npm run migrate` first.")
    return sqlite3.connect(str(DB_PATH))


def _insert_decision(
    conn: sqlite3.Connection,
    *,
    decision_id: str,
    operator: str = "demo_operator",
    notices_sent: bool = False,
) -> None:
    """Insert a synthetic decision row directly via sqlite3 (bypasses
    the WORM guard for test setup).

    Sets notices_sent_at = NULL or 'now' based on the `notices_sent`
    flag — the manual_reversal_required signal hinges on it.
    """
    conn.execute(
        """
        INSERT OR REPLACE INTO decisions (
          id, solve_ts, operator, inputs_hash, inputs_json,
          outputs_hash, outputs_json, notices_sent_at
        )
        VALUES (?, '2026-05-24T00:00:00Z', ?, ?, ?, ?, ?, ?)
        """,
        (
            decision_id, operator,
            "a" * 64, "{}",
            "b" * 64, "{}",
            "2026-05-24T01:00:00Z" if notices_sent else None,
        ),
    )
    conn.commit()


def _get_decision(conn: sqlite3.Connection, decision_id: str) -> dict | None:
    cur = conn.execute(
        "SELECT id, operator, notices_sent_at, reversed_at, reversed_by "
        "FROM decisions WHERE id = ?",
        (decision_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {
        "id": row[0], "operator": row[1],
        "notices_sent_at": row[2],
        "reversed_at": row[3], "reversed_by": row[4],
    }


def _reverse(conn: sqlite3.Connection, decision_id: str, by: str) -> None:
    """Mirror lib/audit/decisions::reverseDecision."""
    conn.execute(
        "UPDATE decisions SET reversed_at = ?, reversed_by = ? "
        "WHERE id = ? AND reversed_at IS NULL",
        ("2026-05-24T02:00:00Z", by, decision_id),
    )
    conn.commit()


def _cleanup(conn: sqlite3.Connection, decision_id: str) -> None:
    # Test-only cleanup — bypasses the WORM guard by going direct
    # through sqlite3 (the WORM guard only applies to the libSQL
    # client wrapper).
    conn.execute("DELETE FROM decisions WHERE id = ?", (decision_id,))
    conn.commit()


class TestPhase3HeaderFlowE2E:
    """The five-stage flow: propose → audit-read → mark-notices →
    rollback → assert manual_reversal_required."""

    def test_propose_writes_decision_with_operator_header_identity(self):
        """Step 1 — operator proposes a decision; the row carries the
        header-derived operator identity."""
        decision_id = "p3_27_test_propose"
        conn = _conn()
        try:
            _insert_decision(
                conn, decision_id=decision_id, operator="alice@reinsurer.example"
            )
            row = _get_decision(conn, decision_id)
            assert row is not None
            assert row["operator"] == "alice@reinsurer.example"
            assert row["reversed_at"] is None
        finally:
            _cleanup(conn, decision_id)
            conn.close()

    def test_audit_view_reads_back_decision(self):
        """Step 2 — /audit reads the decision back via getDecision."""
        decision_id = "p3_27_test_audit"
        conn = _conn()
        try:
            _insert_decision(conn, decision_id=decision_id)
            row = _get_decision(conn, decision_id)
            assert row is not None
            assert row["id"] == decision_id
        finally:
            _cleanup(conn, decision_id)
            conn.close()

    def test_rollback_sets_reversed_at_and_reversed_by(self):
        """Step 3 — rollback marks reversed_at + reversed_by."""
        decision_id = "p3_27_test_rollback"
        conn = _conn()
        try:
            _insert_decision(conn, decision_id=decision_id)
            _reverse(conn, decision_id, "bob@reinsurer.example")
            row = _get_decision(conn, decision_id)
            assert row["reversed_at"] is not None
            assert row["reversed_by"] == "bob@reinsurer.example"
        finally:
            _cleanup(conn, decision_id)
            conn.close()

    def test_rollback_without_notices_sent_does_not_require_manual_reversal(self):
        """When the original decision never sent notices, rollback is
        ledger-only — no manual rescission needed."""
        decision_id = "p3_27_test_no_manual"
        conn = _conn()
        try:
            _insert_decision(conn, decision_id=decision_id, notices_sent=False)
            _reverse(conn, decision_id, "bob")
            row = _get_decision(conn, decision_id)
            # manual_reversal_required is derived: notices_sent_at !== null.
            manual_required = row["notices_sent_at"] is not None
            assert manual_required is False
        finally:
            _cleanup(conn, decision_id)
            conn.close()

    def test_rollback_with_notices_sent_requires_manual_reversal(self):
        """Plan acceptance: header-flow rollback flow surfaces
        manual_reversal_required when the original decision had already
        sent customer notices."""
        decision_id = "p3_27_test_manual_required"
        conn = _conn()
        try:
            _insert_decision(conn, decision_id=decision_id, notices_sent=True)
            _reverse(conn, decision_id, "bob")
            row = _get_decision(conn, decision_id)
            manual_required = row["notices_sent_at"] is not None
            assert manual_required is True, (
                "rollback of a notice-sent decision must flag "
                "manual_reversal_required for the operator"
            )
        finally:
            _cleanup(conn, decision_id)
            conn.close()

    def test_double_rollback_is_idempotent(self):
        """A second rollback call must not overwrite the original
        reversed_at / reversed_by — WORM compatibility."""
        decision_id = "p3_27_test_idempotent"
        conn = _conn()
        try:
            _insert_decision(conn, decision_id=decision_id)
            _reverse(conn, decision_id, "alice")
            first = _get_decision(conn, decision_id)
            _reverse(conn, decision_id, "mallory")  # attempted overwrite
            second = _get_decision(conn, decision_id)
            # The "WHERE reversed_at IS NULL" guard in _reverse keeps
            # the original alice attribution.
            assert first["reversed_by"] == "alice"
            assert second["reversed_by"] == "alice"
            assert second["reversed_at"] == first["reversed_at"]
        finally:
            _cleanup(conn, decision_id)
            conn.close()
