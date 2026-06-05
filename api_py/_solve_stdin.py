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

  Response shape (delegated to api_py.sim_loss.run_request)::

      {
          "K": int,
          "n_cohorts": int,
          "artifact_path": str | None,   # None when persist disabled
          "histogram": {...},
          "summary": {...},
      }

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
    """Dispatch for the K=1000 cohort loss generator (Task SIM.11).

    Delegates to api_py.sim_loss.run_request so the dev (spawn) path and the
    Vercel HTTP function return an identical shape — including the loss
    distribution summary. run_request owns the canonical quintile-aware
    cohort keyer and the conditional parquet persist.
    """
    try:
        from api_py.sim_loss import run_request
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"import failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1
    try:
        resp = run_request(payload)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"sim_loss failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1
    print(json.dumps(resp))
    return 0


def _handle_cv_inference(payload: dict) -> int:
    """Dispatch for the real-time CV inference endpoint (Task P3.10).

    Request shape::

        {
            "lat": float,
            "lon": float,
            "mode": "mock" | "cached" | "real",   # default "mock"
            "policy_id": int,                      # required when mode="cached"
            "bypass_head": bool                    # default true
        }

    Response shape::

        {
            "features": [float] * 8,
            "feature_names": [str] * 8,
            "mode_used": str,
            "bypass_head_used": bool
        }

    De-Vercel'd: this is invoked by the Next.js Node route
    ``/api/cv/infer`` via subprocess spawn so we keep the heavy CV
    dependencies (numpy, torch optional) out of any Vercel function
    bundle. CPU-only; runs on ``npm run dev`` / Docker / any Node host.
    """
    try:
        from ml.cv.inference import (
            load_chip_features,
            OUTPUT_FEATURE_NAMES,
        )
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"import failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1

    try:
        lat = payload.get("lat")
        lon = payload.get("lon")
        if lat is None or lon is None:
            print(json.dumps({"error": "lat and lon are required"}), flush=True)
            return 1
        mode = str(payload.get("mode") or "mock").strip().lower()
        if mode not in {"mock", "cached", "real"}:
            print(json.dumps({"error": f"invalid mode: {mode}"}), flush=True)
            return 1
        policy_id = payload.get("policy_id")
        # bypass_head defaults True for real-time inference — the trained
        # head produces near-constant outputs across the demo book; band
        # math is the honest default. Operators can opt in to the head
        # by passing bypass_head=false.
        bypass_head = bool(payload.get("bypass_head", True))
        feats = load_chip_features(
            lat=float(lat),
            lon=float(lon),
            mode=mode,
            policy_id=int(policy_id) if policy_id is not None else None,
            bypass_head=bypass_head,
        )
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"cv inference failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1

    print(json.dumps({
        "features": [float(x) for x in feats.tolist()],
        "feature_names": list(OUTPUT_FEATURE_NAMES),
        "mode_used": mode,
        "bypass_head_used": bypass_head,
    }))
    return 0


def _handle_pii_classify(payload: dict) -> int:
    """Dispatch for the optional Presidio-backed PII classifier (Task P3.28a).

    Request shape::

        {"name": str, "values": [str, ...]}

    Response shape (mirrors api_py.pii_classifier.classify return)::

        {
            "name_is_pii": bool,
            "value_pii_detected": bool,
            "value_entities": [str, ...],
            "backend": "presidio" | "name_only",
            "sample_size": int
        }

    Falls back to name-only mode when ``presidio-analyzer`` /
    ``en_core_web_lg`` isn't installed — no install needed for the
    route to respond. The ~100 MB Presidio install is opt-in for
    ingestion teams that want value-level detection.
    """
    try:
        from api_py.pii_classifier import classify
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"import failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1
    try:
        name = str(payload.get("name", ""))
        values = payload.get("values")
        if values is not None and not isinstance(values, list):
            print(json.dumps({"error": "values must be a list of strings"}))
            return 1
        result = classify(name=name, values=values)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"pii classify failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1
    print(json.dumps(result))
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
    if resolved_target == "cv_inference":
        return _handle_cv_inference(args)
    if resolved_target == "pii_classify":
        return _handle_pii_classify(args)

    print(json.dumps({"error": f"unknown target: {resolved_target}"}))
    return 1


if __name__ == "__main__":  # pragma: no cover — Vercel/Node entrypoint
    sys.exit(main())
