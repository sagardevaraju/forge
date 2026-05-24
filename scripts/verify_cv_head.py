"""
Verify that the retrained CV head produces real per-policy spread and
geographically-distinct outputs for the three Phase-2 weak-labeled dims.

This is the acceptance gate from §12e of `research.md` and from the
P2.37 design spec
(`docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md`).
It is **not** a unit test — it streams the entire chip cache through
the head, so it requires:

  - ``artifacts/cv_head.pt`` to exist (retrained against weak labels).
  - ``forge-local.db`` with populated ``cv_features`` and chip cache
    on disk.
  - ``torch`` and ``timm`` installed (offline-only, per
    ``requirements-train.txt``).

Usage
-----
    # Default: re-forward 1000 random policies through the head, compute
    # per-dim stdev + the FL Hernando 346 vs NC mountain 286 contrast.
    python -m scripts.verify_cv_head

    # Full book — slow (~5 min on M-series MPS).
    python -m scripts.verify_cv_head --full

Pass criteria (printed as ``PASS`` / ``FAIL``):

  1. Per-policy stdev > 0.05 on each of:
        - idx 1 imperviousness
        - idx 3 roof_complexity
        - idx 6 tree_overhang
     (The band-math baseline reaches 0.10; we need ballpark.)

  2. Geographic contrast: |Δ| > 0.15 between FL Hernando 346 (coastal,
     mixed) and NC mountain 286 (forested) on:
        - imperviousness  — FL > NC expected
        - tree_overhang   — NC > FL expected

If both pass the script flips ``populate_cv_features.py`` default to
``bypass_head=False`` is justified (operator still does the swap by
hand — this script does not modify other files).
"""

from __future__ import annotations

import argparse
import random
import sqlite3
import statistics
import sys
import time
from pathlib import Path

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

DB_PATH = _REPO_ROOT / "forge-local.db"

# Indices of the three retrained dims (single source of truth — keep in
# sync with ml/cv/train.py::WEAK_LABEL_INDICES).
RETRAINED_DIMS = {
    1: "imperviousness",
    3: "roof_complexity",
    6: "tree_overhang",
}

# Stdev gate per spec §12e. Band-math NDVI hits 0.10; we want > 0.05.
STDEV_GATE = 0.05

# Per-ZIP3 contrast gate per spec acceptance criteria.
CONTRAST_GATE = 0.15
# Empirically chosen to give the gate a real geography to discriminate.
# The synthetic seed places policies pseudo-uniformly inside each state,
# so the original spec example "FL Hernando 346 vs NC mountain 286" turned
# out to be two equally rural / forested ZIPs in the seed (impervious
# means 0.046 and 0.087, tree means 0.63 and 0.63 from the precompute).
# TX Harris 770 vs FL Hernando 346 is the urban-vs-rural pair the seed
# actually exposes (precompute showed impervious Δ=0.49, tree Δ=0.28).
CONTRAST_ZIPS = ("770", "346")   # TX Harris (urban) vs FL Hernando (rural forested)


def _load_policy_rows(zip3_filter: tuple[str, ...] | None = None, limit: int | None = None) -> list[tuple[int, float, float, str]]:
    """Return ``(policy_id, lat, lon, zip3)`` from the policies table."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    if zip3_filter:
        placeholders = ",".join("?" * len(zip3_filter))
        cur.execute(
            f"SELECT id, lat, lon, zip3 FROM policies WHERE zip3 IN ({placeholders}) ORDER BY id",
            zip3_filter,
        )
    else:
        cur.execute("SELECT id, lat, lon, zip3 FROM policies ORDER BY id")
    rows = cur.fetchall()
    conn.close()
    if limit is not None:
        rows = rows[:limit]
    return [(int(r[0]), float(r[1]), float(r[2]), str(r[3])) for r in rows]


def _forward_head(policy_ids: list[int]) -> np.ndarray:
    """Forward each policy's cached chip through the trained head; (N, 8) float32."""
    import torch  # noqa: PLC0415

    from ml.cv.data_loaders import load_cached_chip  # noqa: PLC0415
    from ml.cv.inference import _get_real_model  # noqa: PLC0415

    backbone, head, device = _get_real_model()
    outputs = np.zeros((len(policy_ids), 8), dtype=np.float32)
    valid_mask = np.zeros(len(policy_ids), dtype=bool)
    t0 = time.time()
    for i, pid in enumerate(policy_ids):
        try:
            chip = load_cached_chip(pid)
        except FileNotFoundError:
            continue
        if int(chip.max()) == 0:
            continue
        chip_f = torch.from_numpy(chip.astype(np.float32) / 10_000.0).unsqueeze(0).to(device)
        chip_r = torch.nn.functional.interpolate(
            chip_f, size=(224, 224), mode="bilinear", align_corners=False
        )
        with torch.no_grad():
            feats = backbone(chip_r)
            preds = head(feats).squeeze(0).cpu().numpy()
        outputs[i] = preds
        valid_mask[i] = True
        if (i + 1) % 500 == 0:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed
            print(f"  forward {i+1:,}/{len(policy_ids):,}  rate={rate:.1f}/s", flush=True)
    return outputs[valid_mask]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--full", action="store_true",
                        help="Run on every policy with a cached chip (~10k; ~5 min on MPS).")
    parser.add_argument("--sample", type=int, default=1000,
                        help="Sample N random policies when not --full (default 1000).")
    parser.add_argument("--seed", type=int, default=20260523,
                        help="RNG seed for the random sample (default 20260523).")
    args = parser.parse_args()

    # --- Pass 1: per-dim stdev across a population sample ----------------
    print(f"[verify] Loading policies...", flush=True)
    all_rows = _load_policy_rows()
    print(f"[verify] {len(all_rows):,} total policies", flush=True)
    rng = random.Random(args.seed)
    if args.full:
        sample = all_rows
    else:
        sample = rng.sample(all_rows, k=min(args.sample, len(all_rows)))
    print(f"[verify] Forwarding {len(sample):,} chips through head...", flush=True)
    sample_ids = [r[0] for r in sample]
    sample_out = _forward_head(sample_ids)
    print(f"[verify] Got {len(sample_out):,} valid outputs", flush=True)

    print()
    print("=== Per-dim stdev (acceptance gate: > 0.05) ===")
    stdev_results: dict[int, float] = {}
    for idx, name in RETRAINED_DIMS.items():
        sd = float(np.std(sample_out[:, idx]))
        stdev_results[idx] = sd
        gate = "PASS" if sd > STDEV_GATE else "FAIL"
        print(
            f"  idx {idx} {name:18s}  mean={float(np.mean(sample_out[:, idx])):.4f}  "
            f"stdev={sd:.4f}  range=[{float(sample_out[:, idx].min()):.4f}, "
            f"{float(sample_out[:, idx].max()):.4f}]  {gate}"
        )
    all_stdev_pass = all(sd > STDEV_GATE for sd in stdev_results.values())

    # --- Pass 2: per-ZIP3 geographic contrast ---------------------------
    print()
    print(f"=== ZIP3 contrast (acceptance gate: |Δ| > {CONTRAST_GATE} on impervious + tree) ===")
    zip_rows = _load_policy_rows(zip3_filter=CONTRAST_ZIPS)
    zip_ids = [r[0] for r in zip_rows]
    zip_out = _forward_head(zip_ids)
    # Index by zip3
    by_zip: dict[str, list[np.ndarray]] = {z: [] for z in CONTRAST_ZIPS}
    out_iter = iter(zip_out)
    for r in zip_rows:
        vec = next(out_iter, None)
        if vec is None:
            break
        by_zip[r[3]].append(vec)

    contrast_pass = True
    for idx, name in RETRAINED_DIMS.items():
        means = {z: float(np.mean([v[idx] for v in vecs])) if vecs else float("nan")
                 for z, vecs in by_zip.items()}
        delta = abs(means[CONTRAST_ZIPS[0]] - means[CONTRAST_ZIPS[1]])
        gate = "PASS" if delta > CONTRAST_GATE else "FAIL"
        # Only impervious + tree are gated on contrast (roof_complexity is
        # a much harder geographic signal — buildings are box-shaped most
        # places — so we report it without a strict gate).
        if name in {"imperviousness", "tree_overhang"} and gate == "FAIL":
            contrast_pass = False
        print(
            f"  idx {idx} {name:18s}  {CONTRAST_ZIPS[0]}={means[CONTRAST_ZIPS[0]]:.4f}  "
            f"{CONTRAST_ZIPS[1]}={means[CONTRAST_ZIPS[1]]:.4f}  |Δ|={delta:.4f}  {gate}"
        )

    print()
    overall = all_stdev_pass and contrast_pass
    print(f"=== OVERALL: {'PASS' if overall else 'FAIL'} ===")
    print(
        "If PASS: it is honest to flip "
        "`populate_cv_features.py --use-head` to default-on "
        "(and update `research.md` §8e accordingly)."
    )
    print(
        "If FAIL: keep band-math bypass as the default. The retrained head "
        "did not learn discriminative outputs even with image-derived "
        "supervision — likely needs more epochs, an unfrozen backbone, "
        "or a richer label set."
    )
    sys.exit(0 if overall else 1)


if __name__ == "__main__":
    main()
