"""
FORGE — CV training pipeline: Prithvi/Clay backbone + 4-layer MLP head.

NOTE: Run on Apple Silicon (MPS), CUDA GPU, or CPU. ``select_device()``
picks the fastest available backend automatically. Not executed in the
autonomous build session — the head artifact is created by a real
training run before any non-mock inference works.

On Apple Silicon, set ``PYTORCH_ENABLE_MPS_FALLBACK=1`` so any operator
the MPS backend doesn't yet implement falls back to CPU instead of
raising.

This file documents the real training workflow. The heavy backbone weights
(Prithvi-100M or Clay) must be downloaded before running. Imports of
torch, timm, and transformers are guarded so the file is parseable in
environments where those packages are not installed.

=============================================================================
Setup (offline workstation)
=============================================================================

    pip install torch torchvision timm transformers datasets
    # If using Prithvi via HuggingFace:
    #   huggingface-cli download ibm-nasa-geospatial/Prithvi-100M
    #   OR set HF_HUB_CACHE to your model cache directory

=============================================================================
Architecture
=============================================================================

  Input : (B, 5, 256, 256) uint16 Sentinel-2 chip
         bands = [B04 Red, B03 Green, B02 Blue, B08 NIR, B11 SWIR-1]
         Normalized to [0, 1] by dividing by 10 000.

  Backbone : Prithvi-100M (ViT-based geospatial FM) or timm ViT-B/16
             Frozen during the initial training phase (fine-tune optional).
             Output: (B, backbone_dim) — e.g. 768 for ViT-B.

  MLP Head : 4 fully-connected layers
             backbone_dim → 512 → 256 → 128 → 8
             Each hidden layer: Linear → LayerNorm → GELU → Dropout(0.1)
             Final layer: Linear → Sigmoid (to keep outputs in [0, 1])

  Output : (B, 8) float32 — the 8 property-risk feature dimensions:
           [vegetation_density, impervious_surface, fuel_proximity,
            roof_condition_proxy, water_proximity, elevation_bucket,
            ndvi_seasonal_var, structure_density]

=============================================================================
Weak supervision labels
=============================================================================

  Labels are derived from the policy book using domain heuristics:
    - vegetation_density_label  ← flood_zone + elevation_m percentile
    - impervious_surface_label  ← build_type (wood_frame → mid, masonry → hi)
    - water_proximity_label     ← flood_zone (VE→1, AE→0.8, A→0.5, X→0.1)
    ...
  Loss: MSE (pixel-level regression on all 8 dims simultaneously).
  Val split: 10 % holdout. Target val MAE < 0.15 per dim.

=============================================================================
Usage
=============================================================================

    # Apple Silicon (MacBook M-series) — MPS backend, ~10-20x faster than CPU
    export PYTORCH_ENABLE_MPS_FALLBACK=1
    export FORGE_CV_MODE=mock          # use mock chips during dev
    python ml/cv/train.py --epochs 20 --lr 1e-4 --batch-size 32

    # NVIDIA workstation — CUDA picked automatically
    python ml/cv/train.py --epochs 20 --lr 1e-4 --batch-size 32 --device cuda

    # CPU-only fallback (slow but works anywhere)
    python ml/cv/train.py --epochs 20 --lr 1e-4 --batch-size 16 --device cpu

    # Then to cache real features:
    export FORGE_CV_MODE=real
    python scripts/populate_cv_features.py --mode real

=============================================================================
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np

# Ensure the repo root is on sys.path when this file is invoked as a script
# (`python ml/cv/train.py ...`). Without this, the in-function imports of
# `ml.cv.data_loaders` fail because `ml` isn't a top-level package on the
# default path.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# ---------------------------------------------------------------------------
# Guard heavy imports — not available in this autonomous session
# ---------------------------------------------------------------------------
try:
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, Dataset
    _TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    _TORCH_AVAILABLE = False

try:
    import timm  # noqa: F401
    _TIMM_AVAILABLE = True
except ImportError:  # pragma: no cover
    _TIMM_AVAILABLE = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DB_PATH = Path(__file__).resolve().parent.parent.parent / "forge-local.db"
ARTIFACT_DIR = Path(__file__).resolve().parent.parent.parent / "artifacts"
HEAD_ARTIFACT = ARTIFACT_DIR / "cv_head.pt"

S2_MAX = 10_000.0
BACKBONE_DIM = 768        # ViT-B/16 and Prithvi-100M output dim
OUTPUT_DIM = 8
DROPOUT = 0.1


# ---------------------------------------------------------------------------
# Device selection
# ---------------------------------------------------------------------------

def select_device(prefer: str | None = None) -> str:
    """Pick the fastest available PyTorch backend.

    Priority: ``prefer`` (if given) > MPS (Apple Silicon) > CUDA > CPU.

    On Apple Silicon, set ``PYTORCH_ENABLE_MPS_FALLBACK=1`` so any operator
    the MPS backend doesn't yet implement falls back to CPU.
    """
    if prefer:
        return prefer
    if not _TORCH_AVAILABLE:
        return "cpu"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


# ---------------------------------------------------------------------------
# Model definition
# ---------------------------------------------------------------------------

def build_mlp_head() -> "nn.Module":  # noqa: F821
    """Return the 4-layer MLP head that maps backbone_dim → 8 dims.

    Layer layout (documented):
        Linear(768 → 512) → LayerNorm(512) → GELU → Dropout(0.1)
        Linear(512 → 256) → LayerNorm(256) → GELU → Dropout(0.1)
        Linear(256 → 128) → LayerNorm(128) → GELU → Dropout(0.1)
        Linear(128 → 8)   → Sigmoid
    """
    if not _TORCH_AVAILABLE:
        raise RuntimeError(
            "PyTorch is required to build the MLP head. "
            "Install via: pip install torch"
        )

    import torch.nn as nn  # noqa: PLC0415

    return nn.Sequential(
        nn.Linear(BACKBONE_DIM, 512),
        nn.LayerNorm(512),
        nn.GELU(),
        nn.Dropout(DROPOUT),

        nn.Linear(512, 256),
        nn.LayerNorm(256),
        nn.GELU(),
        nn.Dropout(DROPOUT),

        nn.Linear(256, 128),
        nn.LayerNorm(128),
        nn.GELU(),
        nn.Dropout(DROPOUT),

        nn.Linear(128, OUTPUT_DIM),
        nn.Sigmoid(),
    )


def build_backbone(backbone: str = "vit_base_patch16_224"):
    """Load Prithvi or a timm ViT backbone and freeze all parameters.

    Parameters
    ----------
    backbone:
        timm model name or ``"prithvi"`` to load IBM/NASA Prithvi-100M via
        HuggingFace transformers.

    Returns
    -------
    nn.Module
        Backbone with all parameters frozen and eval mode set.
    """
    if not _TORCH_AVAILABLE or not _TIMM_AVAILABLE:
        raise RuntimeError(
            "PyTorch + timm are required for the backbone. "
            "Install via: pip install torch timm"
        )

    import timm  # noqa: PLC0415

    if backbone == "prithvi":
        # Prithvi-100M via HuggingFace transformers (geospatial ViT)
        # Requires:  pip install transformers
        # Weights:   huggingface-cli download ibm-nasa-geospatial/Prithvi-100M
        from transformers import AutoModel  # noqa: PLC0415
        model = AutoModel.from_pretrained(
            "ibm-nasa-geospatial/Prithvi-100M",
            trust_remote_code=True,
        )
        # Prithvi outputs (B, num_patches, dim) — mean-pool the patch tokens
        model._forge_pool = True
    else:
        # timm ViT — works with 5-channel input by adapting patch embedding
        model = timm.create_model(
            backbone,
            pretrained=True,
            in_chans=5,           # 5 Sentinel-2 bands
            num_classes=0,        # drop classifier head → returns (B, dim)
        )
        model._forge_pool = False

    # Freeze all backbone parameters
    for p in model.parameters():
        p.requires_grad_(False)

    model.eval()
    return model


class PolicyChipDataset:
    """Minimal Dataset wrapping (id, lat, lon) rows from policies.

    When __getitem__ is called it:
      1. Loads the chip via ``data_loaders.load_chip`` — routed by ``mode``:
           - ``"cached"`` (preferred for training): reads pre-fetched chip
             from ``artifacts/chips/<id // 100>/<id>.npy`` (no network).
           - ``"mock"``: deterministic synthetic chip from lat/lon seed.
           - ``"real"``: live Planetary Computer fetch (~3-5 s/row — only
             use this for one-off lookups, never for an epoch loop).
      2. Normalises uint16 → float32 in [0, 1].
      3. Returns (chip_tensor, label_tensor, policy_id).

    When ``mode == "cached"`` the constructor pre-scans every cached chip
    and drops policies whose chip is all-zero or missing. These are policies
    the synthetic policy book placed offshore (state=NC at FL-centred lat/lon
    seeds), where Sentinel-2 returns a no-data window. Filtering them keeps
    the head's training signal clean; their cv_features are filled at
    inference time via the mock path (see :func:`load_chip_features`).

    Weak labels are derived from policy-book columns via ``_derive_labels``.
    """

    def __init__(self, rows: list, mode: str = "cached"):
        self.mode = mode
        if mode == "cached":
            self.rows, dropped = _filter_empty_cached(rows)
            if dropped:
                print(
                    f"[PolicyChipDataset] mode=cached: dropped {len(dropped)} "
                    f"policies with empty/missing chips (offshore seed quirk)."
                )
        else:
            self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int):
        if not _TORCH_AVAILABLE:
            raise RuntimeError("PyTorch is required to use the dataset.")

        import torch  # noqa: PLC0415
        from ml.cv.data_loaders import load_chip  # noqa: PLC0415

        policy_id, lat, lon, flood_zone, build_type, elevation_m = self.rows[idx]
        if self.mode == "cached":
            chip = load_chip(mode="cached", policy_id=policy_id)
        else:
            chip = load_chip(lat=lat, lon=lon, mode=self.mode)
        chip_f = torch.from_numpy(chip.astype(np.float32) / S2_MAX)

        # Weak labels from policy metadata
        labels = _derive_labels(flood_zone, build_type, elevation_m)
        return chip_f, labels, policy_id


def _filter_empty_cached(rows: list) -> tuple[list, list[int]]:
    """Drop rows whose cached chip is all-zero or missing.

    Returns ``(kept_rows, dropped_policy_ids)``. Reads each .npy via mmap so
    a 10k-policy scan takes ~5-10 s on M-series — comfortable one-time cost.
    """
    from ml.cv.data_loaders import chip_path  # noqa: PLC0415

    kept: list = []
    dropped: list[int] = []
    for row in rows:
        policy_id = row[0]
        path = chip_path(policy_id)
        if not path.exists():
            dropped.append(policy_id)
            continue
        try:
            chip = np.load(path, mmap_mode="r")
            if int(chip.max()) == 0:
                dropped.append(policy_id)
                continue
        except Exception:  # noqa: BLE001
            # Corrupt .npy (e.g., from an interrupted write) — skip and let
            # cache_s2_chips.py --retry-failed clean it up.
            dropped.append(policy_id)
            continue
        kept.append(row)
    return kept, dropped


def _derive_labels(
    flood_zone: str,
    build_type: str,
    elevation_m: float,
) -> "torch.Tensor":  # noqa: F821
    """Derive 8-dim weak supervision labels from policy columns.

    Returns a float32 tensor of shape (8,) with values in [0, 1].

    Mapping (heuristic, not physically calibrated):
      0  vegetation_density   ← inverse of impervious proxy
      1  impervious_surface   ← build_type: masonry=0.7, wood=0.5, mfr=0.3
      2  fuel_proximity       ← inverse of flood_zone severity
      3  roof_condition_proxy ← random-ish from build_type
      4  water_proximity      ← flood_zone: VE=1, AE=0.8, A=0.5, X=0.1
      5  elevation_bucket     ← clamp(elevation_m / 6, 0, 1)
      6  ndvi_seasonal_var    ← 0.5 (unknown at training time)
      7  structure_density    ← impervious proxy
    """
    import torch  # noqa: PLC0415

    zone_water = {"VE": 1.0, "AE": 0.8, "A": 0.5, "X": 0.1}.get(flood_zone, 0.5)
    impervious = {"masonry": 0.7, "wood_frame": 0.5, "manufactured": 0.3}.get(build_type, 0.5)
    elev = min(1.0, max(0.0, float(elevation_m) / 6.0))

    v = [
        1.0 - impervious,   # vegetation_density
        impervious,          # impervious_surface
        1.0 - zone_water,   # fuel_proximity (drier → more fuel)
        impervious * 0.8,   # roof_condition_proxy
        zone_water,          # water_proximity
        elev,                # elevation_bucket
        0.5,                 # ndvi_seasonal_var (unknown)
        impervious,          # structure_density
    ]
    return torch.tensor(v, dtype=torch.float32)


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------

def train(
    epochs: int = 20,
    lr: float = 1e-4,
    batch_size: int = 32,
    backbone: str = "vit_base_patch16_224",
    mode: str = "cached",
    val_split: float = 0.1,
    device: str | None = None,
    num_workers: int = 0,
) -> None:
    """Train the MLP head on top of the frozen backbone.

    Steps:
      1. Load all (id, lat, lon, flood_zone, build_type, elevation_m) rows.
      2. Build backbone + head → ForgeCV model.
      3. Train for ``epochs`` using MSELoss + AdamW.
      4. Report val MAE after each epoch.
      5. Save head weights to ``artifacts/cv_head.pt``.

    NOTE: Not executed in this autonomous session (needs GPU + model weights).
    """
    if not _TORCH_AVAILABLE:
        raise RuntimeError(
            "PyTorch is required for training. "
            "Run this on a GPU workstation: pip install torch timm transformers"
        )

    import torch  # noqa: PLC0415
    import torch.nn as nn  # noqa: PLC0415
    from torch.utils.data import DataLoader, random_split  # noqa: PLC0415

    device = select_device(device)
    print(f"[train] Using device: {device}")

    # Load policy rows
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "SELECT id, lat, lon, flood_zone, build_type, elevation_m FROM policies"
    )
    rows = cur.fetchall()
    conn.close()
    print(f"[train] Loaded {len(rows):,} policy rows")

    # Build dataset
    dataset = PolicyChipDataset(rows, mode=mode)
    n_val = int(len(dataset) * val_split)
    n_train = len(dataset) - n_val
    train_ds, val_ds = random_split(dataset, [n_train, n_val])

    # num_workers=0 by default on macOS — DataLoader worker processes
    # interact poorly with MPS + Python 3.12 + fork semantics. Override
    # via --num-workers if you've confirmed it works on your machine.
    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=num_workers)
    val_dl = DataLoader(val_ds, batch_size=batch_size, shuffle=False, num_workers=num_workers)

    # Build model
    backbone_model = build_backbone(backbone).to(device)
    head = build_mlp_head().to(device)
    optimizer = torch.optim.AdamW(head.parameters(), lr=lr, weight_decay=1e-4)
    criterion = nn.MSELoss()

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

    best_val_mae = float("inf")

    for epoch in range(1, epochs + 1):
        # ---- Train phase ----
        head.train()
        train_loss = 0.0
        for chips, labels, _ in train_dl:
            chips = chips.to(device)
            labels = labels.to(device)

            with torch.no_grad():
                # Backbone inference: may need resize to 224x224 for ViT-B
                if backbone != "prithvi":
                    chips_resized = torch.nn.functional.interpolate(
                        chips, size=(224, 224), mode="bilinear", align_corners=False
                    )
                    feats = backbone_model(chips_resized)
                else:
                    feats = backbone_model(chips).last_hidden_state.mean(dim=1)

            preds = head(feats)
            loss = criterion(preds, labels)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * chips.size(0)

        # ---- Val phase ----
        head.eval()
        val_mae = 0.0
        with torch.no_grad():
            for chips, labels, _ in val_dl:
                chips = chips.to(device)
                labels = labels.to(device)
                if backbone != "prithvi":
                    chips = torch.nn.functional.interpolate(
                        chips, size=(224, 224), mode="bilinear", align_corners=False
                    )
                    feats = backbone_model(chips)
                else:
                    feats = backbone_model(chips).last_hidden_state.mean(dim=1)
                preds = head(feats)
                val_mae += (preds - labels).abs().mean().item() * chips.size(0)

        val_mae /= n_val
        train_loss /= n_train
        print(f"Epoch {epoch:02d}/{epochs} — train_loss={train_loss:.4f}  val_mae={val_mae:.4f}")

        if val_mae < best_val_mae:
            best_val_mae = val_mae
            torch.save(head.state_dict(), HEAD_ARTIFACT)
            print(f"  [checkpoint] val_mae improved → saved to {HEAD_ARTIFACT}")

    print(f"\nTraining complete. Best val MAE: {best_val_mae:.4f}")
    print(f"Head artifact: {HEAD_ARTIFACT}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train FORGE CV MLP head")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument(
        "--backbone",
        type=str,
        default="vit_base_patch16_224",
        help='timm model name or "prithvi" for IBM/NASA Prithvi-100M',
    )
    parser.add_argument(
        "--mode",
        type=str,
        default="cached",
        choices=["cached", "mock", "real"],
        help=(
            "Chip loading mode (default: cached). 'cached' reads pre-fetched "
            "chips from artifacts/chips/; 'mock' generates deterministic "
            "synthetic chips; 'real' hits Planetary Computer per __getitem__ "
            "(do NOT use in a training loop)."
        ),
    )
    parser.add_argument("--device", type=str, default=None)
    parser.add_argument(
        "--num-workers",
        type=int,
        default=0,
        help="DataLoader workers (default 0 — macOS+MPS safe).",
    )
    args = parser.parse_args()

    train(
        epochs=args.epochs,
        lr=args.lr,
        batch_size=args.batch_size,
        backbone=args.backbone,
        mode=args.mode,
        device=args.device,
        num_workers=args.num_workers,
    )
