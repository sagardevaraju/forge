# FORGE — Claude Code working notes

This file teaches Claude Code the conventions and traps of this repo. Optimize edits for these.

## Mental model

FORGE is a **scenario-coupled cat-ops console**. The whole point is that *the same scenario set* drives three optimization layers (Portfolio MIP, Operational LP, Claims pre-flag). When you touch one layer, ask whether the change should propagate through the **Decision Reconciler** (`lib/reconciler/index.ts`) before it reaches the UI.

The codebase is a **single Next.js 16 monorepo** that mixes runtimes on Vercel:

- TypeScript routes in `app/api/**` run on the **Node runtime** (`runtime = 'nodejs'`). The agent chat route used to be `edge` per the original plan but was moved to Node because `@libsql/client` needs fs access for the local SQLite fallback.
- Python optimizers + scenario generator live in `api_py/*.py` and run on **Vercel's Python 3.12 runtime**. Each module exposes a module-level `solve()` (importable + unit-testable) and a `class handler(BaseHTTPRequestHandler)` that wraps it for Vercel. Keep both.
- Offline ML training lives in `ml/`. **Never bundle `ml/` deps into Vercel functions** — they go in `requirements-train.txt`, not `requirements.txt`. `requirements.txt` is what Vercel installs.

## Data integrity — every value traces to a real source

**No fictional, fabricated, or "cooked up" data.** Any number or lookup shown
in the UI or fed into decision logic must be **computed from a real source** —
the SQLite DB, a tracked `artifacts/*.json`, or a live feed — never hand-coded
to merely look plausible.

- Prefer a DB/artifact-derived value over a hardcoded constant. A hand-coded
  table silently drifts from the data and lies: the old `ZIP3_CENTROIDS` table
  claimed to be "derived from the seed" but plotted map markers 100–460 km from
  where policies actually sit. Map centroids now come from
  `lib/db/zip3_centroids.ts` (`AVG(lat),AVG(lon) GROUP BY zip3`).
- Treat any "hand-coded", "approximate", or "derived from the seed" docstring
  as a smell — verify it against the live data before trusting it.
- If a placeholder is genuinely unavoidable, label it honestly **in the UI**
  (not just a buried docstring) and use the correct trust tier — a `LIVE_FEED`
  badge over mock data is a bug. Check `source === 'mock'` and downgrade.
- The seed (`scripts/seed_policy_book.py`) samples each policy's lat/lon from a
  single per-state Gaussian and assigns `zip3` independently — so a `zip3` is a
  label with **no real-world geographic meaning**. Never map a `zip3` to a
  real-world place; derive its position from the policy coordinates.
- Acceptable: the synthetic seed itself, and the agent-tool mock fallbacks
  (mandated below — they surface a "Mock" chip). Fabricated values
  *masquerading* as real or computed are not.

## DB

- `lib/db/client.ts` resolves `TURSO_URL` → libSQL remote, falling back to `file:./forge-local.db` when unset. Local dev uses the file; prod uses Turso. **Both code paths must work** — don't write SQL that depends on libSQL-only features.
- Schema lives in `lib/db/schema.sql`. Run `npm run migrate` (which executes `lib/db/migrate.ts`) to apply it. The migrate script splits on `;` — keep statements one-per-line and avoid semicolons inside string literals.
- `cv_features` on `policies` is a JSON-encoded string of 8 floats. `lib/db/cohorts.ts` parses + averages them per cohort. If the field is null or malformed, the cohort just gets a zero vector — that path is exercised by the tests.

## Cohorts

`aggregateCohorts()` (`lib/db/cohorts.ts`) is the canonical TS implementation; `eval/end_to_end.py` ships a Python re-implementation. **Both must stay in sync** — same key (`{zip3}_{build_type}_q{0..4}`), same quintile cut-points (computed over the entire book, not per-state), same modal-flood-zone tie-break (lexical order). The cohort field is `tiv_quintile` (Task 12 renamed it from the historical `tiv_decile`); the value range is `0..4`.

## Sim peril severity (lib/sim/severity.ts ↔ api_py/sim_loss.py)

Per-peril severity scales live in `PERIL_SCALES` (TS) and `_PERIL_LEVEL_MULT` (Python). Damage = `HAZUS_base[build_type][peril] × multiplier(severity)`, clamped to [0,1]. **The TS and Python copies must stay in sync** — they are tested independently and one drifting silently inflates / deflates gross loss.

**Live promote runs in-process (TS), not Python.** `app/api/sim/[id]/promote/route.ts` computes the K=1000 loss distribution in-process via `lib/sim/loss-model.ts` (a verified TS port of `api_py/sim_loss.py`) — no spawn, no HTTP — because Vercel can't deploy a standalone Python function inside this Next.js app. `api_py/sim_loss.py` stays the **offline** source of truth for the portfolio precompute/reoptimize; the two are held in parity by the golden test in `tests/lib/sim/loss-model.test.ts`. When you change a severity multiplier, update both copies (per the table below) so the live route and the offline precompute agree.

**Calibration convention** (research.md is the citation file — every numeric value has a published source):

- **Top realistic tier → multiplier = 1.0 = HAZUS-severe damage.** Hail 45 mm = `severe` = 1.0; dNBR `high` = 1.0; NWS `major` flood = 1.20 (slightly past severe — multi-floor); WSSI `extreme` = 1.0; Mw 7.0 = 1.0; EF3 = 1.0. `HAZUS_base × 1.0` is intended to land on the HAZUS-severe damage ratio for that build_type.
- **Lower tiers reflect physical reality, NOT a 1:1 INTENSITY_SCALE spine relabel.** Hail 20 mm = 0 (damage threshold); WSSI Minor = 0.04 (industry baseline pipe-burst rate); dNBR Low = 0.10 (minimal structural impact); NWS Minor = 0.25 (nuisance inundation). The original spine map (every Minor → multiplier 0.55) produced sub-threshold *phantom damage* — pea hail = $10M, dNBR-Low burn = 50 % wood-frame damage, WSSI Minor = $21M on the FL book. **If you find yourself writing `multiplier: INTENSITY_SCALE.moderate` for a sub-threshold tier, stop and cite real claim data instead.**
- **`severityFromLegacy` uses closest-multiplier search**, not exact match. The round-trip property `legacyTier(severityFromLegacy(t)) === t` is intentionally lossy at `catastrophic` for flood / wildfire / winter (those scales cap below the legacy spine's catastrophic multiplier 1.45 by design).
- **`HAZUS_MATRIX` is a per-build-type table at the *severe* benchmark**, sourced from FEMA HAZUS-Wind / HAZUS-Flood / IBHS / FEMA P-957 (winter snow load). If you add a build_type, **mirror it in both files** and add a citation to `research.md`. The `manufactured` flood base was previously 0.45 (inverted from reality — HAZUS Flood TM 4.0 puts MH curves *above* wood frame); raised to 0.65 to match the upper end of the MH depth-damage curve.
- **Earthquake multiplier zeros out below Mw 5.53** (Bakun-Wentworth zero-crossing for MMI VI). Don't add a `max(0.05, …)` floor — that's how M5.0 quakes used to produce phantom 3.5 % wood-frame damage inside the geometry-side `MIN_BUFFER_KM = 0.5` guard circle.

**Operator-facing labels:** `PERIL_LABELS` / `perilLabel()` in `lib/sim/severity.ts` are the single source of truth for every renderer (PerilPicker, SimWorkspace sim-name generator, SimulationBanner). Internal peril ids stay snake_case (`winter`, `wildfire`, …) in the DB / parquet / reconciler keys; labels are display-only. **Notable mismatch:** the `winter` peril id renders as **"Winter Storm"** — covers the full WSSI scope (blizzards + ice storms + flash freezes + heavy snow + lake-effect, not just blizzards), matching PCS / AIR / RMS / Verisk industry classification and pairing cleanly with WSSI = Winter **Storm** Severity Index.

## Portfolio MIP

`api_py/optimize_portfolio.py::solve()` runs PuLP with CBC and a 30-second timeLimit. **Don't add new actions casually** — Phase 2 (Task P2.8) fixed the action set at eleven: `retain`, the 7-bucket reprice rate grid (`reprice_n20`, `reprice_n10`, `reprice_0`, `reprice_p5`, `reprice_p10`, `reprice_p15`, `reprice_p20`), `non_renew`, `cede_qs`, `cede_xs`. The canonical TS list lives in `lib/portfolio-actions.ts` (`ACTIONS` + `ActionName` + `RATE_GRID`); the Python mirror is `api_py/optimize_portfolio.py::ACTIONS` + `RATE_GRID`. The reprice coefficient is no longer a per-key constant — it's computed per cohort from `_reprice_factor(Δrate, η)` where `η` is the cohort's retention elasticity. `LOSS_FACTOR` and `CESSION_COST_RATE` are still per-key dicts; if you add a key, update both, plus `lib/portfolio-actions.ts` (ACTIONS, RATE_GRID, ACTION_LABELS, ACTION_COLORS).

The capital constraint uses **TVaR-99** (per Task P2.6 — mean of the top 1% of scenario losses, not the single VaR-99 quantile) as the retained-tail measure. Per Task P2.7 the per-cohort retained tail is computed scenario-by-scenario from the K=1000 lognormal draws on each cohort, with `cede_xs` cohorts zeroed out (XS attaches below p99, so retained tail exposure is ~0 for ceded cohorts). Don't "fix" this.

`scripts/precompute_portfolio_optimization.py` calls `solve()` over the live book and writes `artifacts/portfolio_optimization.json`. The web UI (`app/portfolio/page.tsx`) reads this file — there is no on-request Python invocation in dev. When the book changes (via `/api/book/upload` or `seed_policy_book.py`), this script must run.

## LLM cascading client

`lib/llm/cascading-client.ts` retries on 429/500/502/503/504 with exponential backoff, then fails over from primary (OpenRouter) to fallback (GitHub Models PAT). Don't widen the retry-status set without thinking about it — 4xx body errors should *not* trigger a fallback because the same payload will fail at both providers.

Tool calls go through `lib/llm/tool-registry.ts`. To add a tool: create `app/api/agent/tools/<name>.ts`, export it from `index.ts`, and add it to `TOOLS` in the registry. Every tool **must** carry a mock fallback so the route works with no API keys — see `fetch_nhc_cone.ts` for the pattern.

## Agent route

`app/api/agent/chat/route.ts` streams **NDJSON**, not SSE. Each line is `{type: "tool_call"|"tool_result"|"final"|"error", ...}`. The client parses line-by-line. If you change the event shape, update `lib/chat-stream.ts` and `components/AgentChat.tsx` in the same commit.

Tool-call loop caps at 6 iterations. Strict providers (Z.AI) need OpenAI-shape `tool_calls` (nested `{id, type: "function", function: {name, arguments}}` with `arguments` as a string) — that reformatting happens in the route and must stay.

## Tests

- TS: `npm test` (Vitest). Tests under `tests/lib`, `tests/components`. The components tests use `@testing-library/react` + `jsdom`.
- Python: `pytest`. Tests under `tests/api`, `tests/ml`, `tests/scripts`, `tests/eval`.
- Don't introduce a new test runner; the project ships only Vitest + Pytest deliberately.
- **Heavy integration tests have escape hatches.** `tests/api/portfolio/reoptimize.test.ts` runs the real precompute, which is ~10 min on a fully-loaded dev DB (many promoted sims). Set `FORGE_SKIP_REOPTIMIZE_INTEGRATION=1` to skip it on a loaded dev DB; CI / fresh-DB envs can run it without the flag. Pattern for future long-running integration tests: ship a `FORGE_SKIP_<TEST>=1` opt-out from day one.

## Tasks plan

Every commit in the original plan tags a `Task N` from `docs/superpowers/plans/2026-05-15-forge.md`. Component docstrings reference these. When extending a component, keep the `Task N` tag in the docstring (it's load-bearing for tracing what part of the spec the code implements).

## Common pitfalls

- **`force-dynamic`**: the three view pages set `export const dynamic = 'force-dynamic'` because they read live DB state. Don't remove this — Vercel will otherwise ISR-cache the page across deploys.
- **`forge-local.db` is gitignored**. Never check it in. Same for `artifacts/*.parquet`, `artifacts/*.joblib`, `artifacts/chips/`, `eval/results/*`.
- **`artifacts/portfolio_optimization.json`, `artifacts/calibration.json`, `artifacts/treaty.json`, `artifacts/regime/*.parquet`, `artifacts/hurdat2/*.parquet`, `artifacts/nhc/{track_error,intensity_error}.json`, `artifacts/elevations/known_points.json`, and `artifacts/coastal_zip3s.json` ARE tracked** (Phase 1 P2.0 / Phase 2 P2.2 / P2.17 / P2.3 / P2.10 / AUDIT.3 Phases 1, 3, 4). Pages, tests, and the scenario generator read them at render/run time; never re-run the precompute in serverless. Regenerate locally with `python -m scripts.precompute_portfolio_optimization`, `python -m scripts.precompute_calibration`, `python -m scripts.precompute_treaty`, `python -m ml.scenarios.regime --refresh`, `python -m ml.scenarios.hurdat2 --refresh`, `python -m scripts.fetch_nhc_errors`, and `python -m scripts.precompute_coastal_zip3s`.
- **`artifacts/simulations/*.parquet` is gitignored** (regenerated on promote). The `simulations` DB table IS the source of truth; the parquet is a derived K=1000 cohort-loss cache.
- **Basemap is MapLibre + OpenFreeMap unconditionally — Mapbox is banned.** Paid-service policy. Never propose `NEXT_PUBLIC_MAPBOX_TOKEN`, an `api.mapbox.com` style URL, or a `mapboxToken` prop. `react-map-gl/maplibre` is the only renderer to import.
- **Python imports inside `api_py/`**: must work both as a Vercel function (where `api_py/` is the package root) and as `from api_py.optimize_portfolio import solve` from `tests/api/`. Use relative imports sparingly; the test layout assumes absolute `api_py.*` paths.
- **Build/lint gating**: there is **no git pre-commit hook** in this repo (`.git/hooks` holds only samples; no husky/lefthook). The build gate is `.github/workflows/ci.yml` — it runs `npm run build` (which runs `next lint` + tsc) and `npm test` (vitest) on every PR and push to `main`. Vercel's deploy also runs `next build`, but that gates *deploys*, not *merges*, so always let CI run before merging (or run `npm run build` locally first). The CI vitest step skips the two non-deterministic integration tests via `FORGE_SKIP_REOPTIMIZE_INTEGRATION=1` and `FORGE_SKIP_STORM_EVENTS_INTEGRATION=1`; pytest is not yet gated (needs a pinned-3.12 runner + full precompute/ingest setup — a follow-up). Lint warnings about `any` are deliberate in the chat route (see the `eslint-disable` comments) — leave them.

## Things you should NOT do here

- Don't introduce Edge runtime for routes that touch `@libsql/client`.
- Don't move secrets into client components — even `NEXT_PUBLIC_*` is over-exposed for the LLM keys.
- Don't add a new Python runtime version. Vercel pins `python3.12` in `vercel.json` and every script is tested against it.
- Don't add `pnpm` / `bun` / `yarn` lockfiles. The project commits `package-lock.json` only.
- Don't break the cohort key format (`{zip3}_{build_type}_q{N}`) — it's a join key between TS and Python.
- Don't hand-code data that should be derived from a real source — see **Data integrity** above. No fabricated values masquerading as real or computed.

## Where things live

| You want to… | Edit… |
|---|---|
| Add an agent tool | `app/api/agent/tools/<name>.ts` + `app/api/agent/tools/index.ts` + `lib/llm/tool-registry.ts` |
| Change MIP economics | `REPRICE_FACTOR` / `LOSS_FACTOR` / `CESSION_COST_RATE` in `api_py/optimize_portfolio.py` |
| Change the cohort grouping | `lib/db/cohorts.ts` AND `eval/end_to_end.py` (`build_cohorts`) — keep them in sync |
| Change a page's data shape | The server-component page (`app/<view>/page.tsx`) + the client component (`components/<View>.tsx`) |
| Change the policy book schema | `lib/db/schema.sql` + `lib/book/csv.ts` (CSV validators) + `scripts/seed_policy_book.py` (seed) |
| Add a route to cron refresh | `app/api/cron/refresh/route.ts` + verify `crons` in `vercel.json` |
| Add a new simulation peril | `lib/sim/severity.ts` (HAZUS row + `PERIL_SCALES` entry + `PERIL_LABELS` entry) + `api_py/sim_loss.py` (`_HAZUS_MATRIX` + `_PERIL_LEVEL_MULT` + decay + perturbation) + `SimulationFootprint` union in `lib/sim/footprint.ts` + cite real-world calibration anchors in `research.md` |
| Change a peril severity multiplier | `PERIL_SCALES` in `lib/sim/severity.ts` AND `_PERIL_LEVEL_MULT` in `api_py/sim_loss.py` — they must mirror. Anchor at top tier = 1.0 = HAZUS-severe; cite real claim data for lower tiers in `research.md`. Update tests in both `tests/lib/sim/severity.test.ts` and `tests/api/test_sim_loss.py` |
| Rename a peril label | `PERIL_LABELS` in `lib/sim/severity.ts` — single source of truth. Keep the internal id snake_case (DB / parquet / reconciler join on it). If you also want stored sim names rewritten, run a `REPLACE(name, 'old_label,', 'New Label,')` UPDATE on the `simulations` table |
| Touch the simulate flow | `/simulate` route (`app/simulate/page.tsx` + `components/sim/*`); loss compute in `api_py/sim_loss.py`; banner in `components/grammar/SimulationBanner.tsx` mounted on `/portfolio` |

## Build / test cheatsheet

```bash
npm install                                            # JS deps
pip install -r requirements.txt                        # Vercel-runtime deps ONLY (numpy + shapely) — what Vercel installs
pip install -r requirements-precompute.txt             # Offline: solve / precompute / eval / tests (pulp, ortools, pandas, scipy, pytest, …)
pip install -r requirements-train.txt                  # Offline-only: torch + timm for CV head inference
npm run migrate                                        # Create tables in forge-local.db
python scripts/seed_policy_book.py                     # 10k synthetic policies (cv_features NULL by design)
python scripts/cache_s2_chips.py                       # Fetch 10k real Sentinel-2 chips from Microsoft Planetary Computer (~3h, gitignored cache, ~6 GB)
python scripts/populate_cv_features.py --mode cached   # Run Prithvi+head over real chips → fills cv_features (~10 min)
python -m scripts.precompute_portfolio_optimization    # Cache the MIP solution
npm run dev                                            # http://localhost:3000

npm test                                               # Vitest
FORGE_SKIP_REOPTIMIZE_INTEGRATION=1 npm test           # Vitest — skip the heavy reoptimize integration test on a loaded dev DB
pytest                                                 # Python tests
python -m eval.component_metrics                       # Refresh eval JSON
python -m eval.end_to_end                              # Refresh eval JSON + PNG
```

**CV features:** the chip cache + populate step is offline-only and not part of the Vercel build. Without it, `policies.cv_features` stays NULL and the Portfolio drill-down's property-features panel surfaces an honest "CV head not run on real chips" callout instead of any bars. **Never** run `populate_cv_features.py --mode mock` against a UI-facing DB: `mock_chip()` emits uniform-noise bands and the resulting NDVI/NDWI/SWIR/edge-density features collapse to identical band-math asymptotes for every policy (see `research.md` §8b for the derivation). The script refuses `--mode mock` without `--allow-mock` for exactly this reason.

## Refs

- Spec: `docs/superpowers/specs/2026-05-15-forge-design.md`
- Plan: `docs/superpowers/plans/2026-05-15-forge.md`
- Demo guide: `DEMO.md`
- Peril severity calibration citations: `research.md` (every numeric value in `PERIL_SCALES` / `_PERIL_LEVEL_MULT` / `HAZUS_MATRIX` traces to a source recorded here — TDI Uri report, NWS WSSI, USGS dNBR, FEMA HAZUS-Flood TM 4.0, Brooks 2004, Bakun-Wentworth 1997, etc.)
