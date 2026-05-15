# FORGE — Design Spec

**Forecast-driven Operational Risk Governance Engine**
*Catastrophe Decision Intelligence Platform*
*Tagline: "Forge the posture before the cone shifts."*

---

## 1. Business problem

A U.S. P&C insurance carrier's catastrophe operations desk makes one coupled decision every week: given the next 14–90 days of catastrophe forecasts, what is the optimal posture across underwriting, field operations, and claims preparation?

Today this decision is fragmented:

- **Meteorology** team writes a forecast briefing in Word.
- **Actuarial** team runs Verisk AIR / RMS overnight, produces a PDF of zone exposure.
- **Field-ops** team maintains a spreadsheet of adjuster home bases and a rule-of-thumb staging plan.
- **Reinsurance** team tracks treaty exposure in a separate model.

Every Monday at 8am, the VP of Catastrophe Operations sits through a three-hour meeting where these four artifacts are reconciled by hand. Decisions get made — non-renew, reprice, cede, pre-stage, pre-flag — but they are **not scenario-coupled**: portfolio decisions are made against one set of assumed events, while field-ops makes decisions against another. When the actual storm path diverges, the carrier discovers misalignment only after losses materialize.

**FORGE collapses the four artifacts into one scenario-coupled console**, so all three downstream levers consume the same Monte Carlo scenario set drawn from the same live forecast distribution. Coupling the levers is the product.

---

## 2. Manager persona

**VP / Director of Catastrophe Operations** at a U.S. P&C carrier (Travelers National Catastrophe, Allstate CAT, Heritage Insurance, Progressive's storm desk are realistic targets).

- Reports to the Chief Underwriting Officer.
- Coordinates with claims operations, reinsurance treasury, and field operations.
- Owns the quarterly cat-loss outlook and the weekly cat posture.
- Carries a P&L: bonus tied to combined ratio in cat-exposed lines.
- Time horizon: 14 days (current named events) to 90 days (seasonal posture).

Secondary users:

- **Cat-ops analyst** — runs FORGE daily, prepares the Monday briefing.
- **Reinsurance treasurer** — consumes cession recommendations.
- **Field-ops coordinator** — consumes pre-positioning plan.

---

## 3. The decision — one decision, three levers

**Decision (one sentence):** *"Given the next 14–90 days of catastrophe forecasts, what is our optimal posture across underwriting, operations, and claims?"*

Decomposed into three levers, all consuming the same scenario set:

| Lever | Action options | Time horizon | Constraint |
|---|---|---|---|
| **Portfolio** | retain · reprice · non-renew · cede to reinsurance | 30–90 days | Capital, regulatory non-renew caps, customer-continuity rules |
| **Operations** | adjuster + drone + mobile-unit pre-positioning | 24–72 hours pre-landfall | Adjuster capacity, drive time, staging zone capacity |
| **Claims-prep** | pre-flag policies inside forecast cones with expected severity tier | 24–72 hours pre-landfall | Claim-system load, contact-center capacity |

**Why coupling matters:** if the portfolio lever non-renews 1,200 Florida policies, the ops lever must NOT pre-stage adjusters for those policies' losses — they're no longer the carrier's losses. Today this reconciliation happens manually after the fact.

---

## 4. Technical architecture

```
                  ┌─────────────────────────────────────────┐
                  │              LIVE DATA FEEDS             │
                  │  Sentinel-2 · FIRMS · NHC · NOAA · FEMA  │
                  │  OSM · Zillow · Census ACS               │
                  └────────────────┬────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌────────────────┐       ┌────────────────────┐    ┌─────────────────────┐
│ Property Risk  │       │ Scenario Generator │    │  Carrier Policy     │
│ CV (ViT)       │       │ + LLM Agent        │    │  Book (synthetic)   │
│                │       │                    │    │                     │
│ Sentinel-2     │       │ ingests cones,     │    │ ~10k policies in    │
│ → 8-dim risk   │       │ fires, bulletins   │    │ FL/TX/LA/NC, with   │
│   feature vec  │       │ → 1000 MC          │    │ TIV, build type,    │
│   per property │       │   scenarios per    │    │ ZIP, flood zone     │
│                │       │   active threat    │    │                     │
└────────┬───────┘       └─────────┬──────────┘    └──────────┬──────────┘
         │                         │                          │
         │  property features      │  scenarios (paths,       │  policies
         │                         │  wind, surge, prob)      │
         ▼                         ▼                          ▼
         ┌──────────────────────────────────────────────────────────┐
         │            XGBoost Loss-Severity Model                    │
         │   features → $ loss per (policy, scenario) draw           │
         │   trained on NOAA Storm Events 2018–2024                  │
         └────────────────────┬─────────────────────────────────────┘
                              │
                              │  E[loss], VaR_99, scenario-conditional loss
                              ▼
         ┌──────────────────────────────────────────────────────────┐
         │             SHARED SCENARIO STORE (DuckDB)                │
         │  one row per (cohort_id, scenario_id) — used by all       │
         │  three optimization layers below                          │
         └─────┬──────────────────────┬─────────────────────┬───────┘
               │                      │                     │
               ▼                      ▼                     ▼
       ┌───────────────┐     ┌────────────────┐    ┌────────────────┐
       │ Portfolio MIP │     │ Operational    │    │ Claims-Prep    │
       │ (PuLP / CBC)  │     │ VRP (OR-Tools) │    │ Pre-Flagger    │
       │               │     │                │    │                │
       │ retain/reprice│     │ stage adjusters│    │ flag policies  │
       │ /non-renew/   │     │ to landfall    │    │ in 80% cone    │
       │ cede          │     │ zones          │    │ w/ severity    │
       └───────┬───────┘     └────────┬───────┘    └────────┬───────┘
               │                      │                     │
               └──────────┬───────────┴─────────────────────┘
                          ▼
               ┌─────────────────────────┐
               │  Decision Reconciler    │
               │  (resolves x-lever      │
               │  conflicts: e.g. don't  │
               │  stage adjusters for    │
               │  non-renewed policies)  │
               └────────────┬────────────┘
                            ▼
               ┌─────────────────────────────────┐
               │  Next.js 16 / React 19 / Vercel  │
               │  · Portfolio Map                 │
               │  · Event Console (with sitrep)   │
               │  · Claims Pre-Brief              │
               └─────────────────────────────────┘
```

**Deployment topology (Vercel):**

```
Browser
  │
  ▼
Next.js App Router (Vercel Edge + Node + Python runtimes)
  ├── React UI (Server Components + Mapbox GL JS)
  ├── /api/agent          → Node runtime, streams LLM tokens
  ├── /api/optimize       → Python runtime (PuLP/OR-Tools)
  ├── /api/feeds          → Node runtime, fetches NHC/FIRMS/NOAA
  └── /api/cron/refresh   → Vercel Cron, every 15 min
  │
  ▼
Turso (SQLite over libSQL)  ← policy book + scenario store
Vercel Blob                 ← pre-computed CV features, model artifacts
OpenRouter (GPT-4o/4.1) ──┐
                          ├── cascading LLM with retry/failover
GitHub Models PAT (GPT-4o)┘
```

---

## 5. Component specs

### 5.1 Property Risk CV — Vision Transformer

**Input:** Sentinel-2 L2A tiles, 5 bands (RGB + NIR + SWIR), 10m resolution, 256×256 px chips centered on each property.

**Output:** 8-dim feature vector per property: `{vegetation_density, impervious_surface_pct, fuel_proximity, roof_condition_proxy, water_proximity, elevation_bucket, ndvi_seasonal_var, structure_density}`.

**Model:** Fine-tune **IBM/NASA Prithvi-100M** or **Clay Foundation Model** (both pre-trained on global Sentinel-2). Add a small regression head (4 layers MLP) to predict the 8 features. Total trainable params <5M.

**Training labels:** Weakly supervised from OpenStreetMap (vegetation, roads, buildings) + USGS NLCD (impervious surface) + LANDFIRE (fuel) for ~10k labeled tiles in FL/TX/LA/NC.

**Inference:** Pre-computed offline (Member A's GPU notebook) for all 10k properties; uploaded to Vercel Blob as a single parquet file. Read by the Next.js inference endpoints at request time.

**Owner:** Member A.

### 5.2 XGBoost Loss-Severity Model

**Input features (per (policy, scenario) pair):**

- Property risk features (8 dims from §5.1)
- Structured: TIV, build_year, build_type, flood_zone (FEMA NFHL), elevation, ZIP-level demographics
- Scenario features: peak wind speed at property, storm surge depth (HAZUS proxy), distance from track centerline, time from landfall, hurricane category

**Output:** Expected $ loss per (policy, scenario) draw — continuous regression, with quantile heads (p10/p50/p90) for tail estimation.

**Training objective:** Pinball loss; three separate XGBoost models for p10/p50/p90 (XGBoost 1.7+ supports `reg:quantileerror` in a single model — preferred path).

**Training data:** NOAA Storm Events DB 2018–2024 joined to a synthetic policy book where loss outcomes are generated by HAZUS-style depth-damage curves (publicly published by FEMA). Realistic enough for class evaluation; explicitly flagged as synthetic in the eval slide.

**Hyperparameter tuning:** Optuna, 100 trials, 5-fold time-stratified CV by year.

**Artifact storage:** Pickled to `~5MB`, uploaded to Vercel Blob.

**Owner:** Member B.

### 5.3 Scenario Generator + LLM Agent

**LLM stack (cascading failover, mirrors RolePrep.ai's proven pattern):**

- **Primary:** OpenRouter — `openai/gpt-4.1` or `openai/gpt-4o-2024-11-20`, configurable via `LLM_PRIMARY_MODEL` env var
- **Fallback:** GitHub Models PAT — `gpt-4o` or `gpt-4o-mini` (free tier, generous quota)
- **Retry policy:** 3 attempts per provider with exponential backoff (500ms → 1500ms) on HTTP 429/500/503/504
- **Failover trigger:** Persistent 5xx, rate-limit exhaustion, or context-length errors
- **Transport:** Vercel Edge Runtime for chat streaming (SSE); Node runtime for tool-calling endpoints

**Tools the agent exposes (TypeScript implementations in `/api/agent/tools/*`):**

| Tool | Returns |
|---|---|
| `fetch_nhc_cone(storm_id)` | Current 5-day cone GeoJSON + ensemble track samples |
| `fetch_firms_fires(bbox, hours)` | Active fire detections in the last N hours |
| `fetch_fema_declarations(state, since)` | Recent disaster declarations |
| `fetch_storm_events(state, since)` | Recent storm event records |
| `generate_scenarios(threat_id, n=1000)` | Monte Carlo realizations: `[{path, peak_wind, surge_grid, prob}]` |
| `query_book_exposure(zip_list)` | Total insured value in the carrier's book by ZIP |
| `draft_sitrep(threat_id, posture_summary)` | Markdown sitrep memo |

**Scenario generation logic:** Sample 1000 realizations from NHC's GEFS ensemble track files (publicly available through NCEP/NOMADS) + perturb wind speed using historical NHC forecast error distributions. Each realization carries a probability weight.

**Why an agent and not just a script:** The cat-ops VP asks free-form questions ("what if the cone shifts 50 miles east?", "what's our Tampa exposure if this becomes a 4?"). The agent orchestrates the right tools in response.

**Owner:** Member C.

### 5.4 Portfolio MIP

**Decision variables:** For each *cohort* (ZIP3 × build_type × TIV bucket — ~300 cohorts for 10k policies), the share allocated to each action: `x_{c, a} ∈ [0,1]` for `a ∈ {retain, reprice_up, reprice_down, non_renew, cede_qs, cede_xs}`, with `Σ_a x_{c,a} = 1`.

**Cohort aggregation is critical:** 10k policies × 6 actions = 60k binaries would not solve in Vercel's 60s serverless limit. 300 cohorts × 6 fractional actions = 1.8k continuous variables solves in <5 seconds.

**Objective:** Maximize *E[Premium − Loss − Cession Cost]* across the scenario set, weighted by scenario probability.

**Constraints:**

- **Capital:** Scenario-weighted VaR_99 across the book ≤ available capital
- **Concentration:** Max % TIV per ZIP3, per county, per state
- **Customer continuity / regulatory:** Max % non-renew per state per quarter (FL, CA caps)
- **Cession economics:** Total cession premium ≤ cession budget

**Solver:** PuLP with CBC (both open source, both compile on Vercel's Python runtime).

**Per-policy mapping:** After cohort-level optimization, fractional allocations are rounded to per-policy actions deterministically (e.g., by ranking within cohort by loss-severity p90).

**Owner:** Member B.

### 5.5 Operational VRP

**Decision variables:** For each adjuster *a*, each staging zone *z*, each day *d*: `y_{a,z,d} ∈ {0,1}`. With ~50 adjusters, ~20 zones, 7-day horizon, total = 7,000 binaries.

**Objective:** Minimize *E[response_time]* weighted by scenario probability and expected claim volume per zone.

**Constraints:**

- Each adjuster assigned to exactly one zone per day
- Staging zone capacity (hotel beds, parking)
- Drive time from home base to zone ≤ 8 hours
- Skill requirements: zones expecting flood claims need flood-trained adjusters

**Coupling to portfolio:** zones where the MIP non-renewed cohorts get de-weighted in the VRP objective (no longer the carrier's claims).

**Solver:** OR-Tools VRP solver, <5s for this size on Vercel Python runtime.

**Owner:** Member B + Member C shared.

### 5.6 Decision Reconciler

A thin module that runs after MIP + VRP and resolves cross-lever conflicts:

- Remove non-renewed cohorts from the pre-flag claims queue.
- Remove ceded policies' loss from the VRP demand-weighting (the reinsurer's adjusters handle them).
- Flag conflicts for the manager (e.g., MIP says "non-renew this ZIP", VRP says "high demand zone" — surface this).

**Owner:** Member D.

### 5.7 Next.js UI on Vercel

**Stack:** Next.js 16 (App Router) + React 19 + TypeScript + Tailwind. Mapbox GL JS for maps. Server Components where possible. Edge Runtime for LLM streaming; Node runtime for orchestration; Python runtime for optimization.

**Three views sharing a common map base:**

**View 1 — Portfolio Map** (`/portfolio`)
- Choropleth of TIV by ZIP, recolored by MIP recommendation
- Click ZIP → drill-down: list of policies, MIP action, SHAP driver
- Slider: scenario probability threshold

**View 2 — Event Console** (`/events`)
- Map: active NHC cones + FIRMS fires + selected scenarios
- Side panel: LLM-drafted sitrep memo (markdown, streamed)
- "Ask FORGE" chat input (agent tool calls, SSE)
- Re-run button: re-pulls live feeds and re-solves

**View 3 — Claims Pre-Brief** (`/claims`)
- Table of pre-flagged policies inside 80% cone-probability zone
- Expected severity tier per policy
- Export to CSV

**Refresh cadence:** Vercel Cron at `*/15 * * * *` re-pulls NHC + FIRMS + NOAA. On-demand re-solve <10s end-to-end for 10k policies (cohort-aggregated).

**Owner:** Member D.

### 5.8 Backend / Inference Service (within the Next.js project)

Mirroring RolePrep.ai's architecture — all backend lives inside the Next.js project as API routes, no separate service:

**Pre-computed artifacts (offline, refreshed nightly by a GitHub Action):**

| Artifact | Storage | Size |
|---|---|---|
| CV property features (10k × 8 dims) | Vercel Blob, parquet | ~1 MB |
| XGBoost models (p10/p50/p90, pickled) | Vercel Blob | ~5 MB |
| Synthetic policy book | Turso (libSQL) | ~10 MB |

**On-demand endpoints:**

| Route | Runtime | Latency target | Purpose |
|---|---|---|---|
| `/api/agent/chat` | Edge (streaming) | First token <1s | LLM agent w/ tool calls |
| `/api/feeds/nhc` | Node | <2s | Fetch + parse current NHC cones |
| `/api/feeds/firms` | Node | <2s | Fetch + parse FIRMS active fires |
| `/api/scenarios` | Python | <3s | Generate 1000 MC scenarios from cone |
| `/api/optimize/portfolio` | Python | <5s | Solve cohort-MIP |
| `/api/optimize/vrp` | Python | <5s | Solve adjuster VRP |
| `/api/reconcile` | Node | <1s | Cross-lever conflict resolver |
| `/api/cron/refresh` | Node | — | Vercel Cron, 15-min cadence |

**Auth:** Magic-link sessions (HMAC-signed), same pattern as RolePrep. Read-only demo mode for the class panel.

**Owner:** Member B (Python optimize endpoints) + Member C (LLM + feed endpoints) + Member D (route plumbing).

---

## 6. Data sources

| Source | Cadence | Cost | Purpose |
|---|---|---|---|
| Sentinel-2 L2A (Microsoft Planetary Computer) | 5-day revisit | Free | CV input |
| NASA FIRMS active fire | ~3-hour latency | Free | Wildfire event labels |
| NOAA NHC cones + GEFS ensemble | Live during named storms | Free | Scenario generation |
| NOAA NCEI Storm Events DB | Monthly, ~2mo lag | Free | Loss-model training labels |
| OpenFEMA disaster declarations | Daily | Free | Historical event context |
| FEMA NFHL flood zones | Quarterly | Free | Structured policy features |
| NOAA U.S. Climate Normals | Weekly | Free | Climate baseline |
| OpenStreetMap | Continuous | Free | Building footprints, OSM-labels for CV |
| USGS NLCD impervious surface | 5-year | Free | CV weak labels |
| LANDFIRE fuel layers | Annual | Free | CV weak labels |
| Zillow Research ZHVI | Monthly | Free | TIV proxy |
| Census ACS 5-year | Annual | Free | ZIP-level demographics |

**Training/test split:** Train on 2018–2024 events; hold out **2025 + 2026 to-date** for evaluation.

**Demo event policy:** Whichever named storm or wildfire is active during demo week is the live demo; if no active threat, replay 2024 Helene or Milton from cached NHC archives as a backup.

---

## 7. Evaluation

The class assignment asks "how do we know the model is useful?" — we'll evaluate at three levels:

### 7.1 Component-level
- **CV:** Held-out MAE for each of the 8 feature dimensions vs OSM/NLCD/LANDFIRE labels
- **XGBoost loss model:** MAE, RMSE, and CRPS (continuous-ranked probability score, since we have quantile heads) on held-out 2025 events
- **LLM scenario generator:** log-likelihood of realized 2025 hurricane tracks under FORGE's generated scenario distribution (proper scoring rule)

### 7.2 Decision-level
- **Portfolio MIP:** Ex-post P&L of FORGE-recommended posture vs naive "retain everything" baseline, evaluated on 5 holdout 2025 events. Industry loss outcomes from NOAA's billion-dollar disasters list serve as ground truth.
- **VRP:** Simulated response time under FORGE's pre-positioning vs static home-base policy.
- **End-to-end:** For each of 5 holdout events, freeze FORGE's recommendation 14 days pre-landfall and compute realized P&L delta.

### 7.3 User-level
- 3 mock cat-ops VPs (recruited from MEM ops faculty / industry contacts) run FORGE for one scenario; we measure decision-time reduction vs the current 3-hour meeting and qualitative trust calibration.

---

## 8. Limitations

| Limitation | Why it's acceptable for v1 | What real deployment needs |
|---|---|---|
| Synthetic policy book | Real carriers won't share book pre-class | Partnership with a carrier or MGA |
| HAZUS-style depth-damage curves for loss labels | Industry standard, publicly published | Validated against carrier's own claim outcomes |
| Hurricanes only (no wildfire, earthquake, severe convective) | Scope; hurricane is the highest-$ peril | Multi-peril extension |
| Pre-trained satellite backbone may underperform in rare biomes | Continental U.S. is well-covered by Prithvi/Clay training data | Domain-specific fine-tuning |
| LLM scenario generation is calibration-dependent | We will report calibration plots | Hierarchical Bayesian post-calibration |
| Cohort aggregation in MIP loses per-policy granularity | 10k policies is small enough that cohorts ≈ true policy heterogeneity | Column generation or Benders decomposition at carrier scale |
| Vercel serverless 60s timeout | Cohort aggregation keeps every endpoint <10s | Dedicated compute (Modal, Fargate) at scale |
| No auth beyond demo magic-link | Class demo, not production | RBAC, audit log, SOC 2 |
| Pricing actions don't model competitive response | Single-carrier optimization | Game-theoretic extension with competitor reaction |

---

## 9. Team split (4 members, names TBD)

| Member | Owns |
|---|---|
| **A — Satellite / CV** | §5.1 Property Risk CV, training data pipelines, OSM/NLCD weak labels, nightly artifact upload to Vercel Blob |
| **B — Modeling / Optimization** | §5.2 XGBoost loss model, §5.4 Portfolio MIP, `/api/optimize/*` Python endpoints, shares VRP with C |
| **C — LLM Agent / Data feeds** | §5.3 Scenario generator + LLM cascading client + tool implementations, §5.5 VRP shared with B, `/api/feeds/*` and `/api/agent/*` |
| **D — UI / Evaluation / Deploy** | §5.6 Decision reconciler, §5.7 Next.js UI, §5.8 route plumbing, Vercel deploy + cron, §7 evaluation harness, slide deck |

---

## 10. Week-by-week plan

| Day | Goal |
|---|---|
| **Mon** | Next.js scaffold deployed to Vercel (empty pages + Tailwind); Turso DB provisioned; OpenRouter + GitHub Models keys in env; data ingest scripts working for all feeds; pre-trained satellite backbone selected; synthetic policy book seeded (10k rows) |
| **Tue** | CV head training started (Member A on local GPU); XGBoost baseline trained on first cut of synthetic book; LLM agent skeleton + 3 tool calls implemented behind `/api/agent/chat` with cascading failover; Mapbox base map rendering in `/events` |
| **Wed** | CV inference cached as parquet in Vercel Blob; XGBoost re-trained with CV features; MIP formulation working on 300-cohort subset; `/portfolio` page wired; agent chat streaming end-to-end |
| **Thu** | MIP solving inside `/api/optimize/portfolio` <5s; VRP solving inside `/api/optimize/vrp` <5s; reconciler logic; `/events` page with cone overlay + sitrep memo; agent answers "what's our Tampa exposure" with real tool calls |
| **Fri** | End-to-end demo working on a single live cone or replayed Helene/Milton; eval harness running on 2025 holdout events; deploy preview shared internally |
| **Sat** | Eval results captured; slide deck v1; rehearsal; performance tuning (cohort aggregation tuning, Edge caching) |
| **Sun** | Polish; rehearsal; record backup demo video in case live demo fails |
| **Mon (class)** | Present |
| **Tue (due)** | Final submission |

---

## 11. Slide deck outline (10 slides)

1. **Title** — FORGE · Forecast-driven Operational Risk Governance Engine
2. **Business problem** — The Monday cat-ops meeting (current state) → coupled-decision state (FORGE)
3. **Manager persona** — VP, Catastrophe Operations
4. **Data** — Live-feeds inventory table; recency call-out (Sentinel-2 5-day, FIRMS 3-hour, NHC live)
5. **Model** — 5-layer architecture diagram (Section 4 of this spec)
6. **Decision logic** — How the shared scenario set couples portfolio + VRP + claims-prep
7. **Interface** — Three Next.js screenshots (Portfolio Map, Event Console, Claims Pre-Brief) + agent chat
8. **Evaluation** — Component metrics + ex-post P&L on 5 holdout 2025 events
9. **Limitations** — Honest scope cuts + what real deployment needs
10. **Q&A** — Plus a backup slide with "what we'd build next" (multi-peril, real carrier partnership, game-theoretic competitor model)

---

## 12. Out of scope (explicit cuts)

- Multi-peril (wildfire, earthquake, severe convective) — hurricane only in v1
- Real-time CV streaming (we pre-compute nightly via GitHub Action)
- Multi-tenancy (single demo tenant)
- Reinsurance treaty modeling beyond simple quota-share and XoL
- Competitor pricing reaction modeling
- Mobile UI (desktop-first; responsive ≥768px)
- Anything outside U.S. coastal states

---

## 13. Resolved decisions

| Decision | Resolution |
|---|---|
| LLM provider | OpenRouter (GPT primary) + GitHub Models PAT (fallback), cascading failover mirroring RolePrep.ai |
| Hosting | Vercel — Next.js with mixed Edge/Node/Python runtimes, Turso for state, Vercel Blob for ML artifacts |
| Team names | TBD — populate before submission |
| Policy book size | 10k policies, cohort-aggregated to ~300 cohorts for MIP |
| Demo event | Live during demo week; replay 2024 Helene or Milton as backup if no active threat |
