"""
Batch-populate cv_features for all 10k policies in forge-local.db.

Usage
-----
    # Default — fast deterministic mock features (no trained model needed)
    python scripts/populate_cv_features.py

    # Run the trained MLP head over pre-fetched real S2 chips
    python scripts/populate_cv_features.py --mode cached

    # Hit Planetary Computer live (slow; not recommended for the full 10k)
    python scripts/populate_cv_features.py --mode real

The script:
  1. Reads all (id, lat, lon) rows from policies.
  2. For each policy, calls load_chip_features(...) to get an 8-dim vector.
  3. Writes the feature as a JSON-stringified array to the cv_features
     column via: UPDATE policies SET cv_features = ? WHERE id = ?
  4. Prints progress every 1000 policies.

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

    print(f"[populate_cv_features] mode={mode}  db={DB_PATH}")
    if mode == "mock":
        print(
            "[populate_cv_features] WARNING: mock-mode writes band-math\n"
            "  statistics over uniform-noise chips. Do not surface the result\n"
            "  in the UI without a `cv_features_source='mock'` downgrade.",
        )

    # Import here (after path setup) to keep the script runnable from any cwd
    from ml.cv.inference import load_chip_features  # noqa: PLC0415

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
            )
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
