"""Task P2.12 / SIM.11 — stdin/stdout shim for Node-side spawn.

Dispatches by target name supplied as the first CLI argument:

  python -m api_py._solve_stdin optimize_portfolio < payload.json
  python -m api_py._solve_stdin sim_loss           < payload.json

**optimize_portfolio** (Task P2.12)
  Request shape::

      {
          "cohorts": [...],
          "capital_budget": float,
          "max_nonrenew_pct": float,
          "cession_budget": float,
          "horizon_start": "YYYY-MM-DD",   # optional
          "horizon_end": "YYYY-MM-DD",     # optional
      }

  Response shape: ``solve()``'s return dict (see api_py/optimize_portfolio.py).

**sim_loss** (Task SIM.11)
  Request shape::

      {
          "sim_id": str,
          "footprint": {...},
          "policies": [[id, lat, lon, tiv, build_type, zip3], ...],
          "K": int,          # defaults to 1000
      }

  Response shape::

      {"K": int, "n_cohorts": int, "artifact_path": str}

Exit codes:
    0  — succeeded; stdout carries valid JSON
    1  — failed; stdout carries ``{"error": "..."}`` and stderr has the
         original exception text for the route to log.

This shim is intentionally minimal so Node tests can mock it with a
trivial ``vi.mock('node:child_process')`` stub.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _handle_optimize_portfolio(args: dict) -> int:
    """Dispatch for the portfolio MIP solver (Task P2.12)."""
    try:
        from api_py.optimize_portfolio import solve
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"import failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1

    try:
        result = solve(
            cohorts=args["cohorts"],
            capital_budget=float(args["capital_budget"]),
            max_nonrenew_pct=float(args["max_nonrenew_pct"]),
            cession_budget=float(args["cession_budget"]),
            horizon_start=str(args.get("horizon_start", "2026-07-01")),
            horizon_end=str(args.get("horizon_end", "2027-06-30")),
        )
    except Exception as e:  # noqa: BLE001 — defensive; route surfaces the error
        print(json.dumps({"error": f"solve failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1

    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    return 0


def _handle_sim_loss(payload: dict) -> int:
    """Dispatch for the K=1000 cohort loss generator (Task SIM.11)."""
    try:
        from api_py.sim_loss import generate_sim_losses, write_artifact
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"import failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1

    try:
        result = generate_sim_losses(
            sim_id=payload["sim_id"],
            footprint=payload["footprint"],
            policies=[tuple(p) for p in payload.get("policies", [])],
            cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
            K=int(payload.get("K") or 1000),
        )
        parquet_path, _ = write_artifact(payload["sim_id"], result)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"sim_loss failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1

    print(json.dumps({
        "K": result["K"],
        "n_cohorts": len(result["cohort_keys"]),
        "artifact_path": str(parquet_path),
    }))
    return 0


def main(target: str | None = None) -> int:
    # When called as `python -m api_py._solve_stdin <target>` the target
    # arrives as argv[1].  When called programmatically (tests), it can be
    # passed directly.
    resolved_target = target or (sys.argv[1] if len(sys.argv) > 1 else None)
    if not resolved_target:
        print(json.dumps({"error": "usage: python -m api_py._solve_stdin <target>"}))
        return 1

    try:
        raw = sys.stdin.read()
        if not raw:
            print(json.dumps({"error": "empty stdin"}))
            return 1
        args = json.loads(raw)
    except Exception as e:  # noqa: BLE001 — surface any parse error
        print(json.dumps({"error": f"invalid stdin JSON: {e}"}))
        return 1

    if resolved_target == "optimize_portfolio":
        return _handle_optimize_portfolio(args)
    if resolved_target == "sim_loss":
        return _handle_sim_loss(args)

    print(json.dumps({"error": f"unknown target: {resolved_target}"}))
    return 1


if __name__ == "__main__":  # pragma: no cover — Vercel/Node entrypoint
    sys.exit(main())
