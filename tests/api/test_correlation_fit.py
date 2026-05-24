"""Tests for the AUDIT.1 common-factor fitter.

``api_py.correlation_fit`` is a pure-Python module — no DB, no I/O.
These tests feed synthetic episode totals + synthetic ``storm_events``
row dicts and verify the fitter's contract: noise-free output, the
INSUFFICIENT_EPISODES gate, FIT_ERROR conditions.
"""

from __future__ import annotations

import math

import pytest

from api_py.correlation_fit import (
    MIN_EPISODES_FOR_FIT,
    CommonFactorFit,
    InsufficientDataNote,
    fit_beta_from_episode_totals,
    fit_common_factor_from_storm_events,
)


# ────────────────────────────────────────────────────────────────────────
# fit_beta_from_episode_totals — pure linear-CoV
# ────────────────────────────────────────────────────────────────────────


class TestFitBetaFromEpisodeTotals:

    def test_constant_totals_yield_zero_beta(self):
        """Every episode the same → no variance → β = 0."""
        assert fit_beta_from_episode_totals([1.0, 1.0, 1.0, 1.0]) == 0.0

    def test_known_cov_recovered_exactly(self):
        """Totals [1, 2, 3, 4]: mean=2.5, var=5/3, std=sqrt(5/3),
        β = std/mean ≈ 0.516."""
        totals = [1.0, 2.0, 3.0, 4.0]
        beta = fit_beta_from_episode_totals(totals)
        expected = math.sqrt(5.0 / 3.0) / 2.5
        assert abs(beta - expected) < 1e-12

    def test_scale_invariance(self):
        """β is unitless — scaling all totals by the same constant
        leaves it unchanged."""
        a = fit_beta_from_episode_totals([1.0, 2.0, 3.0, 4.0])
        b = fit_beta_from_episode_totals([1e6, 2e6, 3e6, 4e6])
        assert abs(a - b) < 1e-12

    def test_single_episode_raises(self):
        with pytest.raises(ValueError, match="at least 2"):
            fit_beta_from_episode_totals([1_000_000.0])

    def test_empty_raises(self):
        with pytest.raises(ValueError, match="at least 2"):
            fit_beta_from_episode_totals([])

    def test_zero_mean_raises(self):
        with pytest.raises(ValueError, match="non-positive mean"):
            fit_beta_from_episode_totals([0.0, 0.0])

    def test_negative_mean_raises(self):
        """The damage scale is non-negative by construction; a negative
        sum would mean an upstream parsing bug."""
        with pytest.raises(ValueError, match="non-positive mean"):
            fit_beta_from_episode_totals([-1.0, -2.0, -3.0])


# ────────────────────────────────────────────────────────────────────────
# fit_common_factor_from_storm_events
# ────────────────────────────────────────────────────────────────────────


def _row(*, year=2024, state="FL", event_type="Hurricane", damage=1e8):
    return {
        "year": year,
        "state": state,
        "event_type": event_type,
        "damage_property": damage,
    }


class TestFitCommonFactorInsufficientData:

    def test_empty_rows_returns_insufficient(self):
        out = fit_common_factor_from_storm_events([])
        assert out["fitted"] is False
        assert "INSUFFICIENT_EPISODES" in out["reason"]
        assert out["n_episodes"] == 0
        assert out["min_episodes"] == MIN_EPISODES_FOR_FIT

    def test_default_threshold_blocks_thin_corpus(self):
        """Current production corpus (337 rows × 4 storms in 2024)
        falls below the 8-episode gate under the (year, state,
        event_type) grouping."""
        rows = [
            _row(state="FL", event_type="Hurricane"),
            _row(state="TX", event_type="Hurricane"),
            _row(state="LA", event_type="Hurricane"),
            _row(state="NC", event_type="Tropical Storm"),
        ]
        out = fit_common_factor_from_storm_events(rows)
        assert out["fitted"] is False
        assert out["n_episodes"] == 4

    def test_lowered_threshold_allows_thin_corpus(self):
        """Caller can override min_episodes for a "best-effort" fit."""
        rows = [
            _row(state="FL", damage=1e8),
            _row(state="TX", damage=2e8),
            _row(state="LA", damage=3e8),
            _row(state="NC", damage=4e8),
        ]
        out = fit_common_factor_from_storm_events(rows, min_episodes=4)
        assert "beta" in out
        assert out["n_episodes"] == 4


class TestFitCommonFactorGrouping:

    def test_default_grouping_by_year_state_event_type(self):
        # Two FL rows with different counties should collapse into ONE
        # episode under (year, state, event_type).
        rows = [
            _row(state="FL", damage=5e7),
            _row(state="FL", damage=5e7),
            _row(state="TX", damage=1e8),
            _row(state="LA", damage=2e8),
            _row(state="NC", damage=4e8),
        ]
        out = fit_common_factor_from_storm_events(rows, min_episodes=4)
        # 4 episodes after grouping: FL=1e8, TX=1e8, LA=2e8, NC=4e8.
        assert out["n_episodes"] == 4
        # β = std([1e8, 1e8, 2e8, 4e8]) / mean = std/2e8.
        expected_beta = (
            math.sqrt(sum((x - 2e8) ** 2 for x in [1e8, 1e8, 2e8, 4e8]) / 3)
            / 2e8
        )
        assert abs(out["beta"] - expected_beta) < 1e-9

    def test_custom_group_key_uses_episode_id(self):
        """Once EPISODE_ID lands in the schema, the caller passes a
        custom group_key that uses it for finer-grained grouping."""
        rows = [
            {"episode_id": "E1", "damage_property": 1e8},
            {"episode_id": "E1", "damage_property": 1e8},
            {"episode_id": "E2", "damage_property": 2e8},
            {"episode_id": "E3", "damage_property": 3e8},
            {"episode_id": "E4", "damage_property": 4e8},
            {"episode_id": "E5", "damage_property": 5e8},
            {"episode_id": "E6", "damage_property": 6e8},
            {"episode_id": "E7", "damage_property": 7e8},
            {"episode_id": "E8", "damage_property": 8e8},
        ]
        out = fit_common_factor_from_storm_events(
            rows,
            group_key=lambda r: (r["episode_id"],),
            min_episodes=8,
        )
        assert "beta" in out
        assert out["n_episodes"] == 8


class TestFitCommonFactorRowFiltering:

    def test_null_damage_rows_dropped(self):
        rows = [
            _row(state="FL", damage=1e8),
            {"year": 2024, "state": "TX", "event_type": "Hurricane",
             "damage_property": None},  # filtered out
            _row(state="LA", damage=2e8),
            _row(state="NC", damage=3e8),
        ]
        out = fit_common_factor_from_storm_events(rows, min_episodes=3)
        assert out["n_episodes"] == 3

    def test_zero_damage_episodes_dropped(self):
        """A whole episode summing to 0 damage_property is almost
        certainly an ingestion artifact; drop it rather than letting
        it drag the mean down to a nonsense β."""
        rows = [
            _row(state="FL", damage=1e8),
            _row(state="TX", damage=0.0),  # episode sums to 0 → filtered
            _row(state="LA", damage=2e8),
            _row(state="NC", damage=3e8),
        ]
        out = fit_common_factor_from_storm_events(rows, min_episodes=3)
        assert out["n_episodes"] == 3


class TestFitCommonFactorSuccessShape:

    def _ten_episodes(self):
        return [
            {"episode_id": f"E{i}", "damage_property": (i + 1) * 1e8}
            for i in range(10)
        ]

    def test_successful_fit_carries_required_keys(self):
        rows = self._ten_episodes()
        out = fit_common_factor_from_storm_events(
            rows,
            group_key=lambda r: (r["episode_id"],),
        )
        # Type-narrow the success case.
        assert "beta" in out and "sigma" in out
        assert isinstance(out["beta"], float)
        assert out["sigma"] == 1.0
        assert out["method"] == "cov_per_episode_total"
        assert out["source"] == "noaa_storm_events"
        assert out["n_episodes"] == 10

    def test_beta_in_reasonable_range_on_typical_corpus(self):
        """A 10-episode corpus with totals 1×–10× ($1e8..$1e9) should
        produce β in the 0.4-0.7 range (CoV of an arithmetic sequence
        with mean 5.5 and std 3.03 is 3.03/5.5 ≈ 0.55)."""
        rows = self._ten_episodes()
        out = fit_common_factor_from_storm_events(
            rows,
            group_key=lambda r: (r["episode_id"],),
        )
        assert 0.4 < out["beta"] < 0.7
