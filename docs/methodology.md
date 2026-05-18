# FORGE — Methodology

This document is the credibility contract behind the console. It names every
magic constant, defends the modeling choices most likely to be challenged,
and points at the Phase 2 / Phase 3 work that replaces each heuristic with a
calibrated estimate. The aim is to surface the gaps before an actuary or
program-committee reviewer does.

## 1. Trust tiers and the grammar contract

Every numbered surface in FORGE — chart, KPI, recommendation pill, sitrep
bullet — mounts a `TrustTierBadge` and (in most cases) a
`ProvenanceFootnote`. The five tiers form a strict provenance hierarchy:

- **LIVE_FEED** — pulled from an upstream API this minute (NHC, FIRMS, FEMA, NCEI).
- **MODEL_OUTPUT** — a calibrated model emitted this number (XGBoost loss heads, CV head, scenario generator).
- **SYNTHETIC_SCAFFOLD** — placeholder distribution standing in for a real feed until Phase 2 ingestion lands.
- **RECOMMENDATION** — optimizer output (Portfolio MIP, Operational LP, claims pre-flag).
- **MANUAL_OVERRIDE** — human-pinned value.

The view-by-view assignment is enumerated in the *Trust-tier surface
inventory* table of `docs/superpowers/plans/2026-05-16-forge-redesign.md`.
Implementers must reconcile against that table rather than invent labels ad
hoc — a number with the wrong badge is worse than a number with no badge.

## 2. Magic constants and their calibration plan

Five named heuristics carry coefficients that look like an actuary picked
them but were actually picked by an engineer. Each is listed with its
location, the Phase 2 task that replaces it, and the data the replacement
will use.

- **`REPRICE_FACTOR`** — `api_py/optimize_portfolio.py:34`. Magic values
  `1.15` (up) / `0.90` (down). Phase 2 **P2.8** swaps the flat multiplier
  for a price-elasticity MILP with a discretized rate grid, so retention
  drops as a function of magnitude. Calibration source: NAIC market-conduct
  retention-elasticity studies on personal homeowner lines.
- **`CESSION_COST_RATE`** — `api_py/optimize_portfolio.py:50`. Magic values
  `{cede_qs: 0.6, cede_xs: 0.15}`. Phase 2 **P2.7** replaces this with a
  per-cohort treaty cost driven by attachment, exhaustion, and
  rate-on-line. Calibration source: Artemis cat-bond pricing, Aon
  Reinsurance Market Outlook, FHCF rate filings.
- **`cede_xs` capital-zeroing** — `api_py/optimize_portfolio.py:147–153`.
  Zeros the retained-tail coefficient for `cede_xs` (see §3). Phase 2
  **P2.7** computes the per-cohort, per-scenario retained tail as
  `min(L, attachment) + max(0, L − exhaustion)`.
- **Claims `LOSS_FACTOR`** — `app/claims/page.tsx:36–40`. Three-tier
  heuristic `{high: 0.4, medium: 0.15, low: 0.05}` applied to TIV. Phase 2
  **P2.27** swaps this for the cohort `loss_p50` from the XGB quantile
  head, so the pre-brief list shares the optimizer's loss surface.
- **Reconciler thresholds** — `lib/reconciler/index.ts`,
  `NON_RENEW_THRESHOLD = 0.5` and `HIGH_ADJUSTER_DAYS = 2`. Operationally
  defensible but unbacked. Phase 2 surfaces both as manager-configurable
  knobs; Phase 3 **P3.9** tunes them against post-mortem outcomes.

## 3. The `cede_xs` rationale

The portfolio MIP zeros the retained-tail coefficient for `cede_xs` in the
capital constraint. The defense: excess-of-loss reinsurance attaches *below*
the cohort's VaR-99 (that is the point of an XS layer), so the insurer's
retained tail exposure at the p99 level is approximately zero for any cohort
that buys protection — which is what lets a tight capital budget remain
feasible.

The honest acknowledgement: this is a sleight-of-hand. Real attachment and
exhaustion points are treaty-specific, not derived from the p99 cut-point.
An actuary will catch this in thirty seconds, so the methodology doc names
the leak before they do. Phase 2 **P2.7** replaces the zeroing with the
`min(L, attachment) + max(0, L − exhaustion)` per-scenario tail math.

## 4. The VRP LP integrality argument

The operational adjuster-assignment program is solved as an LP, not an IP,
even though "adjuster X assigned to staging zone Y on day D" is binary. This
is not a relaxation gamble: the assignment polytope is **totally
unimodular**, which is sufficient for the LP relaxation to have integer
extreme points whenever the right-hand side is integer (Birkhoff–von
Neumann, 1946; Bertsimas & Tsitsiklis, *Introduction to Linear
Optimization*, Ch. 7). The LP returns an integer solution by construction,
not by luck — the operational schedule never needs branch-and-bound and the
solve stays under the 5-second budget.

## 5. Risk-measure choice

The portfolio MIP uses **VaR-99** today. VaR is intuitive (a single
quantile) but not coherent — not sub-additive, so it can recommend
portfolios that look safer when diced than when aggregated. Phase 2
**P2.6** swaps the constraint to **TVaR-99** (expected loss conditional on
exceeding the 99th percentile), which is coherent in the sense of Artzner,
Delbaen, Eber, and Heath, *"Coherent Measures of Risk,"* Mathematical
Finance 1999. The trade-off: TVaR-99 needs enough tail samples to be
stable, so it ships with the importance-sampling work in **P2.5**.

## 6. Reproducibility

Every stochastic input has a pinned seed:
`scripts/seed_policy_book.py` calls `random.seed(42)`, so the 10k book is
byte-identical across runs; `ml/xgb/train.py` uses
`np.random.default_rng(seed=0)` for synthetic loss generation;
`requirements.txt` and `package-lock.json` are pinned; `vercel.json` pins
the runtime to `python3.12`. What is still missing is a single-command
container build — Phase 3 **P3.24** adds a `Dockerfile` and a CI job that
runs `npm test`, `pytest`, and the eval scripts inside it.

## 7. Phase 2 and Phase 3 deferrals

Full matrix in `docs/superpowers/plans/2026-05-16-forge-redesign.md`. The
deferrals most likely to come up in review:

- TVaR-99 risk measure — P2.6.
- Importance-sampled tail scenarios — P2.5.
- SAA mode with optimality-gap envelope — P2.9.
- Price-elasticity MILP for reprice — P2.8.
- Treaty-cost model for cession — P2.7.
- Reliability + PIT calibration view (`/calibration`) — P2.10.
- Column generation for cohort-scale portfolio — P3.11 (credibility
  artifact, not a hot path).
- Pre-registered within-subject user study with cat-ops practitioners —
  P3.26 (multi-month, IRB-gated).
- Dockerfile + DOI'd Zenodo dataset card — P3.24 / P3.25.
- Post-mortem-driven reconciler-threshold tuning — P3.9.

None of these are blockers for the Phase 1 demo, which is scoped to "every
number has a tier, every chart has provenance, every magic constant is
labeled." This document is where that label points.
