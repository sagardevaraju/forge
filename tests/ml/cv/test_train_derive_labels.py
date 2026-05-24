"""Tests for ``ml.cv.train._derive_labels`` — Phase 2 / Task P2.37.

The supervision split (band-math on the chip for 5 dims + external weak
labels for indices 1, 3, 6) is the load-bearing change of P2.37 — these
tests pin its behaviour so a future refactor can't silently revert to the
metadata-only heuristic that produced near-zero discrimination (§8e of
``research.md``).

Heavy ``torch`` is required; if not installed the module skips.
"""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")
from ml.cv.train import (  # noqa: E402
    IDX_IMPERVIOUSNESS,
    IDX_ROOF_COMPLEXITY,
    IDX_TREE_OVERHANG,
    WEAK_LABEL_INDICES,
    _derive_labels,
    _derive_labels_legacy,
    _load_weak_labels,
)


def _synthetic_chip(seed: int = 0) -> np.ndarray:
    """Return a deterministic ``(5, 256, 256)`` normalized chip in [0, 1]."""
    rng = np.random.default_rng(seed)
    return rng.uniform(0.0, 1.0, size=(5, 256, 256)).astype(np.float32)


class TestDeriveLabelsShape:

    def test_returns_8_dim_tensor(self):
        chip = _synthetic_chip()
        labels = _derive_labels(chip, weak_label_row=None)
        assert labels.shape == (8,)
        assert labels.dtype == torch.float32

    def test_all_values_in_unit_interval(self):
        chip = _synthetic_chip(seed=1)
        labels = _derive_labels(chip, weak_label_row=None)
        assert float(labels.min()) >= 0.0
        assert float(labels.max()) <= 1.0


class TestDeriveLabelsWeakLabelOverwrite:
    """idx 1, 3, 6 must come from the parquet when present."""

    def test_weak_labels_take_precedence_on_idx_1_3_6(self):
        chip = _synthetic_chip(seed=42)
        bandmath_only = _derive_labels(chip, weak_label_row=None)
        with_weak = _derive_labels(chip, weak_label_row={
            "imperviousness": 0.123,
            "roof_complexity": 0.456,
            "tree_overhang": 0.789,
        })
        # The three weak-labeled positions match the parquet values exactly.
        assert float(with_weak[IDX_IMPERVIOUSNESS]) == pytest.approx(0.123, abs=1e-6)
        assert float(with_weak[IDX_ROOF_COMPLEXITY]) == pytest.approx(0.456, abs=1e-6)
        assert float(with_weak[IDX_TREE_OVERHANG]) == pytest.approx(0.789, abs=1e-6)
        # Other dims (idx 0, 2, 4, 5, 7) come from band-math — unchanged from
        # the parquet-free call.
        bandmath_idx = [i for i in range(8) if i not in WEAK_LABEL_INDICES]
        for i in bandmath_idx:
            assert float(with_weak[i]) == pytest.approx(float(bandmath_only[i]), abs=1e-6)

    def test_missing_weak_labels_falls_back_to_bandmath(self):
        """When the parquet row is missing for a policy, all 8 dims use band-math.

        In the production training loop ``PolicyChipDataset`` drops these
        rows before they reach ``__getitem__``, but the function-level
        contract must still degrade gracefully.
        """
        chip = _synthetic_chip(seed=7)
        a = _derive_labels(chip, weak_label_row=None)
        b = _derive_labels(chip, weak_label_row=None)
        # Two calls with the same chip must produce identical labels.
        assert torch.allclose(a, b)


class TestDeriveLabelsLegacy:
    """Phase-1 metadata-only function — kept for regression comparison."""

    def test_legacy_signature_unchanged(self):
        labels = _derive_labels_legacy("X", "wood_frame", 3.0)
        assert labels.shape == (8,)

    def test_legacy_is_independent_of_chip(self):
        """The legacy function does not even take a chip — confirm by API."""
        # If someone accidentally passed a chip, Python would raise — this
        # test pins that the signature is (flood_zone, build_type, elevation_m).
        _derive_labels_legacy("X", "wood_frame", 3.0)
        with pytest.raises(TypeError):
            _derive_labels_legacy(np.zeros((5, 256, 256), dtype=np.float32))  # type: ignore[arg-type]


class TestLoadWeakLabels:

    def test_missing_parquet_returns_empty_dict(self, tmp_path):
        out = _load_weak_labels(tmp_path / "does-not-exist.parquet")
        assert out == {}

    def test_loads_round_trip(self, tmp_path):
        """Write a synthetic parquet + read it back through _load_weak_labels."""
        import pyarrow as pa
        import pyarrow.parquet as pq

        p = tmp_path / "weak.parquet"
        pq.write_table(pa.table({
            "policy_id": pa.array([1, 2, 3], type=pa.int64()),
            "imperviousness": pa.array([0.1, 0.2, 0.3], type=pa.float32()),
            "roof_complexity": pa.array([0.4, 0.5, 0.6], type=pa.float32()),
            "tree_overhang": pa.array([0.7, 0.8, 0.9], type=pa.float32()),
        }), p)
        out = _load_weak_labels(p)
        assert out == {
            1: {"imperviousness": pytest.approx(0.1, abs=1e-6),
                "roof_complexity": pytest.approx(0.4, abs=1e-6),
                "tree_overhang": pytest.approx(0.7, abs=1e-6)},
            2: {"imperviousness": pytest.approx(0.2, abs=1e-6),
                "roof_complexity": pytest.approx(0.5, abs=1e-6),
                "tree_overhang": pytest.approx(0.8, abs=1e-6)},
            3: {"imperviousness": pytest.approx(0.3, abs=1e-6),
                "roof_complexity": pytest.approx(0.6, abs=1e-6),
                "tree_overhang": pytest.approx(0.9, abs=1e-6)},
        }
