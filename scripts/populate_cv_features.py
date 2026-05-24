"""
Batch-populate cv_features for all 10k policies in forge-local.db.

Usage
-----
    # Default: cached chips + band-math for 5 dims + ESA WC / MS Buildings
    # weak labels for idx 1, 3, 6 (Phase 2 / Task P2.37).
    python scripts/populate_cv_features.py

    # Forward chips through the trained MLP head instead of band-math
    # (only useful for head-vs-baseline regression — current head does
    # not preserve the per-ZIP geographic contrast embedded in the weak
    # labels, so this is opt-in).
    python scripts/populate_cv_features.py --use-head

    # Hit Planetary Computer live (slow; not recommended for the full 10k)
    python scripts/populate_cv_features.py --mode real

The script:
  1. Reads all (id, lat, lon) rows from policies.
  2. For each policy, calls load_chip_features(...) to get an 8-dim vector.
  3. If artifacts/cv_weak_labels.parquet exists AND --no-weak-labels is
     NOT passed, OVERLAYS the parquet values at idx 1 (imperviousness),
     idx 3 (roof_complexity), and idx 6 (tree_overhang). Other dims keep
     their band-math values.
  4. Writes the merged 8-dim vector as a JSON-stringified array to the
     cv_features column via: UPDATE policies SET cv_features = ? WHERE id = ?.
  5. Prints progress every 1000 policies.

The script is idempotent — running it again overwrites existing values.
Offshore-seed policies (cached chip = all-zero) auto-fall-back to the
mock feature extractor inside load_chip_features so all 10k rows end up
with deterministic non-null features.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import sqlite3
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths — ensure the repo root is on sys.path so `ml` is importable whether
# this script is run directly (python scripts/populate_cv_features.py) or
# via `python -m scripts.populate_cv_features`.
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

DB_PATH = _REPO_ROOT / "forge-local.db"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "--mode",
        type=str,
        default=None,
        choices=["mock", "real", "cached"],
        help=(
            "Feature extraction path. Default: $FORGE_CV_MODE or 'cached'. "
            "'cached' requires artifacts/cv_head.pt and a populated chips dir. "
            "'mock' is REFUSED unless --allow-mock is also passed because "
            "mock_chip() emits uniform-random uint16 noise and the resulting "
            "band-math features collapse to the same five asymptotic means "
            "for every policy — not Sentinel-2 observations."
        ),
    )
    parser.add_argument(
        "--allow-mock",
        action="store_true",
        help=(
            "Explicitly opt in to mock-mode population. The values written "
            "are deterministic band-math statistics over uniform noise, NOT "
            "real CV features — use only for offline training pipelines that "
            "need a non-null cv_features column to exercise downstream code. "
            "Never run this against a DB whose drill-down UI a reviewer will "
            "see: the panel renders the values as if they were real readings."
        ),
    )
    parser.add_argument(
        "--use-head",
        action="store_true",
        help=(
            "Forward chips through the trained MLP head (artifacts/cv_head.pt) "
            "instead of the default band-math path. Phase 2 / Task P2.37 "
            "retrained the head against image-derived weak labels (ESA "
            "WorldCover + MS Building Footprints) for idx 1, 3, 6, but the "
            "frozen ViT-B backbone compresses the per-ZIP geographic contrast "
            "from the labels (per-ZIP head Δ ~ 0.02 vs label Δ ~ 0.4 on "
            "imperviousness across TX 770 / FL 346 — see "
            "scripts/verify_cv_head.py output). So the current default is to "
            "use band-math for the 5 already-modeled dims AND overlay the "
            "label parquet directly for idx 1, 3, 6 — strictly better than "
            "the head's compressed outputs until the head learns to preserve "
            "the contrast (more epochs / unfrozen backbone / land-cover-aware "
            "backbone like Prithvi-100M). Pass --use-head for head-vs-baseline "
            "regression only."
        ),
    )
    parser.add_argument(
        "--no-weak-labels",
        action="store_true",
        help=(
            "Skip the ESA WorldCover + MS Buildings overlay at idx 1, 3, 6 "
            "and keep band-math placeholders for those dims. Use for "
            "regression comparison against the Phase-1 cv_features."
        ),
    )
    args = parser.parse_args()

    # Default mode upgraded from 'mock' to 'cached' so the documented
    # workflow refuses to silently write noise-derived features. Operators
    # who genuinely want mock-mode (training-pipeline smoke tests) must
    # pass --mode mock --allow-mock.
    mode = args.mode or os.environ.get("FORGE_CV_MODE", "cached").strip().lower()
    if mode not in {"mock", "real", "cached"}:
        mode = "cached"

    if mode == "mock" and not args.allow_mock:
        print(
            "[populate_cv_features] REFUSED: --mode mock without --allow-mock.\n"
            "  mock_chip() emits uniform-random uint16 noise per band, so the\n"
            "  resulting NDVI / NDWI / SWIR / edge-density features collapse\n"
            "  to the same five asymptotic means for every policy:\n"
            "    vegetation_density ≈ 0.50  (NDVI of noise ≈ 0)\n"
            "    fuel_proximity     ≈ 0.50  (SWIR mean of uniform[0,10000])\n"
            "    water_proximity    ≈ 0.50  (NDWI of noise ≈ 0)\n"
            "    elevation_bucket   ≈ 0.50  (hash mod 5 uniform on {0,…,1})\n"
            "    structure_density  ≈ 1.00  (edge density of noise saturates)\n"
            "  These are NOT Sentinel-2 observations and must not be displayed.\n"
            "  Re-run with --mode {cached,real} against real chips, or pass\n"
            "  --allow-mock if this is a training-pipeline smoke test.",
        )
        raise SystemExit(2)

    # Bypass the trained head by default. With --use-head we forward through
    # artifacts/cv_head.pt; without it we run band-math directly on the chip
    # (real or mock). See `--use-head` help text for why this is the default.
    bypass_head = not args.use_head

    extractor = "band-math (NDVI/NDWI/SWIR/edges)" if bypass_head else "trained MLP head"
    print(f"[populate_cv_features] mode={mode}  extractor={extractor}  db={DB_PATH}")
    if mode == "mock":
        print(
            "[populate_cv_features] WARNING: mock-mode writes features\n"
            "  derived from uniform-noise chips. Do not surface the result\n"
            "  in the UI without a `cv_features_source='mock'` downgrade.",
        )
    if not bypass_head:
        print(
            "[populate_cv_features] NOTE: --use-head forwards chips through\n"
            "  artifacts/cv_head.pt. The shipped head was trained against\n"
            "  policy-metadata-derived weak labels (not image-derived), so\n"
            "  outputs are near-constant across the book. See `--use-head`\n"
            "  help text for details.",
        )

    # Import here (after path setup) to keep the script runnable from any cwd
    from ml.cv.inference import load_chip_features  # noqa: PLC0415

    # Load the P2.37 weak-label parquet once. Keyed by policy_id; overlay
    # at idx 1 / 3 / 6 — same indices as ml/cv/train.py::WEAK_LABEL_INDICES.
    weak_labels: dict[int, tuple[float, float, float]] = {}
    if not args.no_weak_labels:
        parquet_path = _REPO_ROOT / "artifacts" / "cv_weak_labels.parquet"
        if parquet_path.exists():
            import pyarrow.parquet as pq  # noqa: PLC0415

            t = pq.read_table(parquet_path).to_pandas()
            for _, r in t.iterrows():
                weak_labels[int(r["policy_id"])] = (
                    float(r["imperviousness"]),
                    float(r["roof_complexity"]),
                    float(r["tree_overhang"]),
                )
            print(
                f"[populate_cv_features] Loaded {len(weak_labels):,} ESA WC + MS "
                f"Buildings weak-label rows from {parquet_path.name} (overlay "
                f"at idx 1, 3, 6)."
            )
        else:
            print(
                f"[populate_cv_features] WARNING: {parquet_path.name} not found — "
                "Phase-1 band-math placeholders will be written at idx 1, 3, 6. "
                "Run scripts/precompute_cv_weak_labels.py to populate the parquet."
            )

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Fetch all policies (lat/lon needed for offshore-seed mock fallback)
    cur.execute("SELECT id, lat, lon FROM policies ORDER BY id")
    rows = cur.fetchall()
    total = len(rows)
    print(f"[populate_cv_features] Processing {total:,} policies...")

    updates: list[tuple[str, int]] = []
    failed = 0

    for i, (policy_id, lat, lon) in enumerate(rows, start=1):
        try:
            feats = load_chip_features(
                lat=lat, lon=lon, mode=mode, policy_id=policy_id,
                bypass_head=bypass_head,
            )
            # Overlay weak labels at idx 1, 3, 6 if present.
            wl = weak_labels.get(policy_id)
            if wl is not None:
                feats = feats.copy()
                feats[1] = wl[0]  # imperviousness
                feats[3] = wl[1]  # roof_complexity
                feats[6] = wl[2]  # tree_overhang
            # Serialize as compact JSON array, rounded to 6 decimal places
            cv_json = json.dumps([round(float(v), 6) for v in feats])
            updates.append((cv_json, policy_id))
        except Exception as exc:  # noqa: BLE001
            # Log and continue — don't abort the entire batch for one failure
            print(f"  [WARN] policy {policy_id} failed: {exc}")
            failed += 1

        if i % 1000 == 0:
            # Flush to DB every 1000 rows to avoid holding all updates in RAM
            conn.executemany(
                "UPDATE policies SET cv_features = ? WHERE id = ?",
                updates,
            )
            conn.commit()
            pct = 100.0 * i / total
            print(f"  {i:,} / {total:,}  ({pct:.1f}%)  — committed {len(updates)} rows")
            updates.clear()

    # Flush any remaining
    if updates:
        conn.executemany(
            "UPDATE policies SET cv_features = ? WHERE id = ?",
            updates,
        )
        conn.commit()
        print(f"  Flushed final {len(updates)} rows")

    # Verification query
    cur.execute("SELECT COUNT(*) FROM policies WHERE cv_features IS NOT NULL")
    populated = cur.fetchone()[0]

    conn.close()

    print(f"\n[populate_cv_features] Done.")
    print(f"  Policies populated : {populated:,} / {total:,}")
    if failed:
        print(f"  Failures           : {failed:,}  (cv_features left NULL for those rows)")
    if populated == total:
        print("  All policies have cv_features.")


if __name__ == "__main__":
    main()
