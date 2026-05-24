"""Task P2.17 — precompute treaty stack data for the /treaty view.

Writes ``artifacts/treaty.json`` consumed by the P2.17 treaty view. The
schema is the TS counterpart in ``lib/treaty/types.ts``:

    {
      "schema_version": 1,
      "generated_at": ISO-8601,
      "data_source": "live" | "synthetic_demo",
      "book_p99": float,           # dollars
      "layers": [
        {"type": "qs", "share": 0.5, ...},
        {"type": "xs", "attachment": ..., "exhaustion": ..., "rol": ...,
         "reinstatements_remaining": ...},
        ...
      ]
    }

**Honesty contract**: until placed-treaty terms ship through a real feed
the artifact is ``data_source = "synthetic_demo"``. The synthetic stack
mirrors the defaults the Operational LP / cession sizing logic uses
(attachment ~ p50 × 1.5 of book p99 → upper xs attaches at p99 × ~1.0,
exhaustion ~ p99 × 1.5–2.0 so we cover the cat-event tail). Re-run after
the portfolio precompute changes ``book_p99``:

    python -m scripts.precompute_treaty
"""

# Output: ``artifacts/treaty.json`` — tracked in git on the same convention
# as ``artifacts/portfolio_optimization.json`` (Task P2.0) and
# ``artifacts/calibration.json`` (Task P2.2). The page reads the file at
# request time; we do not re-run the precompute in serverless.

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make the project root importable so that running as ``python -m scripts.…``
# or ``python scripts/precompute_treaty.py`` both work.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ARTIFACTS_DIR = ROOT / "artifacts"
PORTFOLIO_ARTIFACT = ARTIFACTS_DIR / "portfolio_optimization.json"
OUT_PATH = ARTIFACTS_DIR / "treaty.json"

# Fallback p99 used when ``portfolio_optimization.json`` is missing — keeps
# the script runnable in a fresh clone before the portfolio precompute is
# executed. Picked to be in the same order of magnitude as the seeded book
# (~$80M book p99 on the 10k-policy demo book).
DEFAULT_BOOK_P99 = 1.0e8


def _load_book_p99() -> float:
    """Pull ``book_totals.loss_p99`` from the portfolio artifact if it exists.

    The treaty view is read-only and the portfolio precompute is the
    canonical source of book-level loss numbers — re-deriving them here
    would be a second source of truth and a divergence trap. If the
    artifact is missing we fall back to a sensible default and tag the
    output as synthetic anyway.
    """
    if not PORTFOLIO_ARTIFACT.exists():
        return DEFAULT_BOOK_P99
    try:
        payload = json.loads(PORTFOLIO_ARTIFACT.read_text())
    except (OSError, ValueError):
        return DEFAULT_BOOK_P99
    totals = payload.get("book_totals") or {}
    p99 = totals.get("loss_p99")
    if isinstance(p99, (int, float)) and p99 > 0:
        return float(p99)
    return DEFAULT_BOOK_P99


def _build_layers(
    book_p99: float,
    include_fronting: bool = True,
) -> list[dict[str, Any]]:
    """Construct the synthetic-demo layer ladder.

    Layout (bottom to top):
      1. Fronting — 5% residual retention, 6% fronting fee, ceded to a
         synthetic captive. Surfaces only when ``include_fronting`` is
         True (Task P3.19 default).
      2. QS — 50% share. No reinstatements (the demo QS is a flat slice).
      3. XS_1 — attaches at $20M, exhausts at $60M. RoL 10%. 1 reinstatement.
      4. XS_2 — attaches at $60M, exhausts at $120M. RoL 6%. 2 reinstatements.

    The attachment ladder is set in absolute dollars rather than relative
    to ``book_p99`` so a regenerated portfolio artifact doesn't quietly
    shift the layer geometry behind the view. We expose ``book_p99`` as a
    separate field so the view can draw a reference line.
    """
    layers: list[dict[str, Any]] = []
    if include_fronting:
        # Task P3.19 — synthetic fronting layer below the QS. Anchored on
        # Aon Reinsurance Market Outlook 2024 §4.3 + Guy Carpenter
        # "Fronting on the Rise" 2024: fronting-fee range 3-8% of
        # premium; residual loss retention typically 5-10% (regulators
        # generally disallow pure 0% conduits outside specific captives).
        layers.append({
            "type": "fronting",
            "residual_retention_share": 0.05,
            "fronting_fee_share": 0.06,
            "capital_provider": "captive",
            "description": (
                "Fronting — 95% ceded to captive, 5% retained by fronter; "
                "6% fronting fee on premium."
            ),
        })
        # Task P3.20 — synthetic captive vehicle absorbing the fronted
        # cession. Capital position anchored at 1.5× book p99 (consistent
        # with industry-typical 1.2-2.0× PML capital ratios for cat-
        # exposed captives per AICAP 2023 single-parent captive survey).
        # Trapped composition (industry-typical for a 5-year-old captive):
        #   60% outstanding reserves (open claims)
        #   25% collateral pledged to fronter (LOC + trust account)
        #   10% UPR (unearned premium reserve, pro-rata)
        #   5% free
        total_capital = book_p99 * 1.5
        layers.append({
            "type": "captive",
            "total_capital_usd": total_capital,
            "outstanding_reserves_usd": total_capital * 0.60,
            "collateral_pledged_usd": total_capital * 0.25,
            "unearned_premium_reserve_usd": total_capital * 0.10,
            "description": (
                "Captive absorbing the fronted cession. ~95% trapped "
                "(reserves + collateral + UPR); ~5% free for redeployment."
            ),
        })
    layers.extend([
        {
            "type": "qs",
            "share": 0.50,
            "rol": 0.18,
            "description": "Quota Share — 50% of every policy ceded.",
        },
        {
            "type": "xs",
            "attachment": 20_000_000,
            "exhaustion": 60_000_000,
            "rol": 0.10,
            "reinstatements_remaining": 1,
            "description": "Working XS layer — $40M xs $20M.",
        },
        {
            "type": "xs",
            "attachment": 60_000_000,
            "exhaustion": 120_000_000,
            "rol": 0.06,
            "reinstatements_remaining": 2,
            "description": "Cat XS layer — $60M xs $60M.",
        },
        # Task P3.21 — synthetic ILS / cat-bond layer above the cat XS.
        # Anchors on Artemis Q4-2024 cat-bond ROL median (≈ 8.5% for
        # multi-peril US wind/quake at attachment around 1-in-50 PML).
        # 3-year term + annual reset is the modal cat-bond structure
        # (Artemis Deal Directory 2024 — 56% of issuances).
        {
            "type": "ils",
            "attachment": 120_000_000,
            "exhaustion": 200_000_000,
            "trigger": "indemnity",
            "coupon_rate": 0.085,
            "term_years": 3,
            "reset_years": 1,
            "description": (
                "Cat-bond — $80M xs $120M, indemnity trigger, "
                "8.5% coupon, 3yr term, annual reset."
            ),
        },
    ])
    return layers


def main() -> None:
    # Task P3.19 — CLI flag for opting out of the fronting layer. Default
    # is to include it (matches the synthetic-demo convention used by
    # every other treaty surface).
    include_fronting = "--no-fronting" not in sys.argv
    book_p99 = _load_book_p99()
    layers = _build_layers(book_p99, include_fronting=include_fronting)
    payload: dict[str, Any] = {
        "schema_version": 4,  # P3.21 bumped to 4 with ILSLayer added
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_source": "synthetic_demo",
        "book_p99": book_p99,
        "layers": layers,
    }

    ARTIFACTS_DIR.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, separators=(",", ":")))
    size = os.path.getsize(OUT_PATH)
    n_qs = sum(1 for l in layers if l["type"] == "qs")
    n_xs = sum(1 for l in layers if l["type"] == "xs")
    n_fr = sum(1 for l in layers if l["type"] == "fronting")
    n_cap = sum(1 for l in layers if l["type"] == "captive")
    n_ils = sum(1 for l in layers if l["type"] == "ils")
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}  ({size:,} bytes)")
    print(f"  data_source: synthetic_demo")
    print(f"  book_p99:    ${book_p99:,.0f}")
    print(
        f"  layers:      {len(layers)} "
        f"({n_fr} fronting + {n_cap} captive + {n_qs} QS + {n_xs} XS + {n_ils} ILS)"
    )


if __name__ == "__main__":
    main()
