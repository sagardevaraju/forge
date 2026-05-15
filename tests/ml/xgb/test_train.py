"""Tests for Task 11 — XGBoost quantile model artifacts."""

from pathlib import Path

import numpy as np
import pytest

ARTIFACTS = Path(__file__).resolve().parents[3] / "artifacts"


@pytest.mark.skipif(
    not (ARTIFACTS / "xgb_p50.joblib").exists(),
    reason="Models not trained yet",
)
def test_models_loaded() -> None:
    import joblib

    for q in [10, 50, 90]:
        m = joblib.load(ARTIFACTS / f"xgb_p{q:02d}.joblib")
        assert m is not None


@pytest.mark.skipif(
    not (ARTIFACTS / "xgb_p50.joblib").exists(),
    reason="Models not trained yet",
)
def test_quantile_ordering() -> None:
    """p10 <= p50 <= p90 for synthetic random inputs."""
    import joblib

    p10 = joblib.load(ARTIFACTS / "xgb_p10.joblib")
    p50 = joblib.load(ARTIFACTS / "xgb_p50.joblib")
    p90 = joblib.load(ARTIFACTS / "xgb_p90.joblib")
    cols = joblib.load(ARTIFACTS / "xgb_feature_cols.joblib")

    X = np.random.RandomState(0).randn(50, len(cols)).astype(np.float32)
    pred10 = p10.predict(X)
    pred50 = p50.predict(X)
    pred90 = p90.predict(X)

    # Quantile models can occasionally cross — assert majority ordering
    assert (pred10 <= pred50).mean() > 0.95
    assert (pred50 <= pred90).mean() > 0.95
