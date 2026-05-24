# FORGE

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20368096.svg)](https://doi.org/10.5281/zenodo.20368096)

**Forecast-driven Operational Risk Governance Engine**

A catastrophe decision intelligence platform for U.S. P&C insurance carriers. FORGE collapses the Monday cat-ops meeting — meteorology brief, actuarial run, field-ops spreadsheet, reinsurance model — into one scenario-coupled console where portfolio, operations, and claims decisions all consume the same Monte Carlo scenario set.

> *"Forge the posture before the cone shifts."*

---

## What FORGE does

One decision, three coupled levers, all driven from the same live forecast distribution:

| Lever | Action options | Horizon | Solver |
|---|---|---|---|
| **Portfolio** | retain · 7-bucket reprice rate grid (−20% … +20%) · non_renew · cede_qs · cede_xs | 30–90 days | PuLP + CBC MIP |
| **Operations** | adjuster → staging zone × day assignment | 24–72h pre-landfall | PuLP + CBC LP |
| **Claims pre-flag** | tier policies inside the cone by severity | 24–72h pre-landfall | Heuristic |

A **Decision Reconciler** runs after MIP + VRP to drop non-renewed cohorts from the pre-flag queue, net cession out of VRP demand, and surface manager-visible conflicts.

---

## Architecture

```
Live feeds  ──►  Scenario set  ──►  XGBoost loss head  ──►  ┌─ Portfolio MIP  ─┐
(NHC,                                                       │                  │
FIRMS,                                                      ├─ Operational LP ─┤  ──► Reconciler ──► Next.js UI
NCEI,                                                       │                  │
FEMA,                                                       └─ Pre-flagger    ─┘
Sentinel-2)
```

- **Property risk CV** — Prithvi-100M backbone + 8-dim MLP head, trained on Sentinel-2 chips on Apple Silicon (MPS). Features pre-computed per policy and cached in Turso.
- **XGBoost loss model** — three quantile heads (p10/p50/p90) trained on NOAA Storm Events 2018–2024 joined to a synthetic book via HAZUS depth-damage curves.
- **Scenario generator** — Monte Carlo perturbation of NHC GEFS ensemble tracks; 1000 weighted realizations per active threat.
- **LLM agent** — cascading OpenRouter primary + GitHub Models PAT fallback, seven function-calling tools, NDJSON-streamed `/api/agent/chat`.

Full design lives in [`docs/superpowers/specs/2026-05-15-forge-design.md`](docs/superpowers/specs/2026-05-15-forge-design.md). Implementation plan in [`docs/superpowers/plans/2026-05-15-forge.md`](docs/superpowers/plans/2026-05-15-forge.md).

---

## Trust tiers

Every numbered surface in FORGE mounts a `TrustTierBadge` so the reader knows where a value came from. The five tiers are **LIVE_FEED** (this-minute API pull), **MODEL_OUTPUT** (calibrated model), **SYNTHETIC_SCAFFOLD** (placeholder distribution standing in for a real feed), **RECOMMENDATION** (optimizer output), and **MANUAL_OVERRIDE** (human-pinned). The grammar contract, magic-constant calibration plan, and `cede_xs` / TVaR-99 / VRP-integrality defenses live in [`docs/methodology.md`](docs/methodology.md) and at `/methodology` in the running app.

---

## Tech stack

- **Web:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind · MapLibre GL JS / react-map-gl
- **DB:** Turso (libSQL) in prod; SQLite file (`forge-local.db`) in dev
- **ML / opt (Python 3.12):** XGBoost · Optuna · PuLP + CBC · OR-Tools · PyTorch + timm · scikit-learn
- **LLM:** OpenRouter (`openai/gpt-4.1`) primary + GitHub Models PAT (`gpt-4o`) fallback, retry + failover in `lib/llm/cascading-client.ts`
- **Test:** Vitest (TS) · Pytest (Python) · Playwright MCP for UI smoke
- **Deploy:** Vercel — Node runtime for routes, Python runtime for `api_py/*`, Vercel Cron every 15 minutes

---

## Repo layout

```
FORGE/
├── app/                       # Next.js App Router
│   ├── page.tsx                       Landing
│   ├── portfolio/page.tsx             View 1 — MIP recommendations on a ZIP3 map
│   ├── events/page.tsx                View 2 — Cone + fires + agent chat + sitrep
│   ├── claims/page.tsx                View 3 — Pre-flagged policies table
│   ├── load/page.tsx                  CSV upload to replace the policy book
│   └── api/
│       ├── agent/chat/route.ts        NDJSON-streamed agent endpoint
│       ├── agent/tools/*.ts           7 tool handlers
│       ├── book/{upload,sample}/      Book ingest + sample CSV
│       └── cron/refresh/route.ts      Vercel Cron — every 15 min
├── api_py/                    # Python serverless functions (Vercel runtime)
│   ├── optimize_portfolio.py          Portfolio MIP
│   ├── optimize_vrp.py                Operational LP
│   └── scenarios.py                   Monte Carlo scenario generator
├── components/                # React client components
├── lib/
│   ├── db/{client,cohorts,migrate,schema.sql,portfolio_optimization}.ts
│   ├── llm/{cascading-client,tool-registry,types}.ts
│   ├── book/csv.ts                    CSV parse + validate
│   ├── reconciler/index.ts            Cross-lever decision reconciler
│   ├── portfolio-actions.ts
│   └── chat-stream.ts
├── ml/                        # Offline training (not bundled to Vercel)
│   ├── cv/{train,inference,data_loaders}.py
│   ├── xgb/{train,synthesize_book,hazus_curves}.py
│   ├── scenarios/generate.py
│   └── upload_artifacts.py
├── scripts/
│   ├── seed_policy_book.py            Synthesize 10k policies → forge-local.db
│   ├── ingest_storm_events.py         NOAA Storm Events 2018–2024
│   ├── cache_s2_chips.py              Pre-fetch Sentinel-2 chips for training
│   ├── populate_cv_features.py        Run trained CV head over 10k chips
│   └── precompute_portfolio_optimization.py
├── eval/                      # Component + decision-level evaluation
│   ├── component_metrics.py
│   ├── end_to_end.py
│   └── results/                       JSON + PNG outputs (gitignored)
├── artifacts/                 # ML artifacts (mostly gitignored)
│   ├── cv_head.pt                     Trained CV head weights
│   ├── xgb_p{10,50,90}.joblib
│   └── portfolio_optimization.json    Cached MIP result
├── tests/
│   ├── api/                   pytest — optimizers, scenarios, agent route
│   ├── lib/                   vitest — db, llm, reconciler
│   ├── components/            vitest + testing-library — React components
│   ├── ml/                    pytest — CV inference, XGB training, scenarios
│   ├── scripts/               pytest — damage parsing
│   └── eval/                  pytest — metric helpers
└── docs/superpowers/{plans,specs}/    Implementation plan + design spec
```

---

## Setup

### Prerequisites

- **Node 20+** (Next.js 16 requires it)
- **Python 3.12** with pip — only needed if you want to run the optimizers, ML, or eval locally; the Next.js UI runs without it using the cached `artifacts/portfolio_optimization.json`.
- An OpenRouter API key *or* a GitHub Models PAT for the agent chat. Without keys, the agent route still parses but every LLM call returns an error.

### Install

```bash
# JS deps
npm install

# Python deps (optional — only if running optimizers / training / eval)
pip install -r requirements.txt
# CV training extras (PyTorch, timm) — heavy, install only on the training box
pip install -r requirements-train.txt
```

### Environment

Copy `.env.example` to `.env.local` and fill in whatever you have:

```
TURSO_URL=                 # leave empty → falls back to file:./forge-local.db
TURSO_AUTH_TOKEN=
BLOB_READ_WRITE_TOKEN=

OPENROUTER_API_KEY=        # primary LLM provider
GITHUB_MODELS_PAT=         # fallback LLM provider

LLM_PRIMARY_MODEL=openai/gpt-4.1
LLM_FALLBACK_MODEL=gpt-4o
LLM_RETRY_MAX=3
LLM_RETRY_BASE_MS=500

NEXT_PUBLIC_MAPBOX_TOKEN=  # optional — needed for the Mapbox basemap style

NASA_FIRMS_KEY=            # optional — without it, fires use mock data
NOAA_NCEI_TOKEN=

CRON_SECRET=               # required for `/api/cron/refresh` in prod
```

### Seed the local DB

```bash
# 1. Create tables (file:./forge-local.db by default)
npm run migrate

# 2. Insert 10k synthetic policies in FL/TX/LA/NC
python scripts/seed_policy_book.py

# 3. Ingest historical storm events (~50–200 per year)
python scripts/ingest_storm_events.py --years 2018-2024

# 4. (Optional) Cache CV features against the policy lat/lons
python scripts/populate_cv_features.py

# 5. (Optional) Pre-compute the Portfolio MIP solution
python -m scripts.precompute_portfolio_optimization
```

### Run

```bash
npm run dev          # http://localhost:3000
npm run build        # production build
npm test             # vitest (TS)
pytest               # all Python tests
```

---

## Routes

| Route | Runtime | Purpose |
|---|---|---|
| `/` | Node | Landing — links to all three views and `/load` |
| `/portfolio` | Node (server component) | ZIP3 choropleth coloured by MIP recommendation; drill-down panel on click |
| `/events` | Node (server component) | Cone overlay + FIRMS fires + sitrep panel + agent chat |
| `/claims` | Node (server component) | Pre-flagged policies inside the demo cone, sortable + exportable |
| `/load` | Node | Upload a CSV to replace the book and re-run the MIP |
| `/api/agent/chat` | Node | POST → NDJSON-streamed agent response with tool-call events |
| `/api/book/upload` | Node (60s) | POST CSV (multipart or text body), replaces `policies` and spawns MIP precompute |
| `/api/book/sample` | Node | GET a 5-row CSV showing the expected schema |
| `/api/cron/refresh` | Node | Vercel Cron — pulls NHC + FIRMS + FEMA every 15 min |
| `api_py/optimize_portfolio.py` | Python 3.12 | POST cohorts → MIP solution |
| `api_py/optimize_vrp.py` | Python 3.12 | POST adjusters + zones → assignment |
| `api_py/scenarios.py` | Python 3.12 | POST storm_id → 1000 weighted scenarios |

---

## Agent tools

The chat endpoint exposes seven tools — every one has a deterministic mock fallback so the UI works without API keys.

| Tool | Returns |
|---|---|
| `fetch_nhc_cone(storm_id)` | 5-day cone GeoJSON + advisory metadata |
| `fetch_firms_fires(bbox, hours)` | Active fire detections in the bbox |
| `fetch_fema_declarations(state, since)` | Recent FEMA disaster declarations |
| `fetch_storm_events(state, since)` | Recent NOAA Storm Events rows |
| `generate_scenarios(storm_id, n)` | Monte Carlo realizations from NHC GEFS perturbation |
| `query_book_exposure(zip_list)` | Σ TIV by ZIP3 from the local book |
| `draft_sitrep(threat_id, posture_summary)` | LLM-drafted markdown SITREP memo |

Registry: `lib/llm/tool-registry.ts`. Handlers: `app/api/agent/tools/`.

---

## Evaluation

```bash
python -m eval.component_metrics    # CV MAE · XGB MAE/RMSE/CRPS · scenario log-likelihood
python -m eval.end_to_end           # 5 holdout 2024-2025 events: FORGE P&L vs naive baseline
```

Outputs land in `eval/results/`. Latest run summary:

- **CV head** — `vegetation_density` MAE 0.34, `water_proximity` 0.24, `elevation_bucket` 0.21 against weak-label proxies
- **XGBoost loss model** — MAE $7.8k · RMSE $15.0k · CRPS proxy $2.4k on a 128k-row holdout
- **End-to-end** — FORGE beats the "retain everything" baseline by **~$372M mean / $1.86B total** across 5 holdout events

See `eval/results/end_to_end.png` for the bar chart.

---

## Deploy

```bash
vercel link
vercel --prod
```

`vercel.json` already wires Python 3.12 for `api_py/*.py` and a 15-min cron on `/api/cron/refresh`. Set the env vars from `.env.example` in the Vercel project settings before promoting to prod.

---

## Citation

If you reference FORGE in academic or industry work, please cite the
dataset card:

```bibtex
@dataset{forge_2026,
  title        = {FORGE -- Synthetic Policy Book + Multi-Peril Scenario Set},
  author       = {Devaraju, Sagar},
  year         = {2026},
  month        = {may},
  publisher    = {Zenodo},
  version      = {0.1.0},
  doi          = {10.5281/zenodo.20368096},
  url          = {https://doi.org/10.5281/zenodo.20368096}
}
```

GitHub's "Cite this repository" sidebar (via `CITATION.cff`) renders this
automatically.

See [`docs/DATASET_CARD.md`](docs/DATASET_CARD.md) for the full
Datasheets-for-Datasets (Gebru et al. 2018) documentation.

## License

- **Dataset + documentation:** CC-BY-4.0 (as declared in
  [`docs/DATASET_CARD.md`](docs/DATASET_CARD.md) and `.zenodo.json`)
- **Code:** no formal license declared yet — treat as
  "all rights reserved" pending an explicit decision
