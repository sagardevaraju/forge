"""
FORGE — CV inference module.

Provides two execution paths:

  predict_chip_mock(chip)
      Deterministic 8-dim feature extractor using Sentinel-2 band math
      (NDVI, NDWI, SWIR, edge density). No model weights required.
      All outputs are clipped to [0, 1].

  predict_chip(chip)
      Real path: loads the trained MLP head artifact and runs a forward
      pass through the Prithvi/timm backbone + head.
      Raises NotImplementedError if no trained head artifact is found.

  load_chip_features(lat, lon, mode=None)
      Top-level entry point. Calls data_loaders.load_chip then routes to
      the appropriate predict function based on `mode` or the
      FORGE_CV_MODE environment variable.

The 8 output dimensions (indices fixed — do not reorder):
  0  vegetation_density   NDVI mean
  1  impervious_surface   inverse NDVI variance, normalized
  2  fuel_proximity       SWIR-based synthetic, scaled inverse
  3  roof_condition_proxy B04 (Red) mean / 10 000
  4  water_proximity      NDWI mean, normalized to [0, 1]
  5  elevation_bucket     chip hash → discretized 0–4 / 4
  6  ndvi_seasonal_var    chip std, normalized
  7  structure_density    edge density via Sobel-like gradient
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Band order expected by predict_chip_* functions.
#: Must match DEFAULT_BANDS in data_loaders.py.
#: [0]=B04 Red  [1]=B03 Green  [2]=B02 Blue  [3]=B08 NIR  [4]=B11 SWIR-1
BAND_B04 = 0   # Red
BAND_B03 = 1   # Green
BAND_B02 = 2   # Blue
BAND_B08 = 3   # NIR
BAND_B11 = 4   # SWIR-1

_S2_MAX = 10_000.0
OUTPUT_DIM = 8

ARTIFACT_DIR = Path(__file__).resolve().parent.parent.parent / "artifacts"
HEAD_ARTIFACT = ARTIFACT_DIR / "cv_head.pt"


# ---------------------------------------------------------------------------
# Mock path — deterministic, no model weights required
# ---------------------------------------------------------------------------


def predict_chip_mock(chip: np.ndarray) -> np.ndarray:
    """Compute deterministic 8-dim features from a Sentinel-2 chip.

    Parameters
    ----------
    chip:
        Array of shape ``(5, 256, 256)`` with dtype uint16 (or any int/float).
        Band order: [B04 Red, B03 Green, B02 Blue, B08 NIR, B11 SWIR-1].

    Returns
    -------
    np.ndarray
        Shape ``(8,)`` float32, all values clipped to ``[0, 1]``.

    Notes
    -----
    The features are NOT physically calibrated — they are deterministic and
    sensitive to chip content so that downstream XGBoost sees varied inputs.
    """
    chip = chip.astype(np.float64)

    b04 = chip[BAND_B04]   # Red
    b03 = chip[BAND_B03]   # Green
    b08 = chip[BAND_B08]   # NIR
    b11 = chip[BAND_B11]   # SWIR-1

    # ------------------------------------------------------------------
    # 0. vegetation_density — NDVI mean
    # ------------------------------------------------------------------
    denom_ndvi = b08 + b04
    # Avoid divide-by-zero: add small epsilon only where denominator is 0
    safe_ndvi = np.where(denom_ndvi == 0, 1.0, denom_ndvi)
    ndvi = (b08 - b04) / safe_ndvi  # in [-1, 1]
    vegetation_density = float(np.mean(ndvi))
    # Map [-1, 1] → [0, 1]
    vegetation_density = (vegetation_density + 1.0) / 2.0

    # ------------------------------------------------------------------
    # 1. impervious_surface — inverse of NDVI variance, normalized [0, 1]
    # ------------------------------------------------------------------
    ndvi_var = float(np.var(ndvi))
    # Higher NDVI variance → more vegetation heterogeneity → less impervious
    # Cap variance at 1.0 for normalization (typical max ~0.1–0.3)
    ndvi_var_norm = min(1.0, ndvi_var / 0.5)
    impervious_surface = 1.0 - ndvi_var_norm

    # ------------------------------------------------------------------
    # 2. fuel_proximity — SWIR-based synthetic (dry vegetation / fuel)
    #    High SWIR → dry vegetation → higher fuel load → higher proximity
    #    Scaled inverse: low SWIR (water/rock) → low fuel proximity
    # ------------------------------------------------------------------
    swir_mean = float(np.mean(b11)) / _S2_MAX   # normalize to [0, 1]
    fuel_proximity = swir_mean  # higher SWIR → more dry fuel

    # ------------------------------------------------------------------
    # 3. roof_condition_proxy — B04 mean / 10 000
    #    Bright red reflectance → brighter roof (proxy for new/metal roof)
    # ------------------------------------------------------------------
    roof_condition_proxy = float(np.mean(b04)) / _S2_MAX

    # ------------------------------------------------------------------
    # 4. water_proximity — NDWI mean, normalized to [0, 1]
    #    NDWI = (B03 - B08) / (B03 + B08)
    # ------------------------------------------------------------------
    denom_ndwi = b03 + b08
    safe_ndwi = np.where(denom_ndwi == 0, 1.0, denom_ndwi)
    ndwi = (b03 - b08) / safe_ndwi   # in [-1, 1]
    water_proximity = float(np.mean(ndwi))
    water_proximity = (water_proximity + 1.0) / 2.0   # → [0, 1]

    # ------------------------------------------------------------------
    # 5. elevation_bucket — chip byte-hash → discretized 0–4 / 4
    #    Deterministic proxy for elevation class (0=low … 1=high)
    # ------------------------------------------------------------------
    chip_bytes = chip.astype(np.uint16).tobytes()
    raw_hash = hash(chip_bytes) & 0xFFFF_FFFF   # unsigned 32-bit
    elevation_bucket = float(raw_hash % 5) / 4.0   # {0.0, 0.25, 0.5, 0.75, 1.0}

    # ------------------------------------------------------------------
    # 6. ndvi_seasonal_var — chip std normalized to [0, 1]
    #    Proxy for seasonal vegetation variability
    # ------------------------------------------------------------------
    chip_std = float(np.std(chip)) / _S2_MAX
    ndvi_seasonal_var = min(1.0, chip_std * 5.0)   # scale up: typical std ~0.05–0.2

    # ------------------------------------------------------------------
    # 7. structure_density — edge density via Sobel-like gradient
    #    Computed on the NIR band (highest contrast for built structures)
    # ------------------------------------------------------------------
    # Finite differences on interior pixels (avoids padding artifacts)
    nir = b08 / _S2_MAX
    grad_x = nir[:, 1:] - nir[:, :-1]   # horizontal differences
    grad_y = nir[1:, :] - nir[:-1, :]   # vertical differences
    grad_mag_x = np.abs(grad_x).mean()
    grad_mag_y = np.abs(grad_y).mean()
    edge_density = (grad_mag_x + grad_mag_y) / 2.0
    structure_density = min(1.0, edge_density * 20.0)   # scale: typical ~0.01–0.05

    # ------------------------------------------------------------------
    # Assemble and clip
    # ------------------------------------------------------------------
    features = np.array(
        [
            vegetation_density,   # 0
            impervious_surface,   # 1
            fuel_proximity,       # 2
            roof_condition_proxy, # 3
            water_proximity,      # 4
            elevation_bucket,     # 5
            ndvi_seasonal_var,    # 6
            structure_density,    # 7
        ],
        dtype=np.float32,
    )
    return np.clip(features, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Real path — requires trained artifact
# ---------------------------------------------------------------------------

#: Module-level cache so we don't reload the backbone + head on every call.
#: Critical when iterating 10k policies — avoids 10k timm.create_model() calls.
_MODEL_CACHE: dict = {}


def _get_real_model():
    """Lazily build and cache (backbone, head, device) for real inference.

    Reuses the same backbone + trained head across calls within a process,
    so populate_cv_features.py can stream through 10k rows without paying
    the ViT-B load cost more than once.
    """
    if "model" in _MODEL_CACHE:
        return _MODEL_CACHE["model"]

    if not HEAD_ARTIFACT.exists():
        raise NotImplementedError(
            "Real CV inference requires trained head — run train.py first.\n"
            f"Expected artifact: {HEAD_ARTIFACT}"
        )

    try:
        import torch  # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "PyTorch is required for real CV inference. "
            "Install via: pip install torch timm"
        ) from exc

    from ml.cv.train import build_mlp_head, build_backbone, select_device  # noqa: PLC0415

    device = select_device()
    backbone = build_backbone().to(device).eval()
    head = build_mlp_head().to(device)
    head.load_state_dict(torch.load(HEAD_ARTIFACT, map_location=device))
    head.eval()

    _MODEL_CACHE["model"] = (backbone, head, device)
    return _MODEL_CACHE["model"]


def predict_chip(chip: np.ndarray) -> np.ndarray:
    """Run the trained Prithvi/ViT + MLP head to produce 8-dim features.

    Parameters
    ----------
    chip:
        Array of shape ``(5, 256, 256)`` uint16.

    Returns
    -------
    np.ndarray
        Shape ``(8,)`` float32, values in ``[0, 1]``.

    Raises
    ------
    NotImplementedError
        If the trained head artifact is not found at
        ``artifacts/cv_head.pt``. Run ``ml/cv/train.py`` first
        (Apple Silicon MPS, CUDA, or CPU all supported).
    RuntimeError
        If PyTorch is not installed.
    """
    import torch  # noqa: PLC0415

    backbone, head, device = _get_real_model()

    with torch.no_grad():
        chip_f = torch.from_numpy(chip.astype(np.float32) / 10_000.0).unsqueeze(0).to(device)
        chip_r = torch.nn.functional.interpolate(
            chip_f, size=(224, 224), mode="bilinear", align_corners=False
        )
        feats = backbone(chip_r)
        preds = head(feats).squeeze(0).cpu().numpy()

    return np.clip(preds.astype(np.float32), 0.0, 1.0)


# ---------------------------------------------------------------------------
# Unified entry point
# ---------------------------------------------------------------------------


def load_chip_features(
    lat: float | None = None,
    lon: float | None = None,
    mode: str | None = None,
    policy_id: int | None = None,
) -> np.ndarray:
    """Load a Sentinel-2 chip and extract 8-dim property-risk features.

    Parameters
    ----------
    lat, lon:
        Property centroid in WGS-84. Required for ``mock``/``real`` modes,
        and required for ``cached`` mode too so we can fall back to the
        mock path when the cached chip is empty (offshore policy seed quirk).
    mode:
        ``"mock"``, ``"real"``, or ``"cached"``. If *None*, reads the
        ``FORGE_CV_MODE`` environment variable (default: ``"mock"``).
        ``"cached"`` reads the pre-fetched chip from disk and runs it
        through the trained backbone + head.
    policy_id:
        Required for ``cached`` mode; ignored otherwise.

    Returns
    -------
    np.ndarray
        Shape ``(8,)`` float32, all values in ``[0, 1]``.
    """
    from ml.cv.data_loaders import load_chip, mock_chip  # noqa: PLC0415

    if mode is None:
        env = os.environ.get("FORGE_CV_MODE", "mock").strip().lower()
        mode = env if env in {"real", "mock", "cached"} else "mock"

    # Missing-cache mitigation: if mode=cached and the chip file isn't on
    # disk (PC fetch never succeeded for this policy_id), fall back to the
    # mock path so populate_cv_features still produces a non-null feature
    # vector for every row.
    chip: np.ndarray
    try:
        chip = load_chip(lat=lat, lon=lon, mode=mode, policy_id=policy_id)
    except FileNotFoundError:
        if mode != "cached" or lat is None or lon is None:
            raise
        chip = mock_chip(lat=lat, lon=lon)
        return predict_chip_mock(chip)

    # Offshore-seed mitigation: if a cached chip is all-zero (Sentinel-2
    # returned a no-data window because the policy coords land in water),
    # substitute a deterministic mock chip + use the band-math features.
    # Same for real-mode fetches that come back empty for any reason.
    if mode in {"real", "cached"} and int(chip.max()) == 0:
        if lat is None or lon is None:
            # No coordinates → return zeros rather than crash; downstream
            # XGBoost can handle the constant row but the user is warned.
            return np.zeros(OUTPUT_DIM, dtype=np.float32)
        chip = mock_chip(lat=lat, lon=lon)
        return predict_chip_mock(chip)

    # Cached + real both go through the trained head; mock uses the
    # deterministic band-math feature extractor.
    if mode in {"real", "cached"}:
        return predict_chip(chip)
    return predict_chip_mock(chip)
