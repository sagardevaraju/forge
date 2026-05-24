"""Task P3.13 — Peril plug-in ABC contract tests.

Pins the abstract base + registry behaviour so the next four perils
(P3.14 SCS, P3.15 wildfire, P3.16 EQ, P3.17 freeze) plug in against a
fixed contract.
"""

from __future__ import annotations

import pytest

from ml.perils import Peril, get_peril, register_peril, registered_perils
from ml.perils.hurricane import HurricanePeril


# ── ABC contract ───────────────────────────────────────────────────────────


def test_peril_is_abstract():
    """Peril cannot be instantiated directly — concrete subclasses required."""
    with pytest.raises(TypeError):
        Peril()  # type: ignore[abstract]


def test_subclass_without_peril_id_rejected_by_registry():
    """The registry refuses to register an instance with no peril_id."""

    class _Empty(Peril):
        def generate_scenarios(self, scenario_id, n=1000, **kwargs):
            return []

    with pytest.raises(ValueError, match="peril_id"):
        register_peril(_Empty())


def test_get_peril_unknown_raises_keyerror():
    with pytest.raises(KeyError, match="Unknown peril"):
        get_peril("not_a_real_peril_xyz")


def test_registered_perils_contains_hurricane():
    """Importing ml.perils auto-registers the built-in subclasses."""
    assert "hurricane" in registered_perils()


def test_register_is_idempotent_and_returns_instance():
    """Registering the same id twice replaces (useful for tests)."""

    class _Stub(Peril):
        peril_id = "stub_test_peril"

        def generate_scenarios(self, scenario_id, n=1000, **kwargs):
            return [{"kind": "stub_test_peril", "id": f"{scenario_id}_0001", "prob": 1.0}]

    a = register_peril(_Stub())
    b = register_peril(_Stub())
    assert isinstance(a, _Stub)
    assert isinstance(b, _Stub)
    assert get_peril("stub_test_peril") is b


# ── HurricanePeril subclass ────────────────────────────────────────────────


def test_hurricane_peril_id():
    assert HurricanePeril.peril_id == "hurricane"
    assert get_peril("hurricane").peril_id == "hurricane"


def test_hurricane_generate_matches_legacy_function():
    """HurricanePeril.generate_scenarios must produce the same scenarios
    as the legacy ``ml.scenarios.generate.generate_scenarios`` for the
    same storm_id + n — no semantic change, just a wrapper."""
    from ml.scenarios.generate import generate_scenarios as legacy

    legacy_scs = legacy(storm_id="AL092024", n=10)
    new_scs = HurricanePeril().generate_scenarios(scenario_id="AL092024", n=10)
    assert len(new_scs) == len(legacy_scs) == 10
    for a, b in zip(legacy_scs, new_scs):
        assert a["id"] == b["id"]
        assert a["path"] == b["path"]
        assert a["peak_wind"] == b["peak_wind"]
        # probabilities normalise the same way too
        assert abs(a["prob"] - b["prob"]) < 1e-12


def test_hurricane_scenarios_carry_required_keys():
    scs = HurricanePeril().generate_scenarios("AL092024", n=5)
    for s in scs:
        assert s["kind"] == "hurricane"
        assert "id" in s
        assert "prob" in s
    total = sum(s["prob"] for s in scs)
    assert abs(total - 1.0) < 1e-6


def test_hurricane_passes_kwargs_through():
    """Optional kwargs (regime, correlation, ensemble) must be forwarded."""
    members = [
        {
            "member_id": "AC01",
            "track": [
                {"lat": 25.0, "lng": -83.0, "t_hours": 0, "peak_wind": 130.0},
                {"lat": 26.0, "lng": -82.5, "t_hours": 24, "peak_wind": 140.0},
            ],
        }
    ]
    scs = HurricanePeril().generate_scenarios("AL092024", n=4, ensemble=members)
    assert len(scs) == 4
    for s in scs:
        assert s.get("member_id") == "AC01"
