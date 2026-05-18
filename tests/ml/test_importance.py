"""Task P2.5 — stratified importance sampling on Saffir-Simpson buckets.

Importance sampling lets the MIP / VRP / claims pre-flag spend more
scenario budget on the tail (Cat 3, Cat 4+) without inflating the
unconditional draws of weaker storms.  P2.5 ships the sampler and the
bucket-frequency table; downstream consumers (P2.6 / P2.7) apply the
Horvitz-Thompson weight ``p_bucket / n_per_bucket`` when computing
IS-corrected expectations like TVaR-99.
"""

from __future__ import annotations


# ── plan-verbatim test ─────────────────────────────────────────────────────


def test_stratified_is_returns_weighted_samples():
    """Plan-mandated structural shape test."""
    from ml.scenarios.importance import stratified_sample

    s = stratified_sample(
        n_per_bucket=10,
        buckets=["tropical", "cat1", "cat2", "cat3", "cat4+"],
    )
    assert len(s) == 50
    assert sum(x["weight"] for x in s) == 50  # uncorrected weights


# ── additional coverage tests ──────────────────────────────────────────────


def test_every_sample_has_unit_weight():
    """Uncorrected weights: each sample carries weight 1.0.

    The IS correction (p_bucket / n_per_bucket) is applied downstream at
    expectation-evaluation time, not baked into the draw.
    """
    from ml.scenarios.importance import stratified_sample

    s = stratified_sample(
        n_per_bucket=7,
        buckets=["tropical", "cat1", "cat2", "cat3", "cat4+"],
    )
    for x in s:
        assert x["weight"] == 1.0


def test_bucket_coverage_is_exact():
    """Every bucket appears exactly n_per_bucket times — that's the
    whole point of stratification."""
    from collections import Counter

    from ml.scenarios.importance import stratified_sample

    buckets = ["tropical", "cat1", "cat2", "cat3", "cat4+"]
    s = stratified_sample(n_per_bucket=8, buckets=buckets)
    counts = Counter(x["bucket"] for x in s)
    for b in buckets:
        assert counts[b] == 8, f"bucket {b} drawn {counts[b]} times, expected 8"


def test_peak_wind_falls_within_bucket_range():
    """Each sample's peak_wind_mph must land inside its bucket's
    Saffir-Simpson wind range."""
    from ml.scenarios.importance import BUCKET_WIND_RANGES, stratified_sample

    s = stratified_sample(
        n_per_bucket=20,
        buckets=list(BUCKET_WIND_RANGES.keys()),
        seed=0,
    )
    for x in s:
        lo, hi = BUCKET_WIND_RANGES[x["bucket"]]
        assert lo <= x["peak_wind_mph"] <= hi, (
            f"{x['bucket']} sample peak_wind_mph={x['peak_wind_mph']} "
            f"out of range [{lo}, {hi}]"
        )


def test_determinism_same_seed_same_draws():
    """``seed`` fully determines the output."""
    from ml.scenarios.importance import stratified_sample

    a = stratified_sample(
        n_per_bucket=5,
        buckets=["tropical", "cat1", "cat2", "cat3", "cat4+"],
        seed=0,
    )
    b = stratified_sample(
        n_per_bucket=5,
        buckets=["tropical", "cat1", "cat2", "cat3", "cat4+"],
        seed=0,
    )
    assert a == b


def test_atlantic_basin_frequencies_sum_to_one():
    """Bucket frequencies are a probability mass over which-category-
    among-landfall-events; they must sum to ~1.0 (typo guard)."""
    from ml.scenarios.importance import ATLANTIC_BASIN_FREQUENCIES

    total = sum(ATLANTIC_BASIN_FREQUENCIES.values())
    assert abs(total - 1.0) < 0.01, (
        f"Atlantic basin frequencies must sum to ~1, got {total}"
    )


def test_generate_scenarios_threads_importance_buckets_metadata():
    """``generate_scenarios`` accepts the IS sample as scenario
    specification and surfaces bucket + weight on every output."""
    from ml.scenarios.generate import generate_scenarios
    from ml.scenarios.importance import stratified_sample

    samples = stratified_sample(
        n_per_bucket=2,
        buckets=["tropical", "cat1", "cat2", "cat3", "cat4+"],
        seed=0,
    )
    scs = generate_scenarios(
        storm_id="AL092024",
        n=len(samples),
        importance_buckets=samples,
    )
    assert len(scs) == len(samples)
    for sc, sample in zip(scs, samples):
        assert sc.get("bucket") == sample["bucket"]
        assert sc.get("weight") == sample["weight"]
