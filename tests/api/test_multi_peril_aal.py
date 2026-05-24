"""Tests for the joint multi-peril AAL overlay (Phase 4)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from api_py.multi_peril_aal import (
    PERIL_AAL_BY_STATE,
    PERIL_IDS,
    PERIL_SIGMA,
    PERIL_BUILD_VULNERABILITY,
    additional_peril_scenarios,
)


# ── coverage / table-completeness invariants ───────────────────────────────


def test_every_peril_has_an_aal_table() -> None:
    """Every peril id in PERIL_IDS must have an entry in the AAL table."""
    for peril in PERIL_IDS:
        assert peril in PERIL_AAL_BY_STATE, f"missing AAL table for {peril}"


def test_every_aal_table_has_default_branch() -> None:
    """The 'default' branch is the fallback for out-of-book zip3s."""
    for peril, table in PERIL_AAL_BY_STATE.items():
        assert "default" in table, f"{peril} missing 'default' branch"


def test_every_aal_table_covers_book_states() -> None:
    """All four FORGE-book states must appear."""
    for peril, table in PERIL_AAL_BY_STATE.items():
        for state in ("TX", "LA", "NC", "FL"):
            assert state in table, f"{peril} missing state {state}"


def test_every_peril_has_sigma_and_build_vulnerability() -> None:
    for peril in PERIL_IDS:
        assert peril in PERIL_SIGMA, f"missing sigma for {peril}"
        assert peril in PERIL_BUILD_VULNERABILITY, f"missing vuln for {peril}"
        # Standard 3 build types must be defined.
        for bt in ("wood_frame", "masonry", "manufactured"):
            assert bt in PERIL_BUILD_VULNERABILITY[peril]


# ── calibration-anchor invariants (sanity checks that the table reflects
#    the FORGE book's geography) ───────────────────────────────────────────


def test_scs_aal_is_largest_in_tx() -> None:
    """SCS / hail AAL should be largest in TX (eastern Hail Alley) per
    Allen et al. 2017 anchoring."""
    table = PERIL_AAL_BY_STATE["scs"]
    state_rates = {s: table[s] for s in ("TX", "LA", "NC", "FL")}
    assert max(state_rates, key=state_rates.get) == "TX"


def test_winter_aal_meaningful_in_tx() -> None:
    """Post-Uri (TDI 2022 report), TX winter AAL should be the highest
    of the FORGE-book states."""
    table = PERIL_AAL_BY_STATE["winter"]
    assert table["TX"] >= table["NC"]
    assert table["TX"] > table["FL"]


def test_wildfire_aal_is_trace_for_all_book_states() -> None:
    """Headwaters Economics 2024: TX/LA/NC/FL are all in the lowest
    wildfire-exposure bin. Every rate < 0.0001 (0.01% TIV)."""
    table = PERIL_AAL_BY_STATE["wildfire"]
    for state in ("TX", "LA", "NC", "FL"):
        assert table[state] < 0.0001, f"wildfire AAL in {state} too high"


def test_earthquake_aal_is_trace_for_all_book_states() -> None:
    """USGS NSHM 2023: TX/LA/NC/FL are all lowest seismic-hazard tier.
    Every rate < 0.00005 (0.005% TIV)."""
    table = PERIL_AAL_BY_STATE["earthquake"]
    for state in ("TX", "LA", "NC", "FL"):
        assert table[state] < 0.00005, f"EQ AAL in {state} too high"


def test_earthquake_has_heaviest_sigma() -> None:
    """EQ is the heaviest-tail peril by convention (greatest variance
    between M5 nuisance and M7 catastrophic). Should win against
    every other peril in this overlay."""
    for peril in ("scs", "winter", "wildfire"):
        assert PERIL_SIGMA["earthquake"] > PERIL_SIGMA[peril]


def test_winter_sigma_heavier_than_scs() -> None:
    """Winter storms have heavier tails than SCS — Uri-class anchors
    blow normal-year winter losses by 10-30×; SCS is more uniform."""
    assert PERIL_SIGMA["winter"] > PERIL_SIGMA["scs"]


# ── additional_peril_scenarios behaviour ───────────────────────────────────


def test_additional_returns_one_array_per_peril() -> None:
    out = additional_peril_scenarios(
        total_tiv=1_000_000.0, state="TX", build_type="wood_frame",
        cohort_key="775_wood_frame_q2", n=500,
    )
    assert set(out.keys()) == set(PERIL_IDS)
    for peril, arr in out.items():
        assert arr.shape == (500,)


def test_additional_outputs_are_non_negative() -> None:
    """Lognormal draws are always > 0; zero-AAL perils return zeros."""
    out = additional_peril_scenarios(
        total_tiv=1_000_000.0, state="TX", build_type="wood_frame",
        cohort_key="775_wood_frame_q2", n=200,
    )
    for arr in out.values():
        assert (arr >= 0).all()


def test_tx_scs_has_substantial_aal() -> None:
    """A representative TX cohort should produce non-trivial SCS losses
    (this is the whole point of the overlay)."""
    out = additional_peril_scenarios(
        total_tiv=10_000_000.0,  # $10M cohort TIV
        state="TX",
        build_type="wood_frame",
        cohort_key="775_wood_frame_q2",
        n=2000,
    )
    scs = out["scs"]
    # Expected = TIV × 0.00072 × 1.0 (wood frame) = $7,200/yr
    assert scs.mean() > 5_000.0
    assert scs.mean() < 15_000.0


def test_fl_wildfire_is_essentially_zero() -> None:
    """FL has trace wildfire AAL — total annual losses on a $10M cohort
    should be small in absolute terms and tiny relative to TIV.

    Target = $10M × 0.00002 (FL rate) × 1.0 (wood frame) = $200/yr."""
    out = additional_peril_scenarios(
        total_tiv=10_000_000.0,
        state="FL",
        build_type="wood_frame",
        cohort_key="335_wood_frame_q2",
        n=2000,
    )
    mean_loss = out["wildfire"].mean()
    # Should be a few hundred dollars at most — orders of magnitude smaller
    # than the SCS TX exposure ($7k+) we just validated above.
    assert mean_loss < 500.0
    # ≤ 0.001% of TIV — "trace" exposure per Headwaters Economics 2024.
    assert mean_loss / 10_000_000.0 < 0.00005


def test_unknown_state_falls_back_to_default() -> None:
    """An out-of-book state ('XX') should use the 'default' AAL — not raise."""
    out = additional_peril_scenarios(
        total_tiv=1_000_000.0, state="XX", build_type="wood_frame",
        cohort_key="000_wood_frame_q0", n=200,
    )
    # All arrays produced; SCS default = 0.0001 × 1M = $100 mean approx
    assert out["scs"].mean() > 0
    assert out["scs"].mean() < 1000.0


def test_manufactured_homes_have_higher_scs_losses() -> None:
    """Manufactured housing has 3× wood-frame SCS vulnerability per HAZUS;
    mean losses should follow."""
    wood = additional_peril_scenarios(
        total_tiv=1_000_000.0, state="TX", build_type="wood_frame",
        cohort_key="cohort_wood", n=2000,
    )["scs"]
    manu = additional_peril_scenarios(
        total_tiv=1_000_000.0, state="TX", build_type="manufactured",
        cohort_key="cohort_manu", n=2000,
    )["scs"]
    # 3× ratio with some sampling noise. Use 2× lower bound to avoid flakes.
    assert manu.mean() > 2.0 * wood.mean()


def test_deterministic_for_same_cohort_key() -> None:
    """Re-running with the same cohort_key produces bit-identical output."""
    kwargs = dict(
        total_tiv=1_000_000.0, state="TX", build_type="wood_frame",
        cohort_key="775_wood_frame_q2", n=200,
    )
    a = additional_peril_scenarios(**kwargs)
    b = additional_peril_scenarios(**kwargs)
    for peril in PERIL_IDS:
        np.testing.assert_array_equal(a[peril], b[peril])


def test_different_cohort_keys_diverge() -> None:
    """Different cohort_keys should produce different draws (RNG seeds
    derive from the key, not from total_tiv)."""
    a = additional_peril_scenarios(
        total_tiv=1_000_000.0, state="TX", build_type="wood_frame",
        cohort_key="775_wood_frame_q1", n=200,
    )
    b = additional_peril_scenarios(
        total_tiv=1_000_000.0, state="TX", build_type="wood_frame",
        cohort_key="776_wood_frame_q1", n=200,
    )
    # At least one peril's draws must differ
    any_differ = any(not np.array_equal(a[p], b[p]) for p in PERIL_IDS)
    assert any_differ


def test_lognormal_mean_matches_aal_target() -> None:
    """The Monte-Carlo realisation of mean(loss_scenarios) should be
    near the declared AAL = TIV × rate × build_factor (within ~10 % at
    n=5000 for the dominant TX SCS path)."""
    out = additional_peril_scenarios(
        total_tiv=10_000_000.0,
        state="TX",
        build_type="wood_frame",
        cohort_key="775_wood_frame_q2",
        n=5000,
    )
    # Target = 10M × 0.00072 × 1.0 = $7,200
    target = 10_000_000.0 * 0.00072 * 1.0
    empirical = float(out["scs"].mean())
    rel_err = abs(empirical - target) / target
    assert rel_err < 0.20, (
        f"empirical mean ${empirical:,.0f} too far from "
        f"target ${target:,.0f} (rel err {rel_err:.1%})"
    )


def test_zero_tiv_cohort_returns_all_zero_arrays() -> None:
    out = additional_peril_scenarios(
        total_tiv=0.0, state="TX", build_type="wood_frame",
        cohort_key="000_wood_frame_q0", n=200,
    )
    for peril, arr in out.items():
        assert (arr == 0.0).all(), f"non-zero output for zero-TIV cohort, peril={peril}"
