"""
Pre-cache Sentinel-2 chips for every policy in forge-local.db.

Reads (id, lat, lon) from policies, fetches one chip per policy from
Microsoft Planetary Computer via :func:`ml.cv.data_loaders.fetch_chip`,
and writes the result to ``artifacts/chips/<id // 100:02d>/<id>.npy``.

The script is **fully resumable** — already-cached chips are skipped on
re-run, so a sleep/Ctrl-C in the middle of a 10-hour run loses nothing.
Failures (HTTP errors, no cloud-free scene, etc.) are logged to
``artifacts/chips_fetch_failures.txt`` and can be retried later via
``--retry-failed``.

Usage
-----

    # Smoke test (first 10 policies, ~30-60 s)
    python scripts/cache_s2_chips.py --limit 10

    # Full 10k run — keep the laptop awake with caffeinate
    caffeinate -i python scripts/cache_s2_chips.py 2>&1 | tee artifacts/chips_fetch.log

    # Retry only the policies that failed previously
    python scripts/cache_s2_chips.py --retry-failed

The script is single-threaded by design — Planetary Computer is fine with
hundreds of req/s but the per-chip wall time is dominated by 5 sequential
band reads, not catalog latency, so parallelism gains are modest while
rate-limit risk grows linearly.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FutTimeout
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Path setup so this script runs from any cwd
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Encourage GDAL/rasterio to retry transient HTTP failures during the big run.
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("GDAL_HTTP_TIMEOUT", "60")

DB_PATH = _REPO_ROOT / "forge-local.db"
FAILURE_LOG = _REPO_ROOT / "artifacts" / "chips_fetch_failures.txt"

#: Per-fetch wall-clock budget. Belt-and-suspenders alongside GDAL_HTTP_TIMEOUT
#: because rasterio/CURL pools sometimes ignore the env var on long runs and
#: park sockets in CLOSE_WAIT forever.
FETCH_TIMEOUT_S: int = 90


def _fmt_elapsed(seconds: float) -> str:
    return str(timedelta(seconds=int(seconds)))


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _load_policies(limit: int | None, retry_failed: bool) -> list[tuple[int, float, float]]:
    """Return rows of (id, lat, lon) to process this run.

    With ``retry_failed=True``, restrict to ids listed in the failure log.
    With ``limit`` set, slice the first N rows after that filter.
    """
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id, lat, lon FROM policies ORDER BY id")
    rows = cur.fetchall()
    conn.close()

    if retry_failed:
        if not FAILURE_LOG.exists():
            print(f"[cache_s2_chips] No failure log at {FAILURE_LOG} — nothing to retry.")
            return []
        failed_ids: set[int] = set()
        for line in FAILURE_LOG.read_text().splitlines():
            tok = line.strip().split("\t", 1)[0]
            if tok.isdigit():
                failed_ids.add(int(tok))
        rows = [r for r in rows if r[0] in failed_ids]

    if limit is not None:
        rows = rows[:limit]
    return rows


def _log_failure(policy_id: int, msg: str) -> None:
    FAILURE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with FAILURE_LOG.open("a") as f:
        f.write(f"{policy_id}\t{_now()}\t{msg}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only process the first N policies (for smoke testing).",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Retry only the policy_ids listed in artifacts/chips_fetch_failures.txt.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=25,
        help="Log a progress line every N successful fetches (default 25).",
    )
    args = parser.parse_args()

    # Lazy imports — only required when we actually fetch.
    from ml.cv.data_loaders import (  # noqa: PLC0415
        CHIPS_DIR,
        chip_path,
        fetch_chip,
        save_cached_chip,
    )

    rows = _load_policies(args.limit, args.retry_failed)
    if not rows:
        print("[cache_s2_chips] No policies to process. Exiting.")
        return 0

    CHIPS_DIR.mkdir(parents=True, exist_ok=True)

    # One worker per fetch — running the (blocking) rasterio HTTP read on a
    # worker thread lets the main thread enforce FETCH_TIMEOUT_S via
    # Future.result(timeout=...). The thread is unkillable if it hangs, but
    # it stops counting against per-policy progress and we move on.
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="s2-fetch")

    def _fetch_with_timeout(lat: float, lon: float) -> np.ndarray:
        fut = pool.submit(fetch_chip, lat=lat, lon=lon)
        return fut.result(timeout=FETCH_TIMEOUT_S)

    total = len(rows)
    ok = skipped = failed = 0
    started = time.monotonic()

    print(
        f"[cache_s2_chips] {_now()}  start  total={total}  "
        f"chips_dir={CHIPS_DIR}  retry_failed={args.retry_failed}  "
        f"fetch_timeout={FETCH_TIMEOUT_S}s"
    )

    for i, (policy_id, lat, lon) in enumerate(rows, start=1):
        path = chip_path(policy_id)
        if path.exists():
            skipped += 1
            continue

        t0 = time.monotonic()
        chip: np.ndarray | None = None
        last_err: Exception | None = None

        for attempt in (1, 2):  # one retry on transient failure
            try:
                chip = _fetch_with_timeout(lat=lat, lon=lon)
                break
            except _FutTimeout:
                last_err = TimeoutError(f"fetch_chip > {FETCH_TIMEOUT_S}s")
                # Recreate the pool so the next call doesn't queue behind
                # the still-blocked worker thread.
                pool.shutdown(wait=False, cancel_futures=True)
                pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="s2-fetch")
                if attempt == 1:
                    time.sleep(2.0)
                    continue
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                if attempt == 1:
                    time.sleep(2.0)  # brief pause before retry
                    continue

        if chip is None:
            failed += 1
            _log_failure(policy_id, f"{type(last_err).__name__}: {last_err}")
            print(
                f"  [FAIL] policy {policy_id} @ ({lat:.4f},{lon:.4f}) "
                f"— {type(last_err).__name__}: {last_err}"
            )
            continue

        try:
            save_cached_chip(policy_id=policy_id, chip=chip)
            ok += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            _log_failure(policy_id, f"save_error: {exc}")
            print(f"  [FAIL] policy {policy_id} save_error: {exc}")
            continue

        if ok and ok % args.progress_every == 0:
            elapsed = time.monotonic() - started
            done = ok + skipped
            remaining = total - done - failed
            rate = ok / max(elapsed - 0.0, 1e-3)  # chips/sec successfully fetched
            eta_sec = remaining / max(rate, 1e-3)
            per_chip = (time.monotonic() - t0)
            print(
                f"  {_now()}  ok={ok}  skip={skipped}  fail={failed}  "
                f"({100 * done / total:.1f}%)  "
                f"last={per_chip:.2f}s  "
                f"avg={1/rate:.2f}s/chip  "
                f"elapsed={_fmt_elapsed(elapsed)}  "
                f"eta={_fmt_elapsed(eta_sec)}"
            )

    elapsed = time.monotonic() - started
    print(
        f"[cache_s2_chips] {_now()}  done  "
        f"ok={ok}  skipped={skipped}  failed={failed}  "
        f"elapsed={_fmt_elapsed(elapsed)}"
    )
    if failed:
        print(
            f"  Failure list: {FAILURE_LOG}  "
            f"(rerun with --retry-failed to attempt these again)"
        )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
