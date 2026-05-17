# FORGE — Claude Code working notes

This file teaches Claude Code the conventions and traps of this repo. Optimize edits for these.

## Mental model

FORGE is a **scenario-coupled cat-ops console**. The whole point is that *the same scenario set* drives three optimization layers (Portfolio MIP, Operational LP, Claims pre-flag). When you touch one layer, ask whether the change should propagate through the **Decision Reconciler** (`lib/reconciler/index.ts`) before it reaches the UI.

The codebase is a **single Next.js 16 monorepo** that mixes runtimes on Vercel:

- TypeScript routes in `app/api/**` run on the **Node runtime** (`runtime = 'nodejs'`). The agent chat route used to be `edge` per the original plan but was moved to Node because `@libsql/client` needs fs access for the local SQLite fallback.
- Python optimizers + scenario generator live in `api_py/*.py` and run on **Vercel's Python 3.12 runtime**. Each module exposes a module-level `solve()` (importable + unit-testable) and a `class handler(BaseHTTPRequestHandler)` that wraps it for Vercel. Keep both.
- Offline ML training lives in `ml/`. **Never bundle `ml/` deps into Vercel functions** — they go in `requirements-train.txt`, not `requirements.txt`. `requirements.txt` is what Vercel installs.

## DB

- `lib/db/client.ts` resolves `TURSO_URL` → libSQL remote, falling back to `file:./forge-local.db` when unset. Local dev uses the file; prod uses Turso. **Both code paths must work** — don't write SQL that depends on libSQL-only features.
- Schema lives in `lib/db/schema.sql`. Run `npm run migrate` (which executes `lib/db/migrate.ts`) to apply it. The migrate script splits on `;` — keep statements one-per-line and avoid semicolons inside string literals.
- `cv_features` on `policies` is a JSON-encoded string of 8 floats. `lib/db/cohorts.ts` parses + averages them per cohort. If the field is null or malformed, the cohort just gets a zero vector — that path is exercised by the tests.

## Cohorts

`aggregateCohorts()` (`lib/db/cohorts.ts`) is the canonical TS implementation; `eval/end_to_end.py` ships a Python re-implementation. **Both must stay in sync** — same key (`{zip3}_{build_type}_q{0..4}`), same quintile cut-points (computed over the entire book, not per-state), same modal-flood-zone tie-break (lexical order). The cohort field is `tiv_quintile` (Task 12 renamed it from the historical `tiv_decile`); the value range is `0..4`.

## Portfolio MIP

`api_py/optimize_portfolio.py::solve()` runs PuLP with CBC and a 30-second timeLimit. **Don't add new actions casually** — the action set is fixed at six (`retain · reprice_up · reprice_down · non_renew · cede_qs · cede_xs`) and every action has tuned coefficients in `REPRICE_FACTOR`, `LOSS_FACTOR`, `CESSION_COST_RATE`. Adding a new action means re-checking all three dicts.

The capital constraint zeroes out `cede_xs` from the VaR-99 retention — that's intentional. XS reinsurance attaches *below* p99, so the carrier's retained tail exposure is ~0 for ceded cohorts. Don't "fix" this.

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

## Tasks plan

Every commit in the original plan tags a `Task N` from `docs/superpowers/plans/2026-05-15-forge.md`. Component docstrings reference these. When extending a component, keep the `Task N` tag in the docstring (it's load-bearing for tracing what part of the spec the code implements).

## Common pitfalls

- **`force-dynamic`**: the three view pages set `export const dynamic = 'force-dynamic'` because they read live DB state. Don't remove this — Vercel will otherwise ISR-cache the page across deploys.
- **`forge-local.db` is gitignored**. Never check it in. Same for `artifacts/*.parquet`, `artifacts/*.joblib`, `artifacts/chips/`, `eval/results/*`.
- **`artifacts/portfolio_optimization.json` and `artifacts/calibration.json` ARE tracked** (Phase 1 P2.0 / Phase 2 P2.2). Pages read them at render time; never re-run the precompute in serverless. Regenerate locally with `python -m scripts.precompute_portfolio_optimization` and `python -m scripts.precompute_calibration`.
- **Mapbox token**: the basemap needs `NEXT_PUBLIC_MAPBOX_TOKEN`. Without it, MapLibre falls back to its style which is fine for dev but looks bare.
- **Python imports inside `api_py/`**: must work both as a Vercel function (where `api_py/` is the package root) and as `from api_py.optimize_portfolio import solve` from `tests/api/`. Use relative imports sparingly; the test layout assumes absolute `api_py.*` paths.
- **Pre-commit hook lint**: `npm run build` runs `next lint` implicitly. Lint warnings about `any` are deliberate in the chat route (see the `eslint-disable` comments) — leave them.

## Things you should NOT do here

- Don't introduce Edge runtime for routes that touch `@libsql/client`.
- Don't move secrets into client components — even `NEXT_PUBLIC_*` is over-exposed for the LLM keys.
- Don't add a new Python runtime version. Vercel pins `python3.12` in `vercel.json` and every script is tested against it.
- Don't add `pnpm` / `bun` / `yarn` lockfiles. The project commits `package-lock.json` only.
- Don't break the cohort key format (`{zip3}_{build_type}_q{N}`) — it's a join key between TS and Python.

## Where things live

| You want to… | Edit… |
|---|---|
| Add an agent tool | `app/api/agent/tools/<name>.ts` + `app/api/agent/tools/index.ts` + `lib/llm/tool-registry.ts` |
| Change MIP economics | `REPRICE_FACTOR` / `LOSS_FACTOR` / `CESSION_COST_RATE` in `api_py/optimize_portfolio.py` |
| Change the cohort grouping | `lib/db/cohorts.ts` AND `eval/end_to_end.py` (`build_cohorts`) — keep them in sync |
| Change a page's data shape | The server-component page (`app/<view>/page.tsx`) + the client component (`components/<View>.tsx`) |
| Change the policy book schema | `lib/db/schema.sql` + `lib/book/csv.ts` (CSV validators) + `scripts/seed_policy_book.py` (seed) |
| Add a route to cron refresh | `app/api/cron/refresh/route.ts` + verify `crons` in `vercel.json` |

## Build / test cheatsheet

```bash
npm install                                            # JS deps
pip install -r requirements.txt                        # Python deps (NOT requirements-train.txt for routes)
npm run migrate                                        # Create tables in forge-local.db
python scripts/seed_policy_book.py                     # 10k synthetic policies
python -m scripts.precompute_portfolio_optimization    # Cache the MIP solution
npm run dev                                            # http://localhost:3000

npm test                                               # Vitest
pytest                                                 # Python tests
python -m eval.component_metrics                       # Refresh eval JSON
python -m eval.end_to_end                              # Refresh eval JSON + PNG
```

## Refs

- Spec: `docs/superpowers/specs/2026-05-15-forge-design.md`
- Plan: `docs/superpowers/plans/2026-05-15-forge.md`
- Demo guide: `DEMO.md`
