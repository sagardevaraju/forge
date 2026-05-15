"""Unit tests for ml.cv.data_loaders — mock path only (no network calls)."""

import numpy as np
import pytest

from ml.cv.data_loaders import mock_chip, load_chip


def test_mock_chip_shape_and_dtype():
    chip = mock_chip(lat=28.0, lon=-82.5)
    assert chip.shape == (5, 256, 256)
    assert chip.dtype == np.uint16


def test_mock_chip_value_range():
    chip = mock_chip(lat=28.0, lon=-82.5)
    assert chip.min() >= 0
    assert chip.max() <= 10000


def test_mock_chip_deterministic():
    c1 = mock_chip(lat=28.0, lon=-82.5)
    c2 = mock_chip(lat=28.0, lon=-82.5)
    np.testing.assert_array_equal(c1, c2)


def test_mock_chip_differs_by_location():
    c1 = mock_chip(lat=28.0, lon=-82.5)
    c2 = mock_chip(lat=29.0, lon=-95.0)
    assert not np.array_equal(c1, c2)


def test_load_chip_defaults_to_mock(monkeypatch):
    monkeypatch.delenv("FORGE_CV_MODE", raising=False)
    chip = load_chip(lat=28.0, lon=-82.5)
    assert chip.shape == (5, 256, 256)
