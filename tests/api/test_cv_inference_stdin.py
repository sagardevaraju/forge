"""Task P3.10 — CV inference stdin handler.

Pins the ``cv_inference`` target's request/response contract.
"""

from __future__ import annotations

import io
import json
import sys

import pytest


def _run(payload: dict) -> tuple[int, dict]:
    """Invoke the cv_inference stdin handler with the given payload.

    Returns ``(exit_code, parsed_stdout)``.
    """
    from api_py._solve_stdin import main

    raw = json.dumps(payload)

    old_stdin = sys.stdin
    old_stdout = sys.stdout
    sys.stdin = io.StringIO(raw)
    sys.stdout = io.StringIO()
    try:
        code = main("cv_inference")
        out = sys.stdout.getvalue().strip()
    finally:
        sys.stdin = old_stdin
        sys.stdout = old_stdout

    if not out:
        return code, {}
    return code, json.loads(out)


def test_cv_inference_mock_returns_8_features():
    code, out = _run({"lat": 28.5, "lon": -82.5, "mode": "mock"})
    assert code == 0
    assert "features" in out
    assert len(out["features"]) == 8
    assert all(0.0 <= v <= 1.0 for v in out["features"])
    assert out["feature_names"] == [
        "vegetation_density",
        "impervious_surface",
        "fuel_proximity",
        "roof_condition_proxy",
        "water_proximity",
        "elevation_bucket",
        "ndvi_seasonal_var",
        "structure_density",
    ]
    assert out["mode_used"] == "mock"
    assert out["bypass_head_used"] is True


def test_cv_inference_missing_lat_lon_errors():
    code, out = _run({"mode": "mock"})
    assert code == 1
    assert "lat and lon are required" in out.get("error", "")


def test_cv_inference_invalid_mode_errors():
    code, out = _run({"lat": 28.5, "lon": -82.5, "mode": "banana"})
    assert code == 1
    assert "invalid mode" in out.get("error", "")


def test_cv_inference_bypass_head_default_true():
    """Default bypass_head=True per the demo-book honesty contract."""
    code, out = _run({"lat": 28.5, "lon": -82.5, "mode": "mock"})
    assert code == 0
    assert out["bypass_head_used"] is True


def test_cv_inference_deterministic_under_same_coords():
    code1, out1 = _run({"lat": 28.5, "lon": -82.5, "mode": "mock"})
    code2, out2 = _run({"lat": 28.5, "lon": -82.5, "mode": "mock"})
    assert code1 == 0 and code2 == 0
    assert out1["features"] == out2["features"]
