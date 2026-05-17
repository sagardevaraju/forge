# FORGE — Demo Guide

A walkthrough of what to show, in what order, and what to say. Built for a ~5-minute class demo with backup paths if a live feed misbehaves.

---

## Pre-demo checklist (do this 15 min before)

```bash
# 1. Confirm the local DB is seeded
sqlite3 forge-local.db "SELECT COUNT(*), printf('%.0f', SUM(tiv)) FROM policies;"
# Expect: ~10000 | ~3,185,865,814

# 2. Confirm the MIP cache exists and is recent
ls -lh artifacts/portfolio_optimization.json
# If missing or stale: python -m scripts.precompute_portfolio_optimization

# 3. Confirm eval artifacts exist
ls eval/results/
# Expect: component_metrics.json · end_to_end.json · end_to_end.png

# 4. Start the dev server
npm run dev
# Open http://localhost:3000 and click through all four pages once to warm caches
```

If you have time, also run a sanity test:

```bash
npm test            # vitest — should pass
pytest -q           # python tests — should pass
```

---

## Grammar primitives (Phase 1 redesign)

Every view now composes from a small set of shared primitives, and the panel will likely ask about them. **`ExecCard`** is the KPI tile used for the four landing-dashboard metrics and the portfolio header strip — one number, one label, an optional `TrustTierBadge`, and a freshness timestamp. **`TrustTierBadge`** renders one of five tiers (`LIVE_FEED`, `MODEL_OUTPUT`, `SYNTHETIC_SCAFFOLD`, `RECOMMENDATION`, `MANUAL_OVERRIDE`) so the reader can tell at a glance where a number came from. **`ProvenanceFootnote`** is the three-line source/method/confidence block sitting under every chart and panel. **`ThreatBanner`** is the top-of-page strip that names the active scenario set the views are coupled to. **`PersonaToggle`** is the layout-level switch between `cat-ops` (the only live persona in Phase 1) and the Phase 2 personas (`actuary`, `field-ops`, `executive`). Together they enforce the demo's central claim: every number on screen is labeled with what it is, where it came from, and how confident we are in it. Full defense at [`docs/methodology.md`](docs/methodology.md) and `/methodology` in-app.

---

## Current state of the build

What works today, what's stubbed:

| Component | Status | Notes |
|---|---|---|
| Next.js 16 scaffold | ✅ Working | All four routes render |
| Turso/libSQL schema + 10k policy book | ✅ Seeded | `forge-local.db` is ~1.9 MB |
| NOAA Storm Events ingest (2018–2024) | ✅ Working | `storm_events` populated |
| HAZUS damage curves + XGBoost loss model | ✅ Trained | `artifacts/xgb_p{10,50,90}.joblib` |
| CV head (Prithvi + MLP, 8 dims) | ✅ Trained | `artifacts/cv_head.pt`, real Sentinel-2 chips cached |
| LLM cascading client + 7 tools | ✅ Working | All tools have mock fallback |
| Scenario generator | ✅ Working | NHC GEFS perturbation, 1000 weighted realizations |
| Portfolio MIP | ✅ Working | Pre-computed; ~570 cohorts, solves in <5s |
| Operational VRP | ✅ Working | Solves in <5s for typical inputs |
| Decision Reconciler | ✅ Working | Filters preflag, surfaces conflicts |
| `/portfolio` view | ✅ Working | ZIP3 choropleth + drill-down panel |
| `/events` view | ✅ Working | Cone overlay, fires, sitrep, agent chat |
| `/claims` view | ✅ Working | 200 pre-flagged policies, sortable, CSV export |
| `/load` view | ✅ Working | Upload CSV → replace book → rerun MIP |
| Vercel Cron `/api/cron/refresh` | ✅ Wired | Every 15 min; CRON_SECRET-guarded |
| Component + end-to-end eval | ✅ Working | Results JSON + bar chart in `eval/results/` |
| **Production Vercel deploy** | 🟡 Not promoted in this state | `vercel link && vercel --prod` to ship |
| **Backup demo video** | ❌ Not recorded | Task 28 |

---

## Live demo script (~5 min)

### 1. The pitch (30s — landing page)

> *"Every Monday at 8am, a cat-ops VP sits through a three-hour meeting where four artifacts — a meteorology Word doc, an actuarial PDF, a field-ops spreadsheet, a reinsurance model — get reconciled by hand. They make decisions, but the decisions aren't scenario-coupled. FORGE collapses those four into one console so portfolio, operations, and claims all consume the same Monte Carlo scenario set."*

Open `http://localhost:3000`. Point out the three views.

### 2. Portfolio Map (60s)

Click **Portfolio Map**.

- The header shows cohort count and the MIP objective (`~$44M`).
- Hover the ZIP3 choropleth — every shape is colored by the MIP's recommended action.
- Click a hot ZIP3 (Florida coast) → drill-down panel shows action fractions per cohort and the dominant recommendation.

Talk-track:
> *"570 cohorts. The MIP recommends repricing 197 cohorts up and ceding 373 cohorts via excess-of-loss reinsurance. It chose this allocation to maximize expected margin subject to a capital VaR-99 cap, a 15% non-renew cap, and a $5.3M cession premium budget. All four constraints came from the carrier's policy team — none are baked into the model."*

### 3. Event Console + Agent (90s)

Click **Event Console**.

- The map shows the **AL092024 (Helene)** cone overlay and recent FIRMS fire pixels.
- Right side: the **sitrep panel** and the **Ask FORGE** chat.

Type into the chat:

> `What's our Tampa exposure on this storm?`

The chat will stream tool-call events live — `fetch_nhc_cone`, `query_book_exposure(["337", "338"])` — and then the final answer with a $ figure.

Talk-track:
> *"The agent is calling real tools. The exposure number it just cited came out of the policy book a second ago. The cone came from NHC. If a senior cat-ops manager asks 'what if the cone shifts 50 miles east', the agent re-pulls scenarios and re-answers."*

Backup if the LLM rate-limits: every tool ships with a deterministic mock fallback, so the cone + sitrep render even with no API keys.

### 4. Claims Pre-Brief (45s)

Click **Claims Pre-Brief**.

- 200 policies pre-flagged inside the cone, sorted by expected loss.
- Sortable by ZIP3 / severity / loss. CSV export top-right.

Talk-track:
> *"This is what field-ops gets. Severity tiers are derived from build_type + flood_zone, weighted by the MIP's retention decisions — the reconciler drops policies the MIP non-renewed, because they're no longer the carrier's. Today: 200 high-priority addresses, ready to dispatch."*

### 5. The result (45s)

Show `eval/results/end_to_end.png` (or open the JSON):

> *"We froze FORGE's recommendation 14 days pre-landfall for five 2024 hurricane events. Across those events, FORGE's posture beat the naive 'retain everything' baseline by **$1.86 billion total / $372M mean** — that's the loss avoided by the MIP's reprice + cede decisions."*

Note: the headline number depends on the synthetic book; in slide commentary frame it as "the optimizer behaves correctly under HAZUS-grade losses" rather than as a literal carrier P&L claim.

### 6. Close (15s)

> *"Synthetic book today, scoped to U.S. hurricanes, single carrier. Real-deployment story is on the limitations slide. Happy to take questions."*

---

## What to have open in tabs

1. `http://localhost:3000` (already on Portfolio Map)
2. `http://localhost:3000/events`
3. `http://localhost:3000/claims`
4. `eval/results/end_to_end.png` in your image viewer (Quick Look on macOS)
5. Backup: `docs/superpowers/specs/2026-05-15-forge-design.md` open in your editor for any spec questions

---

## Failure modes & recovery

| If… | Then… |
|---|---|
| The dev server died | `npm run dev` in the FORGE root; it comes back in <3s |
| The Portfolio header says "MIP cache missing" | `python -m scripts.precompute_portfolio_optimization` |
| The agent chat hangs | OpenRouter or GitHub Models is rate-limiting. Cancel, refresh, and answer the question from the cached SITREP on the right panel. Mention the cascading client did its three retries already. |
| The map shows no cone | NHC API hiccup — every tool has a mock fallback that returns the AL092024 (Helene) cone. The UI will render it; no action needed. |
| `/claims` shows zero policies | The seed query expects FL coastal ZIPs in `policies`. Re-run `python scripts/seed_policy_book.py`. |
| `/load` upload fails the MIP precompute step | The book was replaced but the artifact wasn't. Run `python -m scripts.precompute_portfolio_optimization` manually and refresh `/portfolio`. |
| Demo machine has no network | Every tool falls back to deterministic mocks. Cone + fires + sitrep + agent answers still render. Lead with "I'm going to show this in offline mode — every external API has a deterministic fallback baked in so the demo is reproducible." |

---

## Numbers to know cold

- **10,000** synthetic policies, FL/TX/LA/NC, coastal-weighted
- **~570** cohorts after `(zip3, build_type, TIV quintile)` aggregation
- **$3.19B** total TIV in the book · **$52.7M** annual premium
- **$44.5M** MIP objective at the current budgets
- **6** portfolio actions: retain · reprice_up · reprice_down · non_renew · cede_qs · cede_xs
- **7** agent tools, each with a mock fallback
- **1,000** Monte Carlo scenarios per active threat
- **5** holdout events, **$372M mean** improvement vs naive baseline
- **<5s** MIP solve, **<5s** VRP solve, **<10s** end-to-end re-solve target
- **15-minute** Vercel Cron cadence for upstream feeds

---

## After the demo

Walk the panel through:

1. **Spec** — `docs/superpowers/specs/2026-05-15-forge-design.md` for §1–3 (problem + persona + levers) and §7 (evaluation).
2. **Plan** — `docs/superpowers/plans/2026-05-15-forge.md` for the 7-day breakdown and how each commit lined up.
3. **Limitations** — §8 of the spec is honest: synthetic book, hurricanes only, no competitor reaction modeling, no auth beyond demo magic-link.
