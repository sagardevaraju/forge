"""Task 24 — component-level evaluation for FORGE.

Produces ``eval/results/component_metrics.json`` with three blocks:

1. ``cv_head``       per-feature-dim MAE of the **mock** CV head against
                     weak-label proxies derived from the policy book
                     itself.  This is a sanity check on the mock head's
                     variability, not a real-model metric.  Real CV head
                     training is deferred.

2. ``xgb_loss_model`` MAE / RMSE / CRPS-proxy for the trained XGBoost p50
                     model on the last 10 % of ``artifacts/xgb_training.parquet``
                     (rows the trainer never saw under the 90/10 spec).

3. ``scenario_loglik`` mean log-likelihood of FORGE's scenario distribution
                     against the top-5 holdout 2024-2025 storm events
                     (event state + peak-wind bucket as the realised
                     observation; storm_events doesn't carry full track
                     data).

Any block that can't be computed because of missing artifacts (e.g. an
XGBoost model file isn't present) is filled with ``null`` and a
``"error"`` string so the JSON is always well-formed.
"""

from __future__ import annotations

import json
import math
import sqlite3
import traceback
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "forge-local.db"
ARTIFACTS = ROOT / "artifacts"
RESULTS_DIR = Path(__file__).resolve().parent / "results"
OUT_JSON = RESULTS_DIR / "component_metrics.json"


# ---------------------------------------------------------------------------
# 1. CV head sanity check
# ---------------------------------------------------------------------------

# Indices of the 8-dim CV feature vector (mirrors ml/cv/inference.py docstring).
CV_DIM_NAMES = [
    "vegetation_density",   # 0
    "impervious_surface",   # 1
    "fuel_proximity",       # 2
    "roof_condition_proxy", # 3
    "water_proximity",      # 4
    "elevation_bucket",     # 5
    "ndvi_seasonal_var",    # 6
    "structure_density",    # 7
]

# Weak proxy: map flood-zone code to a "water proximity" prior.
_FLOOD_ZONE_WATER = {"VE": 0.9, "AE": 0.7, "A": 0.4, "X": 0.1}


def _weak_labels(flood_zone: str | None, elevation_m: float | None) -> np.ndarray:
    """Return a length-8 weak proxy label vector for one policy.

    Only dims with a defensible proxy are populated; the rest are set to
    NaN and skipped in the MAE aggregation.  This is intentional — the
    purpose is to confirm the mock CV head produces non-degenerate
    *variability* in the dimensions where we have a prior, not to claim
    we have real ground truth for all 8 dims.
    """
    labels = np.full(8, np.nan, dtype=np.float64)
    if flood_zone and flood_zone in _FLOOD_ZONE_WATER:
        labels[4] = _FLOOD_ZONE_WATER[flood_zone]   # water_proximity
    if elevation_m is not None and not math.isnan(float(elevation_m)):
        # elevation_bucket proxy: clip elevation_m / 10 into [0, 1].
        labels[5] = max(0.0, min(1.0, float(elevation_m) / 10.0))
        # vegetation_density loose proxy: higher elevation slightly
        # implies more vegetation (away from sandy coast/urban core).
        labels[0] = max(0.0, min(1.0, float(elevation_m) / 20.0))
    return labels


def compute_cv_head_block(*, sample_n: int = 500) -> dict[str, Any]:
    """Run the mock CV head over a sample of policies and compute per-dim MAE."""
    try:
        from ml.cv.data_loaders import mock_chip
        from ml.cv.inference import predict_chip_mock
    except Exception as exc:   # pragma: no cover — defensive
        return {
            "error": f"failed to import CV modules: {exc}",
            "per_dim_mae": None,
            "context": (
                "Real CV head training is deferred; this block evaluates the "
                "mock CV head's outputs against weak-label proxies (flood "
                "zone -> water_proximity, elevation_m -> elevation_bucket / "
                "vegetation_density).  It is a sanity check on the mock "
                "head's variability, NOT a real-model evaluation."
            ),
        }

    if not DB_PATH.exists():
        return {
            "error": f"db not found: {DB_PATH}",
            "per_dim_mae": None,
        }

    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT lat, lon, flood_zone, elevation_m FROM policies "
            "WHERE lat IS NOT NULL AND lon IS NOT NULL "
            "ORDER BY id LIMIT ?",
            (sample_n,),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        return {
            "error": "no policies returned from DB",
            "per_dim_mae": None,
        }

    # Accumulate absolute errors per dim, ignoring NaN labels.
    abs_err_sum = np.zeros(8, dtype=np.float64)
    abs_err_n = np.zeros(8, dtype=np.int64)

    pred_sum = np.zeros(8, dtype=np.float64)
    pred_sq_sum = np.zeros(8, dtype=np.float64)

    for lat, lon, fz, elev in rows:
        chip = mock_chip(float(lat), float(lon))
        pred = predict_chip_mock(chip).astype(np.float64)
        labels = _weak_labels(fz, elev)
        pred_sum += pred
        pred_sq_sum += pred * pred
        for i in range(8):
            if not np.isnan(labels[i]):
                abs_err_sum[i] += abs(pred[i] - labels[i])
                abs_err_n[i] += 1

    n = len(rows)
    per_dim_mae: dict[str, float | None] = {}
    per_dim_pred_mean: dict[str, float] = {}
    per_dim_pred_std: dict[str, float] = {}
    for i, name in enumerate(CV_DIM_NAMES):
        per_dim_mae[name] = (
            float(abs_err_sum[i] / abs_err_n[i]) if abs_err_n[i] > 0 else None
        )
        mean = pred_sum[i] / n
        var = max(0.0, pred_sq_sum[i] / n - mean * mean)
        per_dim_pred_mean[name] = float(mean)
        per_dim_pred_std[name] = float(math.sqrt(var))

    return {
        "context": (
            "Real CV head training is deferred; this block evaluates the "
            "mock CV head's outputs against weak-label proxies derived "
            "from the policy book itself (flood_zone -> water_proximity, "
            "elevation_m -> elevation_bucket / vegetation_density).  Dims "
            "without a defensible proxy report null MAE.  This is a "
            "sanity check on the mock head's variability, not a "
            "real-model evaluation."
        ),
        "sample_n": n,
        "per_dim_mae": per_dim_mae,
        "per_dim_pred_mean": per_dim_pred_mean,
        "per_dim_pred_std": per_dim_pred_std,
    }


# ---------------------------------------------------------------------------
# 2. XGBoost p50 MAE / RMSE / CRPS-proxy on a 10% holdout slice
# ---------------------------------------------------------------------------


def _pinball_loss(y: np.ndarray, yhat: np.ndarray, q: float) -> float:
    diff = y - yhat
    return float(np.where(diff > 0, q * diff, (q - 1) * diff).mean())


def compute_xgb_block() -> dict[str, Any]:
    try:
        import joblib
        import pandas as pd
    except Exception as exc:   # pragma: no cover — defensive
        return {"error": f"failed to import pandas/joblib: {exc}"}

    parquet = ARTIFACTS / "xgb_training.parquet"
    feat_cols_path = ARTIFACTS / "xgb_feature_cols.joblib"
    p10_path = ARTIFACTS / "xgb_p10.joblib"
    p50_path = ARTIFACTS / "xgb_p50.joblib"
    p90_path = ARTIFACTS / "xgb_p90.joblib"

    for p in (parquet, feat_cols_path, p50_path):
        if not p.exists():
            return {"error": f"missing artifact: {p.name}"}

    df = pd.read_parquet(parquet)
    feature_cols = joblib.load(feat_cols_path)
    # 90/10 train/holdout split — last 10% of the parquet as written.
    n = len(df)
    split = int(n * 0.9)
    holdout = df.iloc[split:].reset_index(drop=True)
    X = holdout[feature_cols].values.astype(np.float32)
    y = holdout["loss_dollars"].values.astype(np.float64)

    p50_model = joblib.load(p50_path)
    yhat50 = np.asarray(p50_model.predict(X), dtype=np.float64)

    mae = float(np.mean(np.abs(yhat50 - y)))
    rmse = float(math.sqrt(np.mean((yhat50 - y) ** 2)))

    # CRPS-proxy via averaged pinball over (p10, p50, p90), with the
    # scaling described in the spec.  If either tail model is missing,
    # report null for that part.
    crps_proxy: float | None = None
    pinball_components: dict[str, float | None] = {
        "p10": None, "p50": float(_pinball_loss(y, yhat50, 0.5)), "p90": None,
    }
    if p10_path.exists() and p90_path.exists():
        try:
            m10 = joblib.load(p10_path)
            m90 = joblib.load(p90_path)
            yhat10 = np.asarray(m10.predict(X), dtype=np.float64)
            yhat90 = np.asarray(m90.predict(X), dtype=np.float64)
            pb10 = _pinball_loss(y, yhat10, 0.1)
            pb50 = pinball_components["p50"]
            pb90 = _pinball_loss(y, yhat90, 0.9)
            pinball_components = {"p10": float(pb10), "p50": float(pb50), "p90": float(pb90)}
            # Spec: 0.5 * (pinball(0.1) + pinball(0.5) + pinball(0.9)) * 2 / 3
            crps_proxy = 0.5 * (pb10 + pb50 + pb90) * 2.0 / 3.0
        except Exception as exc:
            pinball_components["p10"] = pinball_components["p10"] or None
            pinball_components["p90"] = pinball_components["p90"] or None
            crps_proxy = None
            return {
                "error": f"tail model load/predict failed: {exc}",
                "holdout_size": int(len(holdout)),
                "mae": mae,
                "rmse": rmse,
                "pinball": pinball_components,
                "crps_proxy": crps_proxy,
                "context": (
                    "CRPS is approximated as 0.5 * (pinball(0.1) + "
                    "pinball(0.5) + pinball(0.9)) * 2 / 3 — a rough proxy "
                    "for the true CRPS that would require a finer "
                    "quantile grid."
                ),
            }

    return {
        "holdout_size": int(len(holdout)),
        "train_size": int(split),
        "mae": mae,
        "rmse": rmse,
        "pinball": pinball_components,
        "crps_proxy": crps_proxy,
        "context": (
            "CRPS is approximated as 0.5 * (pinball(0.1) + pinball(0.5) + "
            "pinball(0.9)) * 2 / 3 — a rough proxy for the true CRPS that "
            "would require a finer quantile grid.  Holdout is the last "
            "10% of the training parquet, which the trainer reserved "
            "(rows 0..split-1 were used for Optuna + refit)."
        ),
    }


# ---------------------------------------------------------------------------
# 3. Scenario log-likelihood vs. holdout 2024-2025 storm events
# ---------------------------------------------------------------------------

# Coarse mapping from event_type to a realized-wind point estimate (mph).
_REALIZED_WIND_BY_TYPE = {
    "Hurricane (Typhoon)": 120.0,
    "Hurricane": 120.0,
    "Tropical Storm": 70.0,
    "Tropical Depression": 40.0,
}


# Map FL ZIP3 prefix -> state (the scenario generator's coastal ZIP3
# catalog is FL-heavy plus a handful of GA/SC/AL/MS/LA points).
_ZIP3_STATE = {
    "335": "FL", "337": "FL", "339": "FL", "341": "FL", "342": "FL",
    "344": "FL", "346": "FL", "320": "FL", "325": "FL", "326": "FL",
    "314": "GA", "294": "SC",
    "365": "AL", "395": "MS", "704": "LA",
}


def _which_state_bucket(scenario: dict) -> str | None:
    """Pick the ZIP3 with the highest surge in this scenario, map to state."""
    surge_grid = scenario.get("surge_grid", {})
    if not surge_grid:
        return None
    z3 = max(surge_grid.items(), key=lambda kv: kv[1])[0]
    return _ZIP3_STATE.get(z3)


def compute_scenario_loglik_block(*, n_scenarios: int = 1000, n_events: int = 5) -> dict[str, Any]:
    try:
        from ml.scenarios.generate import generate_scenarios
    except Exception as exc:   # pragma: no cover — defensive
        return {"error": f"failed to import scenarios.generate: {exc}"}

    if not DB_PATH.exists():
        return {"error": f"db not found: {DB_PATH}"}

    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT event_id, year, state, event_type, peak_wind, damage_property "
            "FROM storm_events "
            "WHERE (year = 2024 OR year = 2025) "
            "  AND damage_property IS NOT NULL "
            "ORDER BY damage_property DESC "
            "LIMIT ?",
            (n_events,),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        return {"error": "no 2024-2025 events found"}

    # Floor for log-prob to avoid log(0) when the realised bucket has
    # zero coverage in our scenario set.  1 / (10 * n_scenarios) is the
    # equivalent of a single-count Laplace smoother.
    floor = 1.0 / (10.0 * n_scenarios)

    event_results: list[dict[str, Any]] = []
    logliks: list[float] = []

    for event_id, year, state, event_type, peak_wind_db, damage in rows:
        realized_wind = (
            float(peak_wind_db)
            if peak_wind_db is not None
            else _REALIZED_WIND_BY_TYPE.get(event_type, 70.0)
        )

        try:
            scenarios = generate_scenarios(f"holdout_{event_id}", n=n_scenarios)
        except Exception as exc:
            event_results.append({
                "event_id": event_id,
                "year": year,
                "state": state,
                "event_type": event_type,
                "realized_peak_wind_mph": realized_wind,
                "loglik": None,
                "error": f"scenario gen failed: {exc}",
            })
            continue

        # P(state matches AND scenario peak_wind within ±10 mph of realized)
        matches = 0
        for sc in scenarios:
            sc_state = _which_state_bucket(sc)
            if sc_state != state:
                continue
            if abs(float(sc["peak_wind"]) - realized_wind) <= 10.0:
                matches += 1

        p = matches / n_scenarios
        p_smoothed = max(floor, p)
        loglik = math.log(p_smoothed)
        logliks.append(loglik)

        event_results.append({
            "event_id": event_id,
            "year": int(year),
            "state": state,
            "event_type": event_type,
            "realized_peak_wind_mph": realized_wind,
            "damage_property": float(damage) if damage is not None else None,
            "match_count": matches,
            "match_prob": p,
            "loglik": loglik,
        })

    mean_loglik = float(np.mean(logliks)) if logliks else None
    return {
        "context": (
            "storm_events does not carry full track data — realised "
            "observation is approximated as (state, peak-wind bucket "
            "within ±10 mph).  Realised peak wind defaults to a "
            "per-event-type mean when the NOAA MAGNITUDE column is "
            "null (the 2024 set is entirely null in this DB).  "
            "Probabilities are Laplace-smoothed to a floor of "
            "1/(10*n) so log-likelihood is always finite."
        ),
        "n_scenarios": n_scenarios,
        "n_events": len(event_results),
        "mean_loglik": mean_loglik,
        "events": event_results,
    }


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> dict[str, Any]:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    print("[component] computing CV head sanity metrics …")
    try:
        cv_block = compute_cv_head_block()
    except Exception:   # pragma: no cover — defensive
        cv_block = {"error": traceback.format_exc(), "per_dim_mae": None}
    print(f"  per_dim_mae keys: "
          f"{list((cv_block.get('per_dim_mae') or {}).keys())}")

    print("[component] computing XGBoost holdout metrics …")
    try:
        xgb_block = compute_xgb_block()
    except Exception:   # pragma: no cover — defensive
        xgb_block = {"error": traceback.format_exc()}
    if "error" in xgb_block:
        print(f"  XGB block error: {xgb_block['error']}")
    else:
        print(f"  holdout_size={xgb_block.get('holdout_size')}  "
              f"MAE={xgb_block.get('mae'):.2f}  "
              f"RMSE={xgb_block.get('rmse'):.2f}  "
              f"CRPS-proxy={xgb_block.get('crps_proxy')}")

    print("[component] computing scenario log-likelihood …")
    try:
        scen_block = compute_scenario_loglik_block()
    except Exception:   # pragma: no cover — defensive
        scen_block = {"error": traceback.format_exc()}
    if "error" in scen_block:
        print(f"  scenario block error: {scen_block['error']}")
    else:
        print(f"  mean_loglik={scen_block.get('mean_loglik')}  "
              f"n_events={scen_block.get('n_events')}")

    payload = {
        "cv_head": cv_block,
        "xgb_loss_model": xgb_block,
        "scenario_loglik": scen_block,
    }
    OUT_JSON.write_text(json.dumps(payload, indent=2, default=float))
    print(f"[component] wrote {OUT_JSON}")
    return payload


if __name__ == "__main__":
    main()
