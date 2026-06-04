# FORGE — Live Monte Carlo Simulation on Vercel

**Date:** 2026-06-04
**Status:** Approved design — pending implementation plan
**Branch:** `feat/vercel-live-sim`
**Goal:** Deploy FORGE to Vercel as a portfolio showcase where a visitor can draw a
peril footprint and see the **full K=1000 Monte Carlo loss distribution** computed
live in the cloud, while the heavy portfolio optimization stays precomputed.

---

## 1. Goal & scope

A visitor opens the deployed URL, draws a peril footprint on the map, picks
severity, and receives — **computed live in the cloud**:

- the expected-loss preview (already pure TypeScript), and
- the **full K=1000 Monte Carlo loss distribution** for that scenario: a
  histogram plus mean, P99, and TVaR-99.

The Portfolio MIP stays **precomputed** and served from the tracked
`artifacts/portfolio_optimization.json`; the methodology page explains that the
~10-minute CBC solve exceeds serverless function limits and therefore runs
offline. All read-only views serve from Turso + tracked artifacts.

This is a deliberate showcase target for employers and professors: the
intellectually substantive part (correlated Monte Carlo with HAZUS-calibrated
severity, TVaR tail) runs live and reproducibly; the part that genuinely cannot
live in a 300s function is architected around honestly.

## 2. Architecture

Three runtimes — as today — with exactly one runtime-crossing call rewired:

- **Node runtime** — all Next.js routes + pages (Turso reads, artifact reads,
  agent chat).
- **One Vercel Python function** — `api_py/sim_loss.py`, invoked over HTTP by the
  promote route in production.
- **Offline (local, not on Vercel)** — the portfolio precompute writes the tracked
  artifacts; unchanged.

**No losses persisted online.** The K=1000 distribution is deterministic from
`sim_id` + footprint + policies (`generate_sim_losses` is seeded by `sim_id` →
bit-identical output), so it is recomputed on demand (seconds) and rendered. The
footprint *row* is persisted — `POST /api/sim` already does this — so sims appear
in the library and re-open reproducibly. Consequence: **no Vercel Blob and no
losses table are required.**

## 3. Component changes

### 3.1 `api_py/sim_loss.py` — handler returns the distribution
Today the `handler.do_POST` calls `write_artifact` (disk) and returns
`{K, n_cohorts, artifact_path}`. Changes:

- Make the parquet write **conditional** so it is skipped on the read-only Vercel
  filesystem. The `pyarrow` import is already local to `write_artifact`, so when
  the function never calls it, `pyarrow` is not needed at runtime.
- Add to the response, via a shared `_summarize(result)` helper, an explicit
  contract:
  - `histogram`: `{bin_edges: float[B+1], counts: int[B]}` computed server-side
    in numpy over the K=1000 portfolio-level totals (`losses.sum(axis=0)`). This
    is what the chart renders; the raw K-vector is **not** sent (payload
    discipline).
  - `summary`: `{mean, p50, p90, p99, tvar99, min, max}`, also computed
    server-side so the client never re-derives the tail.
- `_summarize` feeds **both** the HTTP handler and the `_solve_stdin` dev path so
  the two invocation routes never drift.
- The offline `generate_sim_losses` + `write_artifact` path stays intact for the
  portfolio precompute.

**Cohort keying — verified, no change.** The handler already builds the
production cohort keyer (`from api_py.cohort_keys import cohort_key,
policy_quintile_lookup`; `cohort_keyer=lambda p: cohort_key(p, quintile_by_id[id])`)
with a book-wide quintile lookup, so the live function's correlated tail matches
the precompute's `{zip3}_{build_type}_q{quintile}` cohorts.

### 3.2 `app/api/sim/[id]/promote/route.ts` — env-gated invocation
- **Dev** (`npm run dev`, no `VERCEL` env): keep the existing
  `spawn('python', ['-m','api_py._solve_stdin','sim_loss'])` path — fast, no
  network, preserves the local workflow.
- **Prod** (on Vercel): `fetch(${base}/api_py/sim_loss, {method:'POST', body})`
  with `base` derived from `process.env.VERCEL_URL`. Parse the same JSON, now
  including the distribution.
- Both paths return the distribution to the client and set `promoted = 1` in
  Turso. In prod, the route no longer depends on a successful parquet write.

### 3.3 New UI — `components/sim/LossDistribution.tsx`
A lightweight inline-SVG histogram + stat callouts (mean / P99 / TVaR-99),
rendered inside `ImpactPanel` after a successful promote, below the existing
expected-loss preview. No new charting dependency. `PromoteButton` passes the
returned `summary` + histogram into the panel.

### 3.4 `requirements.txt` split
Move offline-solve-only deps (`pulp`, `ortools`, `xgboost`, `optuna`,
`scikit-learn`, `matplotlib`, `pandas`, `joblib`, `pyarrow`) into a new
`requirements-precompute.txt`. Leave `requirements.txt` = the Vercel-runtime
essentials for `sim_loss`: `numpy`, `scipy`, `shapely`, `requests`. This shrinks
the Python function bundle under the size limit and matches the repo's existing
"don't bundle offline deps into Vercel functions" rule. Update the CLAUDE.md
build cheatsheet to reference the new file.

### 3.5 `vercel.json` — scope the Python function
Narrow the functions glob from `api_py/*.py` to just `api_py/sim_loss.py` (the
only handler invoked online) so Vercel does not build/deploy the heavy
`optimize_portfolio` / `optimize_vrp` / `scenarios` functions (which need
`pulp`/`ortools` and would bloat or fail the build). Keep the agent chat Node
runtime entry. Cron stays (see §5.3).

## 4. Data flow (live sim)

1. User draws footprint on `/simulate` → `POST /api/sim` → Turso row inserted +
   TS `previewImpact` returns expected loss → `ImpactPanel` shows it immediately.
2. User clicks Promote → `POST /api/sim/[id]/promote` → (prod) HTTP to
   `/api_py/sim_loss` with `{sim_id, footprint, policies, K=1000}` → numpy MC
   (seconds) → `{summary, histogram}` → route sets `promoted = 1`, returns the
   distribution → `LossDistribution` renders the histogram + tail stats.

## 5. Provisioning & deployment

### 5.1 Database (Turso)
- Provision Turso (Vercel Marketplace or Turso CLI); set `TURSO_URL` +
  `TURSO_AUTH_TOKEN`.
- **Seeding path:** `scripts/seed_policy_book.py` writes a local SQLite file via
  `sqlite3.connect` — it does **not** talk to libSQL/Turso. So: seed locally →
  produce `forge-local.db` → import that database into Turso (libSQL dump/restore
  or `turso db shell < dump.sql`). `cv_features` stays NULL by design (the
  Portfolio drill-down shows the honest "CV head not run on real chips" callout).
- Run the portfolio precompute locally and commit the refreshed artifact so the
  deployed `/portfolio` page has data.

### 5.2 Environment variables (Vercel)
- Required: `TURSO_URL`, `TURSO_AUTH_TOKEN`.
- Optional (mock fallbacks exist): `OPENROUTER_API_KEY` or `GITHUB_MODELS_PAT`
  (agent), `NASA_FIRMS_KEY`, `NOAA_NCEI_TOKEN`.
- `CRON_SECRET` if cron is kept.
- Not needed: `BLOB_READ_WRITE_TOKEN` (no online persistence),
  `NEXT_PUBLIC_MAPBOX_TOKEN` (basemap is MapLibre + OpenFreeMap — Mapbox banned).

### 5.3 Cron
`/api/cron/refresh` is **Node-only** (verified: no Python spawn). Keep it; it
needs `CRON_SECRET`, and the `*/15 * * * *` cadence requires the Pro plan (Hobby
caps cron frequency — drop to daily there). Confirm it performs no writes to
`artifacts/` (read-only FS) during planning.

### 5.4 Link & deploy
`vercel link` (no `.vercel` dir exists yet) → set env → deploy. Validate with
`vercel dev` locally first (it serves the Python function over HTTP, exercising
the prod invocation path).

## 6. Error handling

- Function 5xx / fetch failure → route returns 502; UI shows "loss model
  unavailable" — **no fabricated numbers** (data-integrity rule).
- Empty footprint / no policies inside the geometry → all-zero distribution; UI
  shows an honest "no policies affected."
- Dev without Python → existing spawn error path, unchanged.
- Determinism: identical `sim_id` reproduces an identical distribution.

## 7. Testing

- **Python** (`tests/api/test_sim_loss.py`): handler response includes a `summary`
  with correct P99/TVaR on a known seed; parquet write is skipped when the
  persistence flag is off; the function path and the offline `generate_sim_losses`
  produce identical `losses` for a fixed `sim_id` (golden).
- **TS** (`tests/api/sim/promote`): mock the prod `fetch` path and the dev `spawn`
  path; assert the distribution passes through. Component test for
  `LossDistribution` (jsdom) rendering bins + stats.
- **Gate:** `npm run build` + `npm test` green; manual `vercel dev` smoke before
  promoting to prod.

## 8. Non-goals (explicit)

- Live portfolio reoptimize (stays precomputed; methodology explains the 300s
  limit).
- Persisting K=1000 losses online (deterministic recompute instead).
- Deploying the other Python functions (`optimize_portfolio` / `optimize_vrp` /
  `scenarios`) — offline only.

## 9. Resolved verification notes

- **Cohort keyer** — handler already uses the production keyer; no change (§3.1).
- **Cron** — Node-only, no Python spawn; safe to keep (§5.3).
- **Seeding** — seed script is SQLite-file only; Turso load is a seed-local →
  import step (§5.1).
