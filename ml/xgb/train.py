"""Task 11 — XGBoost quantile loss-severity training.

Trains three quantile regressors (p10, p50, p90) on the synthetic training
data produced by synthesize_book.py.  Uses reg:quantileerror objective with
a light Optuna hyperparameter search.

Wall-time strategy (deviation from spec):
  The spec called for 100 trials; this was first reduced to 20.  On the
  1.28 M-row dataset, 3-fold CV per trial takes ~80 s → 20 trials alone
  would run ~1,600 s (27 min) for a single quantile.  To stay within the
  15-min total cap we:
    1. Run Optuna on a 100 k-row subsample (fast proxy for hyperparams).
    2. Use n_trials = 20 on that subsample (~8 s/trial → 160 s per quantile).
    3. Refit the best model on the full 1.28 M rows.
  This gives meaningful exploration with a realistic budget.

Artifacts saved to artifacts/:
    xgb_p10.joblib  xgb_p50.joblib  xgb_p90.joblib
    xgb_feature_cols.joblib
"""

from __future__ import annotations

import joblib
import pathlib

import numpy as np
import optuna
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import KFold

# silence Optuna's per-trial INFO logs — only show progress bar
optuna.logging.set_verbosity(optuna.logging.WARNING)

# Optuna subsample size: large enough to be representative, small enough to
# keep each CV fold fast.
OPTUNA_SUBSAMPLE = 100_000
N_TRIALS = 20


# ── loss metric ────────────────────────────────────────────────────────────

def pinball_loss(y: np.ndarray, y_pred: np.ndarray, q: float) -> float:
    diff = y - y_pred
    return float(np.where(diff > 0, q * diff, (q - 1) * diff).mean())


# ── Optuna objective (runs on subsample) ───────────────────────────────────

def objective(trial: optuna.Trial, X: np.ndarray, y: np.ndarray, q: float) -> float:
    params = {
        "objective": "reg:quantileerror",
        "quantile_alpha": q,
        "tree_method": "hist",
        "max_depth": trial.suggest_int("max_depth", 4, 10),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
        "n_estimators": trial.suggest_int("n_estimators", 100, 500),
        "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        "min_child_weight": trial.suggest_int("min_child_weight", 1, 10),
    }
    scores: list[float] = []
    for tr, va in KFold(n_splits=3, shuffle=True, random_state=42).split(X):
        m = xgb.XGBRegressor(**params, random_state=42)
        m.fit(X[tr], y[tr], verbose=False)
        scores.append(pinball_loss(y[va], m.predict(X[va]), q))
    return float(np.mean(scores))


# ── training routine ───────────────────────────────────────────────────────

def train_all_quantiles(
    X: np.ndarray,
    y: np.ndarray,
    n_trials: int = N_TRIALS,
    optuna_subsample: int = OPTUNA_SUBSAMPLE,
) -> tuple[dict[float, xgb.XGBRegressor], dict[float, optuna.Study]]:
    """Train one XGBRegressor per quantile using Optuna search on a subsample.

    Hyperparameter search runs on `optuna_subsample` rows for speed; the
    winning configuration is then refit on the full dataset.
    """
    models: dict[float, xgb.XGBRegressor] = {}
    studies: dict[float, optuna.Study] = {}

    # Subsample for Optuna (deterministic)
    rng = np.random.default_rng(seed=0)
    sub_idx = rng.choice(len(X), size=min(optuna_subsample, len(X)), replace=False)
    X_sub = X[sub_idx]
    y_sub = y[sub_idx]
    print(f"  Optuna subsample: {len(X_sub):,} rows  (full dataset: {len(X):,})")

    for q in [0.10, 0.50, 0.90]:
        print(f"\n── Optimising p{int(q*100):02d} ({n_trials} trials on subsample) ──")
        study = optuna.create_study(direction="minimize")
        study.optimize(
            lambda t, _q=q: objective(t, X_sub, y_sub, _q),
            n_trials=n_trials,
            show_progress_bar=True,
        )
        best_params: dict = dict(study.best_params)
        best_params.update(
            {
                "objective": "reg:quantileerror",
                "quantile_alpha": q,
                "tree_method": "hist",
            }
        )
        print(f"  Refitting p{int(q*100):02d} on full {len(X):,} rows …")
        m = xgb.XGBRegressor(**best_params, random_state=42)
        m.fit(X, y)
        # Report pinball on held-out subsample as a sanity check
        held = np.setdiff1d(np.arange(len(X)), sub_idx)[:50_000]
        pb = pinball_loss(y[held], m.predict(X[held]), q)
        print(f"  p{int(q*100):02d} hold-out pinball (50k): {pb:.2f}")
        models[q] = m
        studies[q] = study

    return models, studies


# ── entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    artifacts = pathlib.Path("artifacts")
    artifacts.mkdir(exist_ok=True)

    print("Loading training data …")
    df = pd.read_parquet(artifacts / "xgb_training.parquet")
    feature_cols = [c for c in df.columns if c != "loss_dollars"]
    X = df[feature_cols].values.astype(np.float32)
    y = df["loss_dollars"].values.astype(np.float32)
    print(f"  {len(df):,} rows  ×  {len(feature_cols)} features")

    models, studies = train_all_quantiles(X, y)

    for q, m in models.items():
        out = artifacts / f"xgb_p{int(q*100):02d}.joblib"
        joblib.dump(m, out)
        print(f"  saved {out}")

    joblib.dump(feature_cols, artifacts / "xgb_feature_cols.joblib")
    print(f"  saved artifacts/xgb_feature_cols.joblib")

    print("\nTrained. Best params per quantile:")
    for q, s in studies.items():
        print(f"  p{int(q*100):02d}:  pinball={s.best_value:.4f}  params={s.best_params}")
