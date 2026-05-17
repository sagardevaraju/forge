"""Task P2.5 — Stratified importance sampling on Saffir-Simpson buckets.

Importance sampling (IS) lets us spend more scenario budget on the tail
of the hurricane intensity distribution — the Cat 3 / Cat 4-5 storms
that drive the carrier's VaR-99 and TVaR-99 — without inflating the
unconditional draws of weaker storms.  Stratified IS partitions the
storm-intensity space into Saffir-Simpson buckets and draws an equal
``n_per_bucket`` from each.  Downstream IS-corrected expectations apply
the Horvitz-Thompson weight ``p_bucket / n_per_bucket`` per sample::

    E_p[f(s)]  ≈  Σ_b  p_bucket[b]  ·  ( 1/n_per_bucket  Σ_{s∈b}  f(s) )

P2.5 ships the sampler + the bucket-frequency table.  The IS correction
itself is applied at TVaR-evaluation time by P2.6 / P2.7.  Each sample
this module returns therefore carries an *uncorrected* weight of 1.0;
the IS-correction factor lives separately on
``ATLANTIC_BASIN_FREQUENCIES``.

Calibration source
------------------
Atlantic-basin hurricane landfall frequency by Saffir-Simpson category,
based on NOAA Storm Events Database 1980–2024 tropical-cyclone landfall
counts.  Source: NOAA Storm Events Database 1980-2024, Atlantic basin
tropical cyclone landfalls by Saffir-Simpson category (approximate;
precise fit deferred to a Phase 3 recalibration).  See
https://www.ncdc.noaa.gov/stormevents/.

The numbers below are publicly-known order-of-magnitude landfall
frequencies — Cat 4-5 landfalls average roughly one every 20 years, etc.
A higher-fidelity HURDAT2 fit is scheduled for Task P2.10.

Saffir-Simpson bucket definitions
---------------------------------
``tropical``  — Tropical Storm / Tropical Depression (wind 35-73 mph).
``cat1``      — Saffir-Simpson Cat 1 (74-95 mph).
``cat2``      — Saffir-Simpson Cat 2 (96-110 mph).
``cat3``      — Saffir-Simpson Cat 3 (111-129 mph).
``cat4+``     — Saffir-Simpson Cat 4 + Cat 5 merged (130-185 mph).  Cat 5
                landfalls are rare enough that merging the bucket gives
                a more stable per-bucket mean for downstream estimators.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

# ── bucket-frequency table (IS correction factor) ──────────────────────────
#
# Probability that a landfalling Atlantic tropical cyclone falls in each
# Saffir-Simpson bucket.  Sums to 1.0 by construction.  Source: NOAA
# Storm Events Database 1980-2024 — see module docstring.

ATLANTIC_BASIN_FREQUENCIES: dict[str, float] = {
    "tropical": 0.40,  # Tropical Storms make landfall yearly
    "cat1": 0.30,
    "cat2": 0.15,
    "cat3": 0.10,
    "cat4+": 0.05,  # Cat 4-5 landfall ~1 every 20 years
}

# ── bucket peak-wind ranges (mph) ──────────────────────────────────────────
#
# Saffir-Simpson wind thresholds.  ``tropical`` covers TS-strength
# (35 mph floor — below that we drop the system from the catalog).
# ``cat4+`` upper bound clamps at 185 mph (modern Atlantic record-class).

BUCKET_WIND_RANGES: dict[str, tuple[float, float]] = {
    "tropical": (35.0, 73.0),
    "cat1": (74.0, 95.0),
    "cat2": (96.0, 110.0),
    "cat3": (111.0, 129.0),
    "cat4+": (130.0, 185.0),
}

# Category-number lookup for downstream consumers that prefer the
# numeric form (e.g. plotting axis labels).  ``cat4+`` is reported as 4.
_BUCKET_CATEGORY: dict[str, int] = {
    "tropical": 0,
    "cat1": 1,
    "cat2": 2,
    "cat3": 3,
    "cat4+": 4,
}


# ── public API ─────────────────────────────────────────────────────────────


def stratified_sample(
    *,
    n_per_bucket: int,
    buckets: Sequence[str],
    seed: int = 0,
) -> list[dict]:
    """Draw ``n_per_bucket`` storms from each Saffir-Simpson bucket.

    Parameters
    ----------
    n_per_bucket:
        Number of samples per bucket.  Total length of the returned list
        is ``len(buckets) * n_per_bucket``.
    buckets:
        Ordered iterable of bucket labels to draw from.  Must each be a
        key of :data:`BUCKET_WIND_RANGES`.
    seed:
        RNG seed for ``numpy.random.default_rng``.  Same seed →
        bit-identical output.

    Returns
    -------
    list[dict]
        One dict per sample with keys::

            "bucket"        — bucket label (str)
            "category"      — Saffir-Simpson category number (int, 0..4)
            "peak_wind_mph" — uniform draw within bucket range (float, mph)
            "weight"        — uncorrected weight, always 1.0

        The IS correction factor ``p_bucket / n_per_bucket`` lives on
        :data:`ATLANTIC_BASIN_FREQUENCIES` and is applied downstream at
        expectation-evaluation time (P2.6 / P2.7).
    """
    if n_per_bucket <= 0:
        return []

    unknown = [b for b in buckets if b not in BUCKET_WIND_RANGES]
    if unknown:
        raise ValueError(
            f"Unknown Saffir-Simpson bucket(s): {unknown}. "
            f"Valid keys: {list(BUCKET_WIND_RANGES)}"
        )

    rng = np.random.default_rng(seed)

    samples: list[dict] = []
    for bucket in buckets:
        lo, hi = BUCKET_WIND_RANGES[bucket]
        winds = rng.uniform(lo, hi, size=n_per_bucket)
        for w in winds:
            samples.append(
                {
                    "bucket": bucket,
                    "category": _BUCKET_CATEGORY[bucket],
                    "peak_wind_mph": round(float(w), 2),
                    "weight": 1.0,
                }
            )
    return samples


__all__ = [
    "ATLANTIC_BASIN_FREQUENCIES",
    "BUCKET_WIND_RANGES",
    "stratified_sample",
]
