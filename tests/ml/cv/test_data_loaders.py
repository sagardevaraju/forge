"""Unit tests for ml.cv.data_loaders — mock + cached paths (no network calls)."""

import numpy as np
import pytest

from ml.cv.data_loaders import (
    mock_chip,
    load_chip,
    chip_path,
    load_cached_chip,
    save_cached_chip,
)


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


def test_cached_chip_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))
    chip = mock_chip(lat=28.0, lon=-82.5)
    written = save_cached_chip(policy_id=42, chip=chip)
    assert written.exists()
    loaded = load_cached_chip(policy_id=42)
    np.testing.assert_array_equal(loaded, chip)


def test_cached_chip_path_layout(tmp_path, monkeypatch):
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))
    assert chip_path(0) == tmp_path / "00" / "0.npy"
    assert chip_path(150) == tmp_path / "01" / "150.npy"
    assert chip_path(9999) == tmp_path / "99" / "9999.npy"


def test_load_cached_missing_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))
    with pytest.raises(FileNotFoundError, match="No cached chip"):
        load_cached_chip(policy_id=12345)


def test_load_chip_cached_dispatch(tmp_path, monkeypatch):
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))
    chip = mock_chip(lat=28.0, lon=-82.5)
    save_cached_chip(policy_id=7, chip=chip)
    out = load_chip(mode="cached", policy_id=7)
    np.testing.assert_array_equal(out, chip)


def test_load_chip_cached_requires_policy_id():
    with pytest.raises(ValueError, match="policy_id is required"):
        load_chip(mode="cached")


def test_save_cached_chip_validates_shape(tmp_path, monkeypatch):
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))
    bad = np.zeros((3, 256, 256), dtype=np.uint16)
    with pytest.raises(ValueError, match="chip shape"):
        save_cached_chip(policy_id=1, chip=bad)


def test_load_chip_features_cached_falls_back_to_mock_for_all_zero(
    tmp_path, monkeypatch,
):
    """Offshore-seed regression: an all-zero cached chip must route through
    the mock path so populate_cv_features produces non-zero features."""
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))
    # Write a deliberately all-zero chip — simulates an offshore policy.
    zero_chip = np.zeros((5, 256, 256), dtype=np.uint16)
    save_cached_chip(policy_id=999, chip=zero_chip)

    from ml.cv.inference import load_chip_features

    feats = load_chip_features(
        lat=28.0, lon=-82.5, mode="cached", policy_id=999,
    )
    # Mock-path features for a non-trivial chip should NOT be all-zero.
    assert feats.shape == (8,)
    assert feats.dtype == np.float32
    assert feats.max() > 0.0, "fallback to mock should produce non-zero features"
    # And every dim should sit in [0, 1] like all other paths.
    assert feats.min() >= 0.0 and feats.max() <= 1.0


def test_load_chip_features_cached_falls_back_to_mock_when_missing(
    tmp_path, monkeypatch,
):
    """Missing-cache regression: if cache_s2_chips.py failed to write a chip
    for a given policy, populate_cv_features still produces features via the
    mock path instead of crashing."""
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))
    # Note: no save_cached_chip call — file is intentionally absent.

    from ml.cv.inference import load_chip_features

    feats = load_chip_features(
        lat=28.0, lon=-82.5, mode="cached", policy_id=8368,
    )
    assert feats.shape == (8,)
    assert feats.dtype == np.float32
    assert feats.max() > 0.0


def test_load_chip_features_cached_missing_no_coords_raises(
    tmp_path, monkeypatch,
):
    """Without lat/lon we cannot synthesize a mock chip — surface the error."""
    monkeypatch.setenv("FORGE_CHIPS_DIR", str(tmp_path))

    from ml.cv.inference import load_chip_features

    with pytest.raises(FileNotFoundError):
        load_chip_features(mode="cached", policy_id=8368)
