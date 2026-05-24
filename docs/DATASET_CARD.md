# FORGE Synthetic Dataset Card

**Task P3.25** — Zenodo-formatted dataset card for the FORGE synthetic
policy book + scenario set. Follows the [HuggingFace dataset card
template](https://github.com/huggingface/datasets/blob/main/templates/README.md)
and the [Datasheets for Datasets](https://arxiv.org/abs/1803.09010)
framework (Gebru et al. 2018).

> **DOI placeholder.** Sagar reserves the Zenodo DOI manually (the
> autonomous-execution charter explicitly defers any external service
> wiring — see `memory/auth-vercel-deferred.md`). Once reserved, paste
> the DOI into the front-matter below and re-commit.

```yaml
---
title: "FORGE — Synthetic Policy Book + Multi-Peril Scenario Set"
version: "0.1.0"
license: "CC-BY-4.0"
doi: "TBD — Sagar reserves manually via Zenodo"
authors:
  - name: "Sagar Devaraju"
    affiliation: "FORGE"
keywords:
  - reinsurance
  - catastrophe modeling
  - portfolio optimization
  - synthetic data
  - HAZUS
  - HURDAT2
  - Monte Carlo
publication_date: "TBD"
---
```

---

## 1. Purpose

FORGE ships a synthetic 10,000-policy book + scenario set so the
demo / research workflow can be reproduced end-to-end without
exposing any real-customer policy data. The dataset is the
**input** to every component of the FORGE codebase that requires
geographic + intensity grounding (the Portfolio MIP, the
Operational LP, the claims pre-flagger, every notebook in
`eval/`).

## 2. Composition

| Artifact | Format | Size | Purpose |
|---|---|---|---|
| `policies` (DB) | SQLite `policies` table | 10,000 rows | Synthetic policy book — `(id, lat, lon, tiv, build_type, zip3, ...)` |
| `artifacts/calibration.json` | JSON | 4 KB | Common-factor (β, σ) + reliability quantiles — fitted from NOAA Storm Events per AUDIT.1 |
| `artifacts/portfolio_optimization.json` | JSON | 1.2 MB | Cached MIP solution — 570 cohorts × 11 actions allocation matrix |
| `artifacts/treaty.json` | JSON | 2 KB | Synthetic reinsurance ladder (fronting + QS + 2 XS + cat-bond) |
| `artifacts/regime/*.parquet` | parquet | 1 MB | AMO/ENSO regime conditioning per P2.3 |
| `artifacts/hurdat2/best_track.parquet` | parquet | 3 MB | NHC HURDAT2 Atlantic basin best-track (1851-2024) |

## 3. Provenance

### 3a. Policy book — synthetic
- **Generator:** `scripts/seed_policy_book.py`
- **Distribution:** lat/lon sampled per-state Gaussian (centered on
  population centroids); TIV log-normal; `build_type` weighted by
  Citizens FL HO market composition (HO5/HO3 split).
- **Geography note:** `zip3` is assigned independently of lat/lon —
  it is a label with NO real-world geographic meaning. The seed
  documents this explicitly. See `[[zip3-geography]]` memory.

### 3b. Scenario set — Monte Carlo
- **Hurricane (HURDAT2-anchored):** real HURDAT2 best-track parquet
  (1851-2024, NOAA NHC) feeds the importance-sampling fit
  (`ml/scenarios/importance.py::fit_basin_frequencies_from_hurdat2`).
  Per-storm Monte Carlo via `ml/scenarios/generate.py` produces
  K=1000 perturbed tracks per `storm_id`.
- **Multi-peril (P3.13-P3.18):** Five peril plug-ins
  (`ml/perils/{hurricane,scs,wildfire,eq,freeze}.py`) calibrated
  against published sources — see `research.md` §1c, §2d, §5c, §6c.
- **Basin coverage:** US Atlantic + Caribbean + Atlantic Canada
  (Task P3.18). HURDAT2 landfall counts: 735 / 241 / 24.

### 3c. Calibration — real-data anchors
- **Damage curves (`PERIL_SCALES`):** FEMA HAZUS-MH 5.1 Wind /
  Flood Technical Manual + IBHS hail studies + USGS dNBR + NWS WSSI
  + Bakun-Wentworth (1997) MMI attenuation. Page-level citations in
  `research.md` (AUDIT.2 deliverable).
- **Common-factor (β, σ):** NOAA Storm Events daily aggregates with
  the 8-episode gate (AUDIT.1).
- **Saffir-Simpson frequencies:** HURDAT2 fit (AUDIT.4 replacing
  the P2.5 literal placeholder).
- **Loss-prior σ = 0.85:** Citizens FL FHCF PML/AAL ratio anchor.

## 4. Recommended use

- **Research:** Compare alternative MIP formulations against the
  cached `solve()` baseline. Use the 10-cohort toy in
  `tests/api/test_optimize_portfolio_cg.py::_toy_10_cohort_book` as
  a reproducible benchmark.
- **Education:** Walk through the scenario-coupling pattern
  (`lib/reconciler/index.ts`) with the artifact set; every layer of
  the FORGE stack consumes the same scenarios.
- **Demo:** Spin up the dev server (`npm run dev`) and exercise the
  six surfaces (`/portfolio`, `/operational`, `/claims`,
  `/simulate`, `/treaty`, `/audit`) on the seeded book.

## 5. NOT recommended for

- **Production underwriting decisions.** Synthetic data; no real
  policies, no real claim history, no real geographic exposure
  concentration. The damage curves are HAZUS-anchored but the book
  composition is synthetic.
- **Regulatory filings.** The synthetic loss distribution is fit to
  Citizens FL benchmarks but is not validated against the carrier's
  own portfolio.
- **Investor pitches.** Use carrier-specific data; FORGE's synthetic
  book is for engineering / research.

## 6. Ethical considerations

- **No PII.** The synthetic seed contains no real policyholder
  names, addresses (only coarse lat/lon), or identifiers. The PII
  guard (P3.28a Presidio classifier, next PR) is a defense-in-depth
  layer for any future real-data ingest.
- **Geographic concentration risk.** The synthetic book is
  Florida-biased (matches Citizens FL). Models trained on this
  book will overfit Florida's coastal-hurricane regime and
  under-represent wildfire / earthquake risk. P3.13-P3.18 added
  multi-peril coverage to mitigate this.
- **HAZUS-MH calibration.** FEMA's published damage curves are not
  perfect — they tend to over-estimate damage for well-mitigated
  modern construction and under-estimate for legacy stock. See
  research.md §5b discussion.

## 7. Maintenance

- **Schema bumps:** SQLite schema in `lib/db/schema.sql`; treaty
  schema in `lib/treaty/types.ts` (currently v5). Each schema bump
  is documented in the corresponding PR body.
- **Artifact regeneration:** Run the script chain documented in
  `CLAUDE.md` (build / test cheatsheet) — `seed_policy_book.py` →
  `precompute_portfolio_optimization.py` → `precompute_treaty.py`
  → `precompute_calibration.py` → `ml.scenarios.regime --refresh`
  → `ml.scenarios.hurdat2 --refresh`.
- **Versioning:** Semantic versioning on the artifact set
  (currently v0.1.0). Major version bump when scenario set
  changes (e.g., adding a new peril family); minor when calibration
  changes (e.g., AUDIT.1 σ shift); patch when only docs change.

## 8. License

Released under [Creative Commons Attribution 4.0](
https://creativecommons.org/licenses/by/4.0/). Attribution: cite
the Zenodo DOI (once reserved) and the FORGE GitHub repository.

## 9. Citation

```bibtex
@dataset{forge_2026,
  title        = {FORGE -- Synthetic Policy Book + Multi-Peril Scenario Set},
  author       = {Devaraju, Sagar},
  year         = {2026},
  month        = {may},
  publisher    = {Zenodo},
  doi          = {TBD},
  url          = {https://github.com/sagardevaraju/forge}
}
```

## 10. Datasheet (Gebru et al. 2018)

### Motivation
- **For what purpose was the dataset created?** To enable
  reproducible end-to-end demos of the FORGE catastrophe-ops
  console without exposing real customer policy data.
- **Who created the dataset?** Sagar Devaraju.
- **Who funded it?** Independent.

### Composition
- **What do the instances represent?** Each row in `policies` is
  one synthetic insurance policy. Each row in `simulations` is one
  operator-drawn cat event. Each row in `decisions` is one MIP
  solve.
- **How many instances are there?** 10,000 policies (the seed);
  variable simulations + decisions (operator-driven).
- **Is the dataset complete?** The seeded artifacts are complete;
  the simulations + decisions tables grow with usage.
- **What data does each instance consist of?** See §2 / §3a above.
- **Is there a label?** No supervised labels — the dataset is for
  optimization + scenario simulation, not classification.

### Collection process
- **How was the data acquired?** Sampled programmatically per
  `scripts/seed_policy_book.py`. Real anchors (HURDAT2, ESA
  WorldCover, Microsoft Buildings) used for calibration overlays
  but not for individual policy assignment.
- **Were any ethical review processes conducted?** Not required
  — no human subjects, no PII.

### Preprocessing
- **Was any preprocessing/cleaning/labelling of the data done?**
  Cohort grouping into `{zip3}_{build_type}_q{N}` quintiles; CV
  feature extraction from Sentinel-2 chips via band-math (band
  math, NOT the trained MLP head — see CLAUDE.md note on the
  honesty contract).

### Uses
- **Has the dataset been used for any tasks already?** Yes —
  Phase 1 → Phase 3′ FORGE development.
- **Are there other tasks for which the dataset could be used?**
  Reinsurance pricing experiments, multi-peril Monte Carlo
  benchmarking, MIP decomposition research.

### Distribution
- **How will the dataset be distributed?** GitHub repository +
  Zenodo DOI (once reserved).

### Maintenance
- **Who is supporting / hosting / maintaining the dataset?**
  Sagar Devaraju.
- **How can the owner of the dataset be contacted?** Via the
  GitHub repository.

---

## Manual follow-up for Sagar

1. Reserve a Zenodo DOI for the v0.1.0 artifact set:
   - Go to https://zenodo.org/account/login (use GitHub OAuth)
   - "New upload" → "Reserve DOI" before uploading
   - Or: use the GitHub-Zenodo integration to auto-mint DOIs on tag
2. Paste the reserved DOI into the front-matter `doi:` field
   above (line 19) AND the BibTeX citation block (§9)
3. Re-commit as `docs(FORGE): P3.25 DOI reservation - <DOI>`
