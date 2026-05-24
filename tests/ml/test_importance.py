"""Task P2.5 — stratified importance sampling on Saffir-Simpson buckets.

Importance sampling lets the MIP / VRP / claims pre-flag spend more
scenario budget on the tail (Cat 3, Cat 4+) without inflating the
unconditional draws of weaker storms.  P2.5 ships the sampler and the
bucket-frequency table; downstream consumers (P2.6 / P2.7) apply the
Horvitz-Thompson weight ``p_bucket / n_per_bucket`` when computing
IS-corrected expectations like TVaR-99.
"""

from __future__ import annotations

import pytest


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


# ── AUDIT.4 — HURDAT2 fit replacing the P2.5 literal placeholder ──────────


class TestFitBasinFrequenciesFromHurdat2:
    """``fit_basin_frequencies_from_hurdat2`` reads the cached parquet
    and produces a unit-sum distribution over Saffir-Simpson buckets.
    The fit replaces the original P2.5 literals which were documented
    as order-of-magnitude placeholders."""

    @staticmethod
    def _synth_parquet(tmp_path, max_winds_kts):
        """Build a synthetic HURDAT2-shape parquet with the given
        per-landfall ``max_wind_kts`` values."""
        import pandas as pd

        df = pd.DataFrame(
            {
                "storm_id": [f"AL{i:02d}2024" for i in range(len(max_winds_kts))],
                "name": ["TEST"] * len(max_winds_kts),
                "timestamp": pd.date_range("2024-01-01", periods=len(max_winds_kts), freq="h"),
                "lat": [25.0] * len(max_winds_kts),
                "lon": [-80.0] * len(max_winds_kts),
                "max_wind_kts": max_winds_kts,
                "system_status": ["HU"] * len(max_winds_kts),
                "record_identifier": ["L"] * len(max_winds_kts),
            }
        )
        path = tmp_path / "best_track_synth.parquet"
        df.to_parquet(path, index=False)
        return path

    def test_unit_sum_on_synthetic_parquet(self, tmp_path):
        from ml.scenarios.importance import fit_basin_frequencies_from_hurdat2

        # Five landfalls, one per bucket.  In knots: 50 (TS), 70 (cat1),
        # 90 (cat2), 105 (cat3), 130 (cat4+).
        path = self._synth_parquet(tmp_path, [50, 70, 90, 105, 130])
        result = fit_basin_frequencies_from_hurdat2(path)
        assert abs(sum(result.values()) - 1.0) < 1e-9
        # Each bucket has exactly 1/5 of the mass.
        for bucket in ("tropical", "cat1", "cat2", "cat3", "cat4+"):
            assert result[bucket] == 0.2

    def test_bucket_membership_matches_mph_cutpoints(self, tmp_path):
        """Cat1 starts at 74 mph = 64.3 kts; verify the boundary."""
        from ml.scenarios.importance import fit_basin_frequencies_from_hurdat2

        # 65 kts ≈ 74.8 mph → cat1.  64 kts ≈ 73.6 mph → still tropical.
        path = self._synth_parquet(tmp_path, [64, 65])
        result = fit_basin_frequencies_from_hurdat2(path)
        assert result["tropical"] == 0.5
        assert result["cat1"] == 0.5

    def test_missing_parquet_raises_file_not_found(self, tmp_path):
        from ml.scenarios.importance import fit_basin_frequencies_from_hurdat2

        with pytest.raises(FileNotFoundError):
            fit_basin_frequencies_from_hurdat2(tmp_path / "missing.parquet")

    def test_empty_landfall_set_raises_value_error(self, tmp_path):
        """Parquet with rows but no landfall flags → refuse rather than
        emit a zero distribution (silent failure mode)."""
        import pandas as pd

        from ml.scenarios.importance import fit_basin_frequencies_from_hurdat2

        df = pd.DataFrame(
            {
                "storm_id": ["AL012024"],
                "name": ["TEST"],
                "timestamp": pd.to_datetime(["2024-01-01"]),
                "lat": [25.0],
                "lon": [-80.0],
                "max_wind_kts": [100.0],
                "system_status": ["HU"],
                "record_identifier": [""],  # not a landfall flag
            }
        )
        path = tmp_path / "no_landfalls.parquet"
        df.to_parquet(path, index=False)
        with pytest.raises(ValueError, match="zero landfall rows"):
            fit_basin_frequencies_from_hurdat2(path)


class TestAtlanticBasinFrequenciesAreLiveFit:
    """The module-level constant should reflect the HURDAT2 fit, not
    the original placeholder literals — assuming the parquet ships in
    the repo (which it does)."""

    def test_cat4_plus_share_exceeds_pre_fit_placeholder(self):
        """The original P2.5 literal was cat4+=0.05; HURDAT2 1851-2024
        landfall counts put it materially higher.  Pin a lower bound
        rather than the exact value so the test survives a HURDAT2
        re-download with newer data."""
        from ml.scenarios.importance import ATLANTIC_BASIN_FREQUENCIES, _LITERAL_DEFAULTS

        pre_fit_cat4 = _LITERAL_DEFAULTS["cat4+"]
        assert ATLANTIC_BASIN_FREQUENCIES["cat4+"] > pre_fit_cat4, (
            f"Expected HURDAT2-fit cat4+ > {pre_fit_cat4} (pre-fit placeholder); "
            f"got {ATLANTIC_BASIN_FREQUENCIES['cat4+']}.  Either the parquet "
            "isn't loading (fallback active) or the fit is broken."
        )

    def test_every_bucket_non_negative(self):
        from ml.scenarios.importance import ATLANTIC_BASIN_FREQUENCIES

        for bucket, freq in ATLANTIC_BASIN_FREQUENCIES.items():
            assert freq >= 0.0, f"{bucket} frequency is negative: {freq}"

    def test_no_bucket_dominates_pathologically(self):
        """No single bucket should hold > 0.6 of the mass — that would
        signal a bucketing bug or a unit-conversion mishap."""
        from ml.scenarios.importance import ATLANTIC_BASIN_FREQUENCIES

        for bucket, freq in ATLANTIC_BASIN_FREQUENCIES.items():
            assert freq < 0.6, f"{bucket} dominates: {freq}"


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
