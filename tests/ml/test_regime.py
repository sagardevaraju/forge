"""Task P2.3 — AMO/ENSO regime label tests.

The tests run offline using cached parquet artifacts under
``artifacts/regime/``.  The artifacts are committed to the repo (regenerable
via ``python -m ml.scenarios.regime --refresh``).
"""

from __future__ import annotations

from pathlib import Path

import pytest


ARTIFACT_DIR = Path(__file__).resolve().parents[2] / "artifacts" / "regime"
AMO_CACHE = ARTIFACT_DIR / "amo.parquet"
ONI_CACHE = ARTIFACT_DIR / "oni.parquet"


def test_regime_label_for_date():
    """Plan-mandated structural shape test."""
    from ml.scenarios.regime import regime_label

    out = regime_label(date="2024-09-15")
    assert out["amo_phase"] in ("warm", "cold")
    assert out["enso"] in ("nino", "neutral", "nina")


def test_regime_label_includes_traceability_fields():
    """Each call should expose raw index values and the resolved month."""
    from ml.scenarios.regime import regime_label

    out = regime_label(date="2024-09-15")
    assert "amo_value" in out
    assert "oni_value" in out
    assert out["month"] == "2024-09"
    assert isinstance(out["amo_value"], float)
    assert isinstance(out["oni_value"], float)


@pytest.mark.skipif(not AMO_CACHE.exists(), reason="amo cache not seeded")
def test_amo_cold_in_1985():
    """1985 is mid-cold-phase AMO (1971-1994 cold era). Probes classification."""
    from ml.scenarios.regime import regime_label

    out = regime_label(date="1985-08-15")
    assert out["amo_phase"] == "cold", f"Expected cold AMO in Aug 1985, got {out}"


@pytest.mark.skipif(not ONI_CACHE.exists(), reason="oni cache not seeded")
def test_enso_nino_in_1997():
    """October 1997 was the peak of the 1997-98 super El Niño (ONI ≥ +2)."""
    from ml.scenarios.regime import regime_label

    out = regime_label(date="1997-10-15")
    assert out["enso"] == "nino", f"Expected El Niño in Oct 1997, got {out}"


@pytest.mark.skipif(
    not (AMO_CACHE.exists() and ONI_CACHE.exists()),
    reason="regime cache not seeded",
)
def test_cache_hit_skips_network(monkeypatch):
    """Second call must hit cache and not invoke the network fetcher."""
    from ml.scenarios import regime

    # Reset any module-level memoization so we exercise the disk-cache path.
    regime._reset_cache_for_tests()

    fetch_calls = {"amo": 0, "oni": 0}

    def _explode_amo(*_a, **_kw):  # pragma: no cover - should not fire
        fetch_calls["amo"] += 1
        raise RuntimeError("network fetch must not be called when parquet exists")

    def _explode_oni(*_a, **_kw):  # pragma: no cover - should not fire
        fetch_calls["oni"] += 1
        raise RuntimeError("network fetch must not be called when parquet exists")

    monkeypatch.setattr(regime, "_fetch_amo_data", _explode_amo)
    monkeypatch.setattr(regime, "_fetch_oni_data", _explode_oni)

    first = regime.regime_label(date="2024-09-15")
    second = regime.regime_label(date="2024-09-15")

    assert first == second
    assert fetch_calls == {"amo": 0, "oni": 0}


def test_generate_scenarios_threads_regime_metadata():
    """generate_scenarios should accept a regime kwarg and surface it."""
    from ml.scenarios.generate import generate_scenarios

    regime = {"amo_phase": "warm", "enso": "nino", "month": "2024-09"}
    scs = generate_scenarios(storm_id="AL092024", n=4, regime=regime)
    assert len(scs) == 4
    for s in scs:
        assert s.get("regime") == regime
