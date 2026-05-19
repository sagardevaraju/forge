"""Task SIM.11 — Shared cohort-key helpers for quintile-aware keying.

The canonical cohort key format is ``{zip3}_{build_type}_q{N}`` where N is
the TIV quintile 0..4 computed over the *entire* policy book using the same
linear-interpolation cut-points as ``lib/db/cohorts.ts`` and
``scripts/precompute_portfolio_optimization.py::_aggregate_cohorts_from_sqlite``.

This module extracts that quintile logic so both the MIP precompute script and
the sim-loss promote path use bit-identical cuts — preventing the cohort-key
mismatch bug where the promote path emitted prefix-only keys
(``{zip3}_{build_type}``) that never matched the MIP cohort store.
"""

from __future__ import annotations

from typing import Iterable


def _tiv_quintile_cuts(tivs_sorted: list[float]) -> list[float]:
    """Compute the four quintile cut-points using linear interpolation.

    Matches the implementation in lib/db/cohorts.ts and the inline version in
    scripts/precompute_portfolio_optimization.py::_aggregate_cohorts_from_sqlite
    (lines 181-192 of that file).

    Parameters
    ----------
    tivs_sorted:
        All TIV values from the policy book, pre-sorted ascending.

    Returns
    -------
    list[float]
        Four cut-points separating quintiles 0, 1, 2, 3, 4.
    """
    n = len(tivs_sorted)
    if n == 0:
        return [0.0, 0.0, 0.0, 0.0]
    cuts: list[float] = []
    for q in range(1, 5):
        rank = (q / 5) * (n - 1)
        lo = int(rank)
        hi = lo + (0 if rank == lo else 1)
        if lo == hi or hi >= n:
            cuts.append(tivs_sorted[lo])
        else:
            w = rank - lo
            cuts.append(tivs_sorted[lo] * (1 - w) + tivs_sorted[hi] * w)
    return cuts


def _bucket(tiv: float, cuts: list[float]) -> int:
    """Return 0..4 quintile index for a single TIV value."""
    for i, c in enumerate(cuts):
        if tiv < c:
            return i
    return 4


def policy_quintile_lookup(
    policies: Iterable[tuple],
) -> dict[int, int]:
    """Return ``{policy_id: tiv_quintile}`` for every policy in *policies*.

    The quintile cuts are computed over the *entire* policy iterable (the
    full book) using the same linear-interpolation algorithm as
    ``lib/db/cohorts.ts`` and
    ``scripts/precompute_portfolio_optimization.py::_aggregate_cohorts_from_sqlite``.

    Parameters
    ----------
    policies:
        Iterable of ``(id, lat, lon, tiv, build_type, zip3)`` tuples.
        This is the canonical policy tuple format used throughout the
        FORGE codebase.

    Returns
    -------
    dict[int, int]
        Maps ``policy_id`` (index 0 in each tuple) to its TIV quintile
        in the range 0..4 inclusive.

    Notes
    -----
    The iterable is materialized once internally so that the two-pass
    algorithm (compute cuts, then assign buckets) works on any iterable
    type.
    """
    policy_list = list(policies)
    if not policy_list:
        return {}

    tivs_sorted = sorted(float(p[3]) for p in policy_list)
    cuts = _tiv_quintile_cuts(tivs_sorted)

    return {
        int(p[0]): _bucket(float(p[3]), cuts)
        for p in policy_list
    }


def cohort_key(policy: tuple, quintile: int) -> str:
    """Format the canonical cohort key for a single policy + its quintile.

    Parameters
    ----------
    policy:
        ``(id, lat, lon, tiv, build_type, zip3)`` tuple.
    quintile:
        TIV quintile 0..4 from ``policy_quintile_lookup``.

    Returns
    -------
    str
        ``"{zip3}_{build_type}_q{quintile}"``
    """
    return f"{policy[5]}_{policy[4]}_q{quintile}"
