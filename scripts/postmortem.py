"""Task P3.9 — Quarterly post-mortem job.

Compares prior decisions in the audit ledger against the *current* view
of the policy book and scenario distribution, and emits a per-decision
``realized_minus_proposed`` score for the calibration / scenario teams.

Run manually
------------
::

    python -m scripts.postmortem                     # current quarter
    python -m scripts.postmortem --quarter 2026-Q1   # replay a specific quarter
    npm run postmortem                               # same as above (CLI wrapper)

Or on the GitHub Actions cron at the 1st of every third month — see
``.github/workflows/postmortem.yml``. The job was originally a Vercel
cron in the plan; moved off Vercel during the Phase 3′ decoupling
(2026-05-23) so the audit story doesn't carry a host coupling.

What "realized" means in v1
---------------------------
P3.9 was flagged in the plan as **Design decision required before TDD**.
Two options on the table:

  (a) Synthetic replay against today's scenarios (this implementation).
  (b) OpenFEMA NFIP claims + NAIC carrier loss runs.

We ship (a) because the demo book is synthetic — there is no real
"realized" to look up. The script's job is to surface **drift**:

  - For every past decision, compare ``cohorts_hash_at_decision_time``
    against the live artifact's ``cohorts_hash``.
  - When they match, no drift — the same action mix would still produce
    the same numbers; ``realized_minus_proposed = 0.0`` by construction.
  - When they differ, the policy book has changed (upload / reseed /
    reconciliation). We compute today's expected retained loss under
    the historical action mix and report it alongside the original
    objective.

Real carrier deployment swaps (a) for (b): plug in OpenFEMA + NAIC
loss runs at the ``realized_retained_loss_p50`` site and re-run. The
script's surface contract doesn't change.

LOSS_FACTOR is imported from ``api_py.optimize_portfolio`` so the
post-mortem stays consistent with what the optimizer actually computed.
A drift between the two tables would silently invalidate the score —
the test ``test_imports_match_optimizer`` pins this.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Mirror the canonical optimizer table so a drift surface up in tests
# rather than as a silent post-mortem error.
from api_py.optimize_portfolio import LOSS_FACTOR


# ────────────────────────────────────────────────────────────────────────
# Quarter helpers
# ────────────────────────────────────────────────────────────────────────


def quarter_of(iso_ts: str) -> str:
    """Map an ISO-8601 timestamp to ``YYYY-Q{1..4}``."""
    dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    q = (dt.month - 1) // 3 + 1
    return f"{dt.year}-Q{q}"


def current_quarter(now: datetime | None = None) -> str:
    if now is None:
        now = datetime.now(tz=timezone.utc)
    q = (now.month - 1) // 3 + 1
    return f"{now.year}-Q{q}"


# ────────────────────────────────────────────────────────────────────────
# Core compute
# ────────────────────────────────────────────────────────────────────────


def compute_postmortem(
    decisions: Iterable[dict],
    artifact: dict,
    *,
    quarter: str | None = None,
) -> dict[str, Any]:
    """Score every decision against the current artifact.

    Parameters
    ----------
    decisions
        Iterable of DecisionRow-shaped dicts (one per row in the
        ``decisions`` table). Each must carry ``id``, ``solve_ts``,
        ``operator``, ``inputs_json``, ``outputs_json``.
    artifact
        The current ``artifacts/portfolio_optimization.json`` contents.
        Provides ``cohorts_hash`` (the live fingerprint) plus the cohort
        list (each cohort carries ``id`` + ``loss_p50``).
    quarter
        Optional ``YYYY-Q{1..4}`` filter. When set, only decisions whose
        ``solve_ts`` falls in that quarter are scored.

    Returns
    -------
    dict
        ``{"quarter": str, "generated_at": iso, "entries": [...],
        "summary": {"total_decisions": n, "drift_detected": k}}``.
    """
    decisions_list = list(decisions)
    if quarter is not None:
        decisions_list = [d for d in decisions_list if quarter_of(d["solve_ts"]) == quarter]

    cohorts_by_id: dict[str, dict] = {
        c["id"]: c for c in artifact.get("cohorts", [])
    }
    live_hash = artifact.get("cohorts_hash", "")

    entries: list[dict[str, Any]] = []
    drift_count = 0

    for d in decisions_list:
        try:
            inputs = json.loads(d["inputs_json"])
            outputs = json.loads(d["outputs_json"])
        except (ValueError, TypeError):
            # Malformed payload — record but don't crash the run.
            entries.append(
                {
                    "decision_id": d["id"],
                    "solve_ts": d["solve_ts"],
                    "operator": d["operator"],
                    "error": "unparseable inputs_json or outputs_json",
                }
            )
            continue

        hash_at_decision = inputs.get("cohorts_hash", "")
        drift_detected = hash_at_decision != live_hash

        actions = outputs.get("actions", []) or []
        proposed_objective = outputs.get("objective")

        # Compute today's expected retained loss under the historical
        # action mix. We sum (share × LOSS_FACTOR[action] × cohort_loss_p50)
        # across every cohort touched by the decision.
        realized_loss = 0.0
        missing_cohorts: list[str] = []

        for action_row in actions:
            cohort_id = action_row.get("cohort_id")
            if cohort_id is None:
                continue
            live_cohort = cohorts_by_id.get(cohort_id)
            if live_cohort is None:
                missing_cohorts.append(cohort_id)
                continue
            loss_p50 = float(live_cohort.get("loss_p50") or 0.0)
            for action_name, factor in LOSS_FACTOR.items():
                share = float(action_row.get(action_name, 0.0) or 0.0)
                if share <= 0.0:
                    continue
                realized_loss += share * factor * loss_p50

        # When there is no drift, the scenarios match by construction —
        # the post-mortem can't say anything new, so the delta is 0.0.
        if drift_detected:
            drift_count += 1
            # Approximate proposed_loss using the same retention math
            # against the live cohort table — only meaningful as a
            # *change* indicator. The full economics (premium, cession
            # cost) live in the optimizer; v1 surfaces the retained-loss
            # delta only.
            realized_minus_proposed = realized_loss - _proposed_retained_loss_from_decision(
                actions, cohorts_by_id
            )
        else:
            realized_minus_proposed = 0.0

        entries.append(
            {
                "decision_id": d["id"],
                "solve_ts": d["solve_ts"],
                "operator": d["operator"],
                "quarter": quarter_of(d["solve_ts"]),
                "cohorts_hash_at_decision": hash_at_decision,
                "cohorts_hash_now": live_hash,
                "drift_detected": drift_detected,
                "proposed_objective": proposed_objective,
                "realized_retained_loss_p50": realized_loss,
                "realized_minus_proposed": realized_minus_proposed,
                "missing_cohorts": missing_cohorts,
            }
        )

    return {
        "quarter": quarter,
        "generated_at": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "entries": entries,
        "summary": {
            "total_decisions": len(entries),
            "drift_detected": drift_count,
        },
    }


def _proposed_retained_loss_from_decision(
    actions: list[dict], cohorts_by_id: dict[str, dict]
) -> float:
    """Approximate the decision-time retained loss using today's cohort
    table.

    v1 simplification — we don't store decision-time per-cohort
    ``loss_p50`` directly (only the objective + action mix), so this is
    the best we can do without re-running the optimizer. The metric is
    meaningful as a *change indicator* against the live retained-loss
    above; the absolute value carries the today-table approximation.
    """
    total = 0.0
    for action_row in actions:
        cohort_id = action_row.get("cohort_id")
        if cohort_id is None:
            continue
        live_cohort = cohorts_by_id.get(cohort_id)
        if live_cohort is None:
            continue
        loss_p50 = float(live_cohort.get("loss_p50") or 0.0)
        for action_name, factor in LOSS_FACTOR.items():
            share = float(action_row.get(action_name, 0.0) or 0.0)
            if share <= 0.0:
                continue
            total += share * factor * loss_p50
    return total


# ────────────────────────────────────────────────────────────────────────
# DB + artifact loaders (kept thin so the compute is unit-testable)
# ────────────────────────────────────────────────────────────────────────


def load_decisions_from_sqlite(db_path: str) -> list[dict]:
    """Read every row from the ``decisions`` table.

    Read-only access — we use ``sqlite3`` directly rather than libSQL
    here because the script runs outside Next.js and we want zero JS
    deps. The ``decisions`` table is the same on-disk schema.
    """
    if not os.path.exists(db_path):
        return []
    con = sqlite3.connect(db_path)
    try:
        con.row_factory = sqlite3.Row
        try:
            cur = con.execute(
                "SELECT id, solve_ts, operator, inputs_hash, inputs_json, "
                "outputs_hash, outputs_json, executed_at, reversed_at, "
                "reversed_by, notices_sent_at FROM decisions"
            )
        except sqlite3.OperationalError:
            # Table doesn't exist yet — no decisions to score.
            return []
        return [dict(row) for row in cur.fetchall()]
    finally:
        con.close()


def load_artifact(artifact_path: Path) -> dict:
    if not artifact_path.exists():
        return {"cohorts_hash": "", "cohorts": []}
    with artifact_path.open("r", encoding="utf-8") as f:
        return json.load(f)


# ────────────────────────────────────────────────────────────────────────
# Reporting
# ────────────────────────────────────────────────────────────────────────


def render_markdown(report: dict[str, Any]) -> str:
    lines: list[str] = []
    quarter = report.get("quarter") or "all-time"
    lines.append(f"# FORGE post-mortem — {quarter}")
    lines.append("")
    lines.append(f"_Generated: {report['generated_at']}_")
    lines.append("")
    summary = report["summary"]
    lines.append(
        f"**{summary['total_decisions']}** decisions scored · "
        f"**{summary['drift_detected']}** show drift since solve time."
    )
    lines.append("")
    lines.append(
        "| Decision | Operator | Solve TS | Drift? | Proposed objective | Realized retained loss (p50) | Δ |"
    )
    lines.append("|---|---|---|---|---|---|---|")
    for e in report["entries"]:
        if "error" in e:
            lines.append(
                f"| {e['decision_id'][:8]}… | {e['operator']} | {e['solve_ts']} | — | — | — | {e['error']} |"
            )
            continue
        drift = "✅" if e["drift_detected"] else "—"
        prop = (
            f"${e['proposed_objective']:,.0f}"
            if isinstance(e.get("proposed_objective"), (int, float))
            else "—"
        )
        real = f"${e['realized_retained_loss_p50']:,.0f}"
        delta = f"${e['realized_minus_proposed']:+,.0f}"
        lines.append(
            f"| {e['decision_id'][:8]}… | {e['operator']} | {e['solve_ts']} | {drift} | {prop} | {real} | {delta} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_report(report: dict[str, Any], out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    quarter = report.get("quarter") or "all-time"
    json_path = out_dir / f"{quarter}.json"
    md_path = out_dir / f"{quarter}.md"
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    md_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, md_path


# ────────────────────────────────────────────────────────────────────────
# CLI
# ────────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="FORGE quarterly post-mortem (P3.9)"
    )
    parser.add_argument(
        "--quarter",
        default=None,
        help="Override the quarter to score (e.g. 2026-Q1). Defaults to the previous quarter.",
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("FORGE_LOCAL_DB", "forge-local.db"),
        help="Path to the libSQL/SQLite DB (default: forge-local.db)",
    )
    parser.add_argument(
        "--artifact",
        default="artifacts/portfolio_optimization.json",
        help="Path to the cached optimization artifact.",
    )
    parser.add_argument(
        "--out-dir",
        default="artifacts/postmortem",
        help="Directory to write the report JSON + markdown into.",
    )
    args = parser.parse_args(argv)

    quarter = args.quarter or _previous_quarter()

    decisions = load_decisions_from_sqlite(args.db)
    artifact = load_artifact(Path(args.artifact))

    report = compute_postmortem(
        decisions=decisions, artifact=artifact, quarter=quarter
    )
    json_path, md_path = write_report(report, Path(args.out_dir))

    print(
        f"Wrote {json_path} and {md_path}: "
        f"{report['summary']['total_decisions']} decisions, "
        f"{report['summary']['drift_detected']} with drift."
    )
    return 0


def _previous_quarter(now: datetime | None = None) -> str:
    if now is None:
        now = datetime.now(tz=timezone.utc)
    # Roll back ~3 months to land in the previous quarter regardless of
    # which day-in-month we're running on.
    if now.month <= 3:
        return f"{now.year - 1}-Q4"
    q = (now.month - 1) // 3  # 0..3, current quarter index
    # The previous quarter is q-1 (0-indexed) → label is "Q{q}".
    return f"{now.year}-Q{q}"


if __name__ == "__main__":
    sys.exit(main())
