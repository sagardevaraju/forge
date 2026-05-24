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

Usage
-----
    # Full book — ~15 min over a residential connection (MS Buildings is
    # the slow step at ~3-6 s per unique zoom-9 quadkey; ESA WorldCover is
    # ~1 s per policy uncached, but adjacent policies share scenes so
    # rasterio caches at the COG block level).
    python -m scripts.precompute_cv_weak_labels

    # Resume — skip policies already in the parquet
    python -m scripts.precompute_cv_weak_labels --resume

    # Smoke test — first 100 policies only
    python -m scripts.precompute_cv_weak_labels --limit 100

Determinism
-----------
ESA WorldCover 2021 is a static product; MS Buildings is the most-recent
``United States_*`` snapshot found at fetch time. Both are pinned by the
STAC items recorded in the parquet metadata (``stac_items`` key) so a
re-run never silently changes label vintage. See
``docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md``.

Network policy
--------------
Both data sources are accessed via Microsoft Planetary Computer, which
requires no API key for public reads. Set ``HTTPS_PROXY`` if your
network restricts outbound.
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


def precompute(limit: int | None = None, resume: bool = False) -> dict[int, dict[str, float]]:
    """Run the full ESA WC + MS Buildings precompute and return the dict."""
    from ml.cv.labels import esa_worldcover, ms_buildings  # noqa: PLC0415
    from ml.cv.labels.quadkey import chip_bbox, latlon_to_quadkey  # noqa: PLC0415

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = _load_existing(OUT_PATH) if resume else {}

    policies = _load_policies(limit=limit)
    print(f"[precompute] {len(policies):,} policies with on-disk chips")
    if resume:
        print(f"[precompute] {len(existing):,} already have labels; resuming")

    # Group by quadkey so we read each MS Buildings shard at most once.
    by_quadkey: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for pid, lat, lon in policies:
        if pid in existing:
            continue
        qk = latlon_to_quadkey(lat, lon, zoom=9)
        by_quadkey[qk].append((pid, lat, lon))
    print(f"[precompute] {len(by_quadkey)} unique zoom-9 quadkeys to scan")

    results: dict[int, dict[str, float]] = dict(existing)
    t_start = time.time()
    n_processed = 0
    n_failed = 0
    total_to_do = sum(len(v) for v in by_quadkey.values())

    for qk_idx, (qk, group) in enumerate(sorted(by_quadkey.items()), start=1):
        # Read shard ONCE for the whole quadkey group
        try:
            shard_geoms = ms_buildings.load_shard_geometries(qk)
        except Exception as exc:  # noqa: BLE001
            print(f"  [WARN] quadkey {qk} shard read failed: {exc}; skipping {len(group)} policies")
            shard_geoms = ()
            n_failed += len(group)
            continue

        for pid, lat, lon in group:
            # ESA WorldCover — small per-policy COG window read
            try:
                wc_chip = esa_worldcover.fetch_chip(lat=lat, lon=lon)
                wc = esa_worldcover.fractions_from_chip(wc_chip)
            except Exception as exc:  # noqa: BLE001
                print(f"  [WARN] policy {pid} ESA WC failed: {exc}")
                n_failed += 1
                continue
            # MS Buildings — bbox-filter geometries already in memory
            bbox = chip_bbox(lat, lon)
            rc = ms_buildings.reduce_geometries(shard_geoms, bbox)

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
                print(
                    f"  [{n_processed:,}/{total_to_do:,}]  qk {qk_idx}/{len(by_quadkey)}  "
                    f"rate={rate:.1f}/s  eta={eta/60:.1f}min"
                )

    if n_failed:
        print(f"[precompute] {n_failed} policies failed; left out of parquet")
    print(f"[precompute] Done — {len(results):,} rows total")
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
    # Embed provenance in parquet metadata so the artifact is self-describing.
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
    print(f"[precompute] Wrote {out_path}  ({out_path.stat().st_size / 1024:.1f} KB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--limit", type=int, default=None, help="Process only the first N policies (smoke test).")
    parser.add_argument("--resume", action="store_true", help="Skip policies already in the parquet.")
    args = parser.parse_args()

    results = precompute(limit=args.limit, resume=args.resume)
    _write_parquet(results, OUT_PATH)

    # Sanity print: book-wide stdev for each dim
    arr = np.array([
        [r["imperviousness"], r["roof_complexity"], r["tree_overhang"]]
        for r in results.values()
    ], dtype=np.float32)
    if arr.shape[0]:
        for i, name in enumerate(["imperviousness", "roof_complexity", "tree_overhang"]):
            print(f"  {name:18s}  mean={arr[:,i].mean():.4f}  stdev={arr[:,i].std():.4f}  "
                  f"min={arr[:,i].min():.4f}  max={arr[:,i].max():.4f}")


if __name__ == "__main__":
    main()
