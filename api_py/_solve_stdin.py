"""Task P2.12 — stdin/stdout shim for ``api_py.optimize_portfolio.solve``.

Reads a single JSON request from ``sys.stdin``, calls ``solve(**args)``,
and writes the JSON response to ``sys.stdout``. Used by the Node route
``/api/optimize/portfolio`` which shells out for what-if re-solves.

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

Exit codes:
    0  — solve succeeded; stdout carries valid JSON
    1  — solve raised; stdout carries ``{"error": "..."}`` and stderr has
         the original exception text for the route to log.

This shim is intentionally minimal so the Node tests can mock it with a
trivial ``vi.mock('node:child_process')`` stub. It does not import PuLP
directly — ``solve()`` does that lazily, so the cost of a no-op invocation
is just the import-time of Python + ``optimize_portfolio``.
"""

from __future__ import annotations

import json
import sys
import traceback


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw:
            print(json.dumps({"error": "empty stdin"}))
            return 1
        args = json.loads(raw)
    except Exception as e:  # noqa: BLE001 — surface any parse error
        print(json.dumps({"error": f"invalid stdin JSON: {e}"}))
        return 1

    # Lazy import so the shim itself parses fast and so import-time
    # failures (PuLP missing, etc.) get reported through the same channel.
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


if __name__ == "__main__":  # pragma: no cover — Vercel/Node entrypoint
    sys.exit(main())
