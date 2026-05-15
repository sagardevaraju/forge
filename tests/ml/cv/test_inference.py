"""Unit tests for ml.cv.inference — mock path only (no model weights required)."""

import numpy as np
import pytest

from ml.cv.inference import predict_chip_mock, load_chip_features


def test_predict_chip_mock_shape():
    chip = np.random.randint(0, 10000, (5, 256, 256), dtype=np.uint16)
    feats = predict_chip_mock(chip)
    assert feats.shape == (8,)
    assert feats.dtype == np.float32 or feats.dtype == np.float64


def test_predict_chip_mock_in_unit_range():
    chip = np.random.randint(0, 10000, (5, 256, 256), dtype=np.uint16)
    feats = predict_chip_mock(chip)
    assert (feats >= 0).all() and (feats <= 1).all()


def test_predict_chip_mock_deterministic():
    chip = np.random.RandomState(42).randint(0, 10000, (5, 256, 256), dtype=np.uint16)
    f1 = predict_chip_mock(chip)
    f2 = predict_chip_mock(chip)
    np.testing.assert_array_equal(f1, f2)


def test_load_chip_features_returns_8_dims(monkeypatch):
    monkeypatch.setenv("FORGE_CV_MODE", "mock")
    feats = load_chip_features(lat=28.0, lon=-82.5)
    assert feats.shape == (8,)
