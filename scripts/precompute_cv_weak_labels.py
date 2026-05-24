"""
Precompute the three previously-unmodeled CV head weak labels for every
policy with a cached Sentinel-2 chip.

This script is the **bridge** between the on-disk chip cache and the
training step (``python ml/cv/train.py``). It:

  1. Reads ``(id, lat, lon)`` from ``forge-local.db``.
  2. For each policy whose chip exists and is non-empty, computes:
        - ``imperviousness``  ← ESA WorldCover class-50 fraction (10 m raster,
          MPC ``esa-worldcover``, CC-BY-4.0)
        - ``tree_overhang``   ← ESA WorldCover class-10 fraction (same fetch)
        - ``roof_complexity`` ← 1 − mean(Polsby-Popper) over MS Building
          Footprints polygons inside the chip bbox (MPC ``ms-buildings``,
          ODbL-1.0)
  3. Writes the result to ``artifacts/cv_weak_labels.parquet`` (tracked,
     small — ~250 KB for 10 k rows × 3 float32 columns).

Performance notes
-----------------
ESA WorldCover is sharded into 3°×3° tiles; ``esa_worldcover._open_scene``
LRU-caches the ``rasterio.DatasetReader`` so the contiguous-US book (which
spans ~20 tiles) opens each tile once and reuses it across thousands of
window reads. MS Building Footprints is sharded by Bing quadkey at zoom 9
and ``ms_buildings.load_shard_geometries`` LRU-caches the decoded
geometries so a metro-area cluster of policies reads its shard once.
Net per-policy cost after warmup is ~50 ms (one rasterio window + one
bbox-filter over already-decoded polygons).

Usage
-----
    # Full book — ~15 min over a residential connection.
    python -m scripts.precompute_cv_weak_labels

    # Resume — skip policies already in the parquet
    python -m scripts.precompute_cv_weak_labels --resume

    # Smoke test — first 100 policies only
    python -m scripts.precompute_cv_weak_labels --limit 100

Determinism
-----------
ESA WorldCover 2021 is a static product; MS Buildings is the most-recent
``United States_*`` snapshot found at fetch time. Both are pinned by the
STAC items recorded in the parquet metadata (``forge.sources`` key) so a
re-run never silently changes label vintage. See
``docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md``.

Network policy
--------------
Both data sources are accessed via Microsoft Planetary Computer, which
requires no API key for public reads.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

DB_PATH = _REPO_ROOT / "forge-local.db"
OUT_PATH = _REPO_ROOT / "artifacts" / "cv_weak_labels.parquet"


def _log(msg: str) -> None:
    """``print`` with ``flush=True``. The script is long-running and we
    want progress visible even when stdout is redirected to a log file."""
    print(msg, flush=True)


def _load_policies(limit: int | None = None) -> list[tuple[int, float, float]]:
    """Return ``(id, lat, lon)`` for every policy whose chip is on disk + non-empty.

    Mirrors the offshore-seed filtering done by ``PolicyChipDataset`` in
    ``ml/cv/train.py`` so the label parquet has one-to-one alignment with
    the trainable subset.
    """
    from ml.cv.data_loaders import chip_path  # noqa: PLC0415

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id, lat, lon FROM policies ORDER BY id")
    rows = cur.fetchall()
    conn.close()

    out: list[tuple[int, float, float]] = []
    for pid, lat, lon in rows:
        p = chip_path(pid)
        if not p.exists():
            continue
        try:
            chip = np.load(p, mmap_mode="r")
            if int(chip.max()) == 0:
                continue
        except Exception:  # noqa: BLE001
            continue
        out.append((int(pid), float(lat), float(lon)))
        if limit is not None and len(out) >= limit:
            break
    return out


def _load_existing(out_path: Path) -> dict[int, dict[str, float]]:
    """Read existing parquet (if any) keyed by policy_id for --resume."""
    if not out_path.exists():
        return {}
    import pyarrow.parquet as pq  # noqa: PLC0415

    table = pq.read_table(out_path)
    pdf = table.to_pandas()
    return {int(r["policy_id"]): {
        "imperviousness": float(r["imperviousness"]),
        "roof_complexity": float(r["roof_complexity"]),
        "tree_overhang": float(r["tree_overhang"]),
    } for _, r in pdf.iterrows()}


def _write_checkpoint(results: dict[int, dict[str, float]], out_path: Path) -> None:
    """Same on-disk format as the final parquet — written every N rows so
    a SIGTERM doesn't lose hours of work."""
    _write_parquet(results, out_path)


def precompute(
    limit: int | None = None,
    resume: bool = False,
    checkpoint_every: int = 1000,
) -> dict[int, dict[str, float]]:
    """Run the full ESA WC + MS Buildings precompute and return the dict.

    Parameters
    ----------
    limit:
        Process only the first N policies (smoke test).
    resume:
        Skip policies already present in the existing parquet.
    checkpoint_every:
        Flush the in-memory results to ``artifacts/cv_weak_labels.parquet``
        every N successful policies. Defaults to 1000 — about one disk
        write per minute at the post-warmup rate.
    """
    from ml.cv.labels import esa_worldcover, ms_buildings  # noqa: PLC0415
    from ml.cv.labels.quadkey import chip_bbox, latlon_to_quadkey  # noqa: PLC0415

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = _load_existing(OUT_PATH) if resume else {}

    policies = _load_policies(limit=limit)
    _log(f"[precompute] {len(policies):,} policies with on-disk chips")
    if resume:
        _log(f"[precompute] {len(existing):,} already have labels; resuming")

    # Group by quadkey so each MS Buildings shard is read at most once.
    by_quadkey: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for pid, lat, lon in policies:
        if pid in existing:
            continue
        qk = latlon_to_quadkey(lat, lon, zoom=9)
        by_quadkey[qk].append((pid, lat, lon))
    _log(f"[precompute] {len(by_quadkey)} unique zoom-9 quadkeys to scan")

    results: dict[int, dict[str, float]] = dict(existing)
    t_start = time.time()
    n_processed = 0
    n_failed = 0
    total_to_do = sum(len(v) for v in by_quadkey.values())

    for qk_idx, (qk, group) in enumerate(sorted(by_quadkey.items()), start=1):
        try:
            shard_geoms, shard_tree = ms_buildings.load_shard_index(qk)
        except Exception as exc:  # noqa: BLE001
            _log(f"  [WARN] quadkey {qk} shard read failed: {exc}; skipping {len(group)} policies")
            n_failed += len(group)
            continue

        for pid, lat, lon in group:
            try:
                wc_chip = esa_worldcover.fetch_chip(lat=lat, lon=lon)
                wc = esa_worldcover.fractions_from_chip(wc_chip)
            except Exception as exc:  # noqa: BLE001
                _log(f"  [WARN] policy {pid} ESA WC failed: {exc}")
                n_failed += 1
                continue

            bbox = chip_bbox(lat, lon)
            rc = ms_buildings.reduce_with_index(shard_geoms, shard_tree, bbox)

            results[pid] = {
                "imperviousness": wc.imperviousness,
                "roof_complexity": rc.value,
                "tree_overhang": wc.tree_overhang,
            }
            n_processed += 1

            if n_processed % 100 == 0:
                elapsed = time.time() - t_start
                rate = n_processed / max(elapsed, 1e-9)
                eta = (total_to_do - n_processed) / max(rate, 1e-9)
                _log(
                    f"  [{n_processed:,}/{total_to_do:,}]  qk {qk_idx}/{len(by_quadkey)}  "
                    f"rate={rate:.1f}/s  eta={eta/60:.1f}min"
                )

            if checkpoint_every and n_processed % checkpoint_every == 0:
                _write_checkpoint(results, OUT_PATH)
                _log(f"  [checkpoint] flushed {len(results):,} rows to {OUT_PATH.name}")

    if n_failed:
        _log(f"[precompute] {n_failed} policies failed; left out of parquet")
    _log(f"[precompute] Done — {len(results):,} rows total")
    return results


def _write_parquet(results: dict[int, dict[str, float]], out_path: Path) -> None:
    """Persist results to a small parquet with explicit dtype + metadata."""
    import pyarrow as pa  # noqa: PLC0415
    import pyarrow.parquet as pq  # noqa: PLC0415

    pids = sorted(results.keys())
    table = pa.table({
        "policy_id": pa.array(pids, type=pa.int64()),
        "imperviousness": pa.array(
            [float(results[p]["imperviousness"]) for p in pids], type=pa.float32(),
        ),
        "roof_complexity": pa.array(
            [float(results[p]["roof_complexity"]) for p in pids], type=pa.float32(),
        ),
        "tree_overhang": pa.array(
            [float(results[p]["tree_overhang"]) for p in pids], type=pa.float32(),
        ),
    })
    metadata = {
        b"forge.task": b"P2.37",
        b"forge.spec": b"docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md",
        b"forge.sources": json.dumps({
            "imperviousness": "ESA WorldCover 2021 class 50 (CC-BY-4.0, MPC esa-worldcover)",
            "tree_overhang": "ESA WorldCover 2021 class 10 (CC-BY-4.0, MPC esa-worldcover)",
            "roof_complexity": "Microsoft US Building Footprints 1 - mean(Polsby-Popper) (ODbL-1.0, MPC ms-buildings)",
        }).encode(),
    }
    table = table.replace_schema_metadata(metadata)
    pq.write_table(table, out_path, compression="zstd")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--limit", type=int, default=None, help="Process only the first N policies (smoke test).")
    parser.add_argument("--resume", action="store_true", help="Skip policies already in the parquet.")
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=1000,
        help="Flush parquet every N rows (default 1000; 0 disables in-flight checkpoints).",
    )
    args = parser.parse_args()

    results = precompute(
        limit=args.limit,
        resume=args.resume,
        checkpoint_every=args.checkpoint_every,
    )
    _write_parquet(results, OUT_PATH)
    _log(f"[precompute] Wrote {OUT_PATH}  ({OUT_PATH.stat().st_size / 1024:.1f} KB)")

    # Sanity print: book-wide stdev for each dim — a head trained against
    # near-constant labels collapses to a constant function, so the
    # weak-label spread must be non-trivial.
    arr = np.array([
        [r["imperviousness"], r["roof_complexity"], r["tree_overhang"]]
        for r in results.values()
    ], dtype=np.float32)
    if arr.shape[0]:
        for i, name in enumerate(["imperviousness", "roof_complexity", "tree_overhang"]):
            _log(
                f"  {name:18s}  mean={arr[:,i].mean():.4f}  stdev={arr[:,i].std():.4f}  "
                f"min={arr[:,i].min():.4f}  max={arr[:,i].max():.4f}"
            )


if __name__ == "__main__":
    main()
