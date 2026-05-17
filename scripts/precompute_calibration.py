"""Task P2.2 — precompute reliability + PIT histogram data for /calibration view.

Writes ``artifacts/calibration.json`` consumed by the P2.16 calibration
view. The schema is deliberately minimal:

    {
      "schema_version": 1,
      "generated_at": ISO-8601,
      "data_source": "live" | "synthetic_demo",
      "reliability": {"p10": [...], "p50": [...], "p90": [...]},
      "pit": {"scenario_generator": {n_bins, counts, data_source, note}}
    }

Each ``reliability`` entry is a list of ``reliability_curve`` outputs
(``{forecast_prob, observed_freq, forecast_value_mid, n}`` dicts).

**Honesty contract**: when the trained XGB joblibs are not on disk we
fall back to a synthetic lognormal evaluation set drawn from the same
``_cohort_loss_quantiles`` prior used by the Portfolio MIP (Task P2.0),
flagging ``data_source = "synthetic_demo"`` so the front-end can render a
"demo data" badge. Real PIT samples from the scenario generator land in
P2.10 (HURDAT2 cross-validation) and P2.38 (NHC ensemble swap); until
then the PIT histogram is a uniform placeholder seeded with
``np.random.default_rng(42)``.

Re-run any time the XGB heads or scenario generator change:
    python -m scripts.precompute_calibration
"""

# Output: ``artifacts/calibration.json`` — tracked in git on the same convention
# as ``artifacts/portfolio_optimization.json`` (the ``/calibration`` view reads
# the file at request time; we do not re-run the precompute in serverless).
# Re-run after changing the synthetic seed, swapping in live eval (P2.10/P2.38),
# or extending the schema.

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

# Make ``api_py`` importable when this script is run as ``python -m`` or directly.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api_py.calibration import pit_histogram, reliability_curve  # noqa: E402

# Φ⁻¹ at p10/p50/p90 — matches the inverse-CDF values used to derive the
# Portfolio MIP's lognormal scenarios (see precompute_portfolio_optimization).
PHI_INV: dict[float, float] = {
    0.1: -1.2816,
    0.5: 0.0,
    0.9: 1.2816,
}
PHI_INV_99 = 2.326  # for the p99 anchor of the lognormal prior

ARTIFACTS_DIR = ROOT / "artifacts"
XGB_PATHS: dict[float, Path] = {
    0.1: ARTIFACTS_DIR / "xgb_p10.joblib",
    0.5: ARTIFACTS_DIR / "xgb_p50.joblib",
    0.9: ARTIFACTS_DIR / "xgb_p90.joblib",
}


def _synthetic_eval_set(rng: np.random.Generator, n: int = 600) -> dict:
    """Draw ``n`` synthetic (forecast, observation) pairs per quantile head.

    Uses the same lognormal posterior as the Portfolio MIP's
    ``_cohort_loss_quantiles``: ``median = p50``, ``p99 = 4 × p50``, so
    ``σ = log(4) / Φ⁻¹(0.99) ≈ 0.596``. Each draw samples a cohort-scale
    ``p50`` (uniform $10k–$10M annual expected loss), reconstructs the
    underlying normal, then for each quantile head emits:

        forecast_q = exp(μ + Φ⁻¹(q) · σ)
        observation = exp(μ + Z · σ),  Z ~ N(0, 1)

    Returns a dict keyed by quantile probability, each value a dict with
    ``forecasts`` and ``observations`` arrays. The observations are the
    SAME random draw across heads — i.e. each row is one realised loss
    paired with its three predicted quantiles. This is the right joint
    structure for downstream reliability scoring.
    """
    sigma = math.log(4.0) / PHI_INV_99
    p50_scale = rng.uniform(1e4, 1e7, size=n)
    mu = np.log(p50_scale)
    # One realised standard-normal per cohort, shared across heads.
    z = rng.normal(size=n)
    observations = np.exp(mu + z * sigma)
    out: dict[float, dict[str, np.ndarray]] = {}
    for q, phi in PHI_INV.items():
        forecasts = np.exp(mu + phi * sigma)
        out[q] = {"forecasts": forecasts, "observations": observations}
    return out


def main() -> None:
    # No live eval-set today: paired (forecast, observation) data lands in
    # P2.10 (HURDAT2 cross-validation) and P2.38 (NHC ensemble swap). Until
    # then the artifact is honest synthetic_demo. Seed the synthetic eval set
    # deterministically so the artifact is byte-identical across runs on the
    # same machine.
    rng = np.random.default_rng(42)
    eval_set = _synthetic_eval_set(rng)

    reliability: dict[str, list[dict]] = {}
    for q, label in ((0.1, "p10"), (0.5, "p50"), (0.9, "p90")):
        head = eval_set[q]
        pairs = reliability_curve(
            forecasts=head["forecasts"],
            observations=head["observations"],
            target_prob=q,
            n_bins=10,
        )
        reliability[label] = pairs

    # Real PIT samples will come from HURDAT2 (P2.10) and the NHC ensemble
    # swap (P2.38). Until then, a seeded uniform draw is the honest
    # placeholder: it shows the front-end what a *perfectly* calibrated
    # generator looks like.
    pit_rng = np.random.default_rng(42)
    pit_samples = pit_rng.uniform(0.0, 1.0, size=1000)
    pit_counts = pit_histogram(pit_samples, n_bins=10)

    payload = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_source": "synthetic_demo",
        "reliability": reliability,
        "pit": {
            "scenario_generator": {
                "n_bins": 10,
                "counts": pit_counts,
                "data_source": "synthetic_placeholder",
                "note": (
                    "Real PIT samples land in P2.10 (HURDAT2) and P2.38 "
                    "(NHC ensemble swap)."
                ),
            }
        },
    }

    ARTIFACTS_DIR.mkdir(exist_ok=True)
    out_path = ARTIFACTS_DIR / "calibration.json"
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    size = os.path.getsize(out_path)
    print(f"Wrote {out_path.relative_to(ROOT)}  ({size:,} bytes)")
    print("  data_source: synthetic_demo")
    for label, pairs in reliability.items():
        print(f"  reliability/{label}: {len(pairs)} bins")
    print(f"  pit/scenario_generator: {sum(pit_counts)} samples in {len(pit_counts)} bins")


if __name__ == "__main__":
    main()
