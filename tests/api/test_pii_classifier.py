"""Task P3.28a — Python PII classifier wrapper tests.

Pins the name-only fallback behavior. The Presidio path is exercised
manually when Presidio + en_core_web_lg are installed; default CI
environment doesn't have them, so we only test the graceful fallback.
"""

from __future__ import annotations

import io
import json
import sys

import pytest


def test_name_only_classifier_detects_ssn():
    from api_py.pii_classifier import classify
    out = classify(name="ssn", values=None)
    assert out["name_is_pii"] is True
    assert out["backend"] in {"name_only", "presidio"}
    assert out["value_pii_detected"] is False  # no values supplied


def test_name_only_classifier_allows_business_name():
    """The P3.28a regex fallback also has an allow-list; business_name
    must not be flagged."""
    from api_py.pii_classifier import classify
    out = classify(name="business_name", values=None)
    assert out["name_is_pii"] is False


def test_name_only_classifier_detects_email_address():
    from api_py.pii_classifier import classify
    assert classify(name="email_address", values=None)["name_is_pii"] is True


def test_name_only_classifier_handles_empty_name():
    from api_py.pii_classifier import classify
    out = classify(name="", values=None)
    assert out["name_is_pii"] is False


def test_classifier_returns_expected_shape():
    from api_py.pii_classifier import classify
    out = classify(name="ssn", values=None)
    for key in ("name_is_pii", "value_pii_detected",
                "value_entities", "backend", "sample_size"):
        assert key in out


def test_stdin_shim_returns_classification():
    """Round-trip through api_py._solve_stdin pii_classify."""
    from api_py._solve_stdin import main

    payload = {"name": "ssn", "values": []}
    raw = json.dumps(payload)

    old_stdin = sys.stdin
    old_stdout = sys.stdout
    sys.stdin = io.StringIO(raw)
    sys.stdout = io.StringIO()
    try:
        code = main("pii_classify")
        out = json.loads(sys.stdout.getvalue())
    finally:
        sys.stdin = old_stdin
        sys.stdout = old_stdout

    assert code == 0
    assert out["name_is_pii"] is True
    assert "backend" in out
