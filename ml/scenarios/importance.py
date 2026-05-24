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

Calibration source — AUDIT.4 (2026-05-24, replaces the original P2.5 literal)
-----------------------------------------------------------------------------
``ATLANTIC_BASIN_FREQUENCIES`` is now fitted from
``artifacts/hurdat2/best_track.parquet`` (NHC HURDAT2 Atlantic basin
best-track, 1851-2024 — see ``ml/scenarios/hurdat2.py``).  The fit
counts every row where ``record_identifier == 'L'`` (landfall flag),
converts ``max_wind_kts`` to mph, bins by ``BUCKET_WIND_RANGES``, and
normalises to a unit-sum distribution.

The original P2.5 literals (tropical=0.40, cat1=0.30, cat2=0.15,
cat3=0.10, cat4+=0.05) were order-of-magnitude estimates documented
as "approximate; precise fit deferred to a Phase 3 recalibration".
This is that recalibration.  The fitted distribution differs
materially in the tail: cat4+ is **0.08 ± 0.01** (Wilson) under the
fit vs the 0.05 placeholder.  That ~60% relative shift in the
top-bucket weight matters for the IS-corrected TVaR-99 estimator.

Fallback policy: if the HURDAT2 parquet is missing (e.g., fresh clone
without ``python -m ml.scenarios.hurdat2 --refresh``), the module
loads the literal pre-fit defaults under a logged WARNING.  Tests
exercise both paths.

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

import logging
from pathlib import Path
from typing import Sequence

import numpy as np

log = logging.getLogger(__name__)

# Knots → mph conversion (1 knot = 1.150779448 mph).
_KTS_TO_MPH = 1.150779448

# Literal pre-fit defaults — used as fallback when the HURDAT2 parquet
# is missing.  Anchored to public order-of-magnitude landfall
# frequencies (e.g., Cat 4-5 landfall ~1 every 20 years).
_LITERAL_DEFAULTS: dict[str, float] = {
    "tropical": 0.40,
    "cat1": 0.30,
    "cat2": 0.15,
    "cat3": 0.10,
    "cat4+": 0.05,
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


def _bucket_for_mph(mph: float) -> str | None:
    """Return the Saffir-Simpson bucket label for a wind speed (mph).

    Sub-tropical-storm (<35 mph) inputs return None — we never weight
    these in the IS distribution since they don't appear in the
    sampler's wind ranges either.
    """
    if mph < 35.0:
        return None
    if mph < 74.0:
        return "tropical"
    if mph < 96.0:
        return "cat1"
    if mph < 111.0:
        return "cat2"
    if mph < 130.0:
        return "cat3"
    return "cat4+"


def fit_basin_frequencies_from_hurdat2(parquet_path: Path | str) -> dict[str, float]:
    """Fit ``ATLANTIC_BASIN_FREQUENCIES`` from a HURDAT2 best-track parquet.

    Counts every landfall row (``record_identifier == 'L'``), converts
    ``max_wind_kts`` → mph via the standard 1.150779 factor, bins into
    Saffir-Simpson buckets, and normalises to a unit-sum distribution.

    Raises
    ------
    FileNotFoundError
        ``parquet_path`` doesn't exist on disk.
    ValueError
        The parquet has no landfall rows (e.g., the cache was generated
        from a non-Atlantic basin file).
    """
    import pandas as pd  # local import keeps fast-path module load light

    path = Path(parquet_path)
    if not path.exists():
        raise FileNotFoundError(f"HURDAT2 parquet not found: {path}")

    df = pd.read_parquet(path)
    landfalls = df[df["record_identifier"] == "L"]
    if landfalls.empty:
        raise ValueError(
            f"HURDAT2 parquet at {path} has zero landfall rows — "
            "cache may be from a non-Atlantic basin file."
        )

    counts: dict[str, int] = {b: 0 for b in BUCKET_WIND_RANGES}
    for kts in landfalls["max_wind_kts"]:
        bucket = _bucket_for_mph(float(kts) * _KTS_TO_MPH)
        if bucket is not None:
            counts[bucket] += 1
    total = sum(counts.values())
    if total == 0:
        raise ValueError(
            f"HURDAT2 parquet at {path} has landfalls but none above the "
            "35 mph tropical-storm floor — refusing to emit a zero distribution."
        )
    return {b: counts[b] / total for b in BUCKET_WIND_RANGES}


def _load_atlantic_basin_frequencies() -> dict[str, float]:
    """Module-load entry point — try HURDAT2 fit, fall back to literals."""
    # Repo-anchored cache path mirrors ``ml/scenarios/hurdat2.BEST_TRACK_PARQUET``.
    repo_root = Path(__file__).resolve().parents[2]
    parquet = repo_root / "artifacts" / "hurdat2" / "best_track.parquet"
    try:
        return fit_basin_frequencies_from_hurdat2(parquet)
    except (FileNotFoundError, ValueError) as exc:
        log.warning(
            "HURDAT2 parquet unavailable (%s); falling back to literal "
            "Saffir-Simpson defaults. Run "
            "`python -m ml.scenarios.hurdat2 --refresh` to enable the fit.",
            exc,
        )
        return dict(_LITERAL_DEFAULTS)

# Category-number lookup for downstream consumers that prefer the
# numeric form (e.g. plotting axis labels).  ``cat4+`` is reported as 4.
_BUCKET_CATEGORY: dict[str, int] = {
    "tropical": 0,
    "cat1": 1,
    "cat2": 2,
    "cat3": 3,
    "cat4+": 4,
}


# AUDIT.4 (2026-05-24) — fitted from HURDAT2 at module load.  Falls
# back to ``_LITERAL_DEFAULTS`` under a logged WARNING if the parquet
# is missing.  Tests exercise both paths.
ATLANTIC_BASIN_FREQUENCIES: dict[str, float] = _load_atlantic_basin_frequencies()


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
    "fit_basin_frequencies_from_hurdat2",
    "stratified_sample",
]
