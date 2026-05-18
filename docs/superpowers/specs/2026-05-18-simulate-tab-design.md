# Simulate — Design Spec

**Operator-drawn catastrophe simulation that flows through the existing FORGE pipeline.**

*Tagline: "Draw the event. See the book bleed. Promote when you're ready to optimize against it."*

---

## 1. Problem

FORGE's existing scenario pipeline handles one peril — hurricane — and one input — the live NHC cone. Cat-ops needs to interrogate the book against perils that don't have a public forecast feed (tornado, flood, hail, wildfire, earthquake, winter storm), or against arbitrary "what if a flood hit Tampa right now?" hypotheticals.

Today an operator answers these questions by hand: spreadsheet of ZIP3s, ad-hoc severity assumptions, no path back into the portfolio MIP. The decisions stay disconnected from the optimizer, and the result of "what if" never enters the same scenario-coupled mental model the rest of the product is built around.

**Simulate gives the operator a drawing tool that produces a real scenario object, scoring it through the existing severity, scenario, and optimization stack so the simulated event composes with hurricane risk in the joint TVaR-99 capital constraint.**

---

## 2. Scope

**In scope (v1):**
- Dedicated `/simulate` route with peril picker, drawing toolkit, and impact panel
- Six perils: Tornado, Flood, Hail, Wildfire, Earthquake, Winter storm
- Stochastic K=1000 cohort loss generation per promoted sim
- HAZUS-sourced peril × build_type severity matrix
- Persistence in a new `simulations` table with `draft / promoted / retired` lifecycle
- Joint-distribution composition: simulation cohort losses *added* to hurricane cohort losses for MIP TVaR-99
- Deferred re-optimize via a banner on `/portfolio`
- Saved sims library with shareable URLs (`/simulate?id=<sim_id>`)
- Mock fallback for offline / fresh-clone use (consistent with existing tool convention)

**Out of scope (v1):**
- Compound multi-peril events in a single sim (each sim is single-peril)
- Live drag-to-redraw stochastic recomputation (preview is single-draw; promote is the batch boundary)
- Empirical severity priors from `storm_events` (HAZUS-only in v1; broadening the NOAA / USGS / NIFC ingester is a follow-up)
- Multi-sim cross-correlation (each promoted sim concatenates independently into the joint K set; no shared common-factor residual *between* sims — within a single sim, the K=1000 draws DO share a common factor with hurricane scenarios via the existing `(β, σ)`)
- Severity dependence on policy fields other than `build_type` (v1 ignores `build_year`, `flood_zone`, `elevation_m`; richer vulnerability curves are a v2 follow-up)
- Hurricane peril in the simulate picker (already covered by `/events` cone + GEFS pipeline; deliberately excluded to keep the two surfaces non-overlapping)
- Authentication / authorization for `drawn_by` (v1 has no auth; `drawn_by` is a client-supplied string with no validation — any operator can promote / retire any sim)
- Mobile / small-screen layout (workspace requires ≥1024px)
- A scenario selector on `/portfolio` for branch-mode comparison (deferred; v1 uses *add* composition only)

---

## 3. Architecture

```
                            /simulate route
┌──────────────────────────────────────────────────────────────────────┐
│  Peril picker  →  Draw tool  →  Footprint preview  →  Impact panel   │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  "Promote to scenario"
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  POST /api/sim/<id>/promote                                          │
│   1. Persist footprint to `simulations` table                        │
│   2. Generate K=1000 perturbed footprints                            │
│   3. For each draw, compute per-cohort loss                          │
│   4. Write `artifacts/simulations/<sim_id>.parquet` (cohort × K)     │
│   5. Mark `portfolio_optimization.meta.json` stale                   │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  /portfolio shows banner
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Operator clicks "Re-optimize"                                       │
│   → precompute_portfolio_optimization.py --include-sims all          │
│   → MIP loads hurricane scenarios ⊕ simulation cohort losses         │
│     (joint K=2000 per cohort)                                         │
│   → Solves; writes portfolio_optimization.json + meta.json           │
│   → Existing reconciler picks up new actions automatically           │
└──────────────────────────────────────────────────────────────────────┘
```

**Boundary choices:**
- **Drawing UX → footprint payload** is a TS-only concern. Footprint is the contract crossing the boundary.
- **Footprint → cohort losses** is Python (`api_py/sim_loss.py`). Same Monte-Carlo scaffolding as `ml/scenarios/generate.py`, peril-aware.
- **Cohort losses → MIP** uses the existing optimizer with a new `--include-sims` flag that concatenates K matrices column-wise before TVaR-99. No change to the LP/MIP structure.
- **Reconciler** unchanged. It consumes MIP output; the simulation is invisible to it.

---

## 4. Drawing toolkit

**Library:** `terra-draw` v1.x — MapLibre-native, polygon/polyline/point built-in, plugin model for custom modes. Bindings drop into the existing `react-map-gl/maplibre` setup. `maplibre-gl-draw` rejected — fork of mapbox-gl-draw, hasn't kept pace with MapLibre 5.x.

**Per-peril mode mapping:**

| Peril | terra-draw mode | Footprint shape | Operator controls |
|---|---|---|---|
| Tornado | `linestring` + custom `swath` post-process | Polyline buffered by `width_m` → GeoJSON Polygon | width slider (50–800 m, default 200 m) |
| Flood | `polygon` (freehand) | GeoJSON Polygon | optional depth chip (`shallow / moderate / deep`) |
| Hail | `polygon` (freehand) | GeoJSON Polygon + optional inner polygon | optional inner-core polygon |
| Wildfire | `polygon` (freehand) | GeoJSON Polygon | wind direction chip |
| Earthquake | `point` + concentric circle generator | Point + array of MMI radii in km | magnitude slider (M5.0–M8.5) |
| Winter storm | `polygon` (large-area) | GeoJSON Polygon | freeze-temp chip (`cold / hard-freeze`) |

**Common controls (every peril):**
- Intensity slider: `moderate / severe / catastrophic` — scales the HAZUS row uniformly
- Effective date: defaults to now, settable for backdated what-ifs

**Footprint contract (TS → Python boundary):**

```ts
interface SimulationFootprint {
  peril: 'tornado' | 'flood' | 'hail' | 'wildfire' | 'earthquake' | 'winter';
  intensity: 'moderate' | 'severe' | 'catastrophic';
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;      // hail core
  centerline?: GeoJSON.LineString;       // tornado original drawing
  width_m?: number;                       // tornado swath width
  epicenter?: GeoJSON.Point;             // earthquake
  magnitude?: number;
  mmi_radii_km?: Record<string, number>;
  effective_date: string;                // ISO-8601
  metadata: {
    drawn_by: string;
    drawn_at: string;
    chips?: string[];                    // ['deep'], ['wind-NE'], etc.
  };
}
```

**TS module layout:**
- `lib/sim/draw/` — terra-draw adapter + per-peril mode factories
- `lib/sim/footprint.ts` — builds `SimulationFootprint` from terra-draw state; validates non-self-intersection
- `lib/sim/severity.ts` — HAZUS matrix + decay functions (data, not inlined in optimizer)
- `lib/sim/preview.ts` — client-side point-in-polygon for the preview impact panel
- `components/sim/` — `SimWorkspace`, `SimMap`, `PerilPicker`, `SimLibrary`, `DrawToolbar`, `IntensityStrip`, `ImpactPanel`, `PromoteButton`

---

## 5. Severity model

**Per-policy expected loss inside a single Monte-Carlo draw:**

```
loss(policy, draw) = TIV
                   × HAZUS[peril][build_type]
                   × intensity_scale[intensity]
                   × decay(distance_to_reference)
                   × β·ε_draw
```

**HAZUS matrix** (`lib/sim/severity.ts`, mean damage ratio at *severe* benchmark):

| build_type \ peril | tornado | flood | hail | wildfire | earthquake | winter |
|---|---|---|---|---|---|---|
| wood_frame | 0.42 | 0.55 | 0.18 | 0.92 | 0.35 | 0.08 |
| masonry    | 0.28 | 0.62 | 0.10 | 0.85 | 0.22 | 0.06 |
| mobile_home| 0.85 | 0.45 | 0.32 | 0.95 | 0.55 | 0.18 |
| commercial | 0.30 | 0.48 | 0.12 | 0.78 | 0.28 | 0.05 |

Cells sourced from FEMA HAZUS Technical Manual; per-row citation comments live alongside the literal in code.

**Intensity scaling:**
- `moderate`: ×0.55
- `severe`: ×1.00 (HAZUS reference)
- `catastrophic`: ×1.45 (each cell clipped at 1.0 after scaling)

**Per-peril decay:**

| Peril | Reference | Decay | Param |
|---|---|---|---|
| Tornado | polyline centerline | `exp(-d / (width_m/2))` | width_m |
| Flood | polygon boundary (inward) | uniform inside, 0 outside | n/a |
| Hail | inner-core centroid (or polygon centroid) | `1.0` inside core; `0.6 * exp(-(d - r_core)/r_core)` outside | inner core radius |
| Wildfire | polygon boundary | uniform inside, 0 outside | n/a |
| Earthquake | epicenter | step function from MMI radii lookup | magnitude |
| Winter | polygon boundary | uniform inside, 0 outside | n/a |

**K=1000 perturbation:**

| Peril | Perturbed quantity | σ |
|---|---|---|
| Tornado | centerline vertices (lat/lon) + width_m | 0.005° per vertex; 15% on width |
| Flood / Hail / Wildfire / Winter | polygon vertices | 0.003° per vertex (≈300 m) |
| Earthquake | epicenter (lat/lon) + magnitude | 0.01°; 0.15 M |

RNG seeded by `sim_id` (same `_storm_seed` pattern from `ml/scenarios/generate.py`) so re-running a promote is bit-identical. Output: per-cohort loss numpy array of shape `(n_cohorts, K)`.

**Common-factor residual β·ε_draw:** reuses `api_py/correlation.apply_common_factor` with the *same* `(β, σ)` parameters as the hurricane scenario set (loaded from `artifacts/calibration.json`). This puts simulated events on the same event-residual axis as hurricane scenarios so the joint K=2000 TVaR-99 is consistent under one common factor. Sim-pair correlation (sim A's residual vs sim B's) is explicitly *not* modeled in v1 — multiple promoted sims concatenate independently.

**TVaR-99 over the joint distribution:** when MIP runs with `--include-sims`, it concatenates simulation losses onto hurricane losses to form K=2000 per cohort. TVaR-99 is the mean of the top 1% (~20 worst draws). The joint set captures simulated-event tail contribution alongside hurricane tail contribution.

**Numerical guardrails:**
- All damage_ratio cells clipped to [0, 1] after scaling
- Empty footprint geometry produces zero loss + a logged warning, not an error
- Earthquake with no policies inside the largest MMI radius silently produces zero loss

---

## 6. Schema, persistence & data model

**New DB table** (additive migration in `lib/db/schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS simulations (
  id TEXT PRIMARY KEY,                  -- UUIDv7 (sortable by creation time)
  name TEXT NOT NULL,
  peril TEXT NOT NULL,
  intensity TEXT NOT NULL,
  footprint TEXT NOT NULL,              -- JSON: SimulationFootprint
  effective_date TEXT NOT NULL,
  drawn_by TEXT NOT NULL,
  drawn_at TEXT NOT NULL,
  promoted INTEGER NOT NULL DEFAULT 0,
  promoted_at TEXT,
  retired INTEGER NOT NULL DEFAULT 0,
  retired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_simulations_promoted ON simulations(promoted, retired);
CREATE INDEX IF NOT EXISTS idx_simulations_drawn_at ON simulations(drawn_at DESC);
```

**Lifecycle:** *draft* (drawn, preview impact populated) → *promoted* (cohort loss parquet exists, banner appears on `/portfolio`) → *retired* (soft-deleted, no longer enters joint TVaR).

**Artifact layout** (gitignored, regenerated):

```
artifacts/
  simulations/
    <sim_id>.parquet       # cohort × K=1000 loss matrix
    <sim_id>.meta.json     # peril, intensity, K, cohort_keys (sanity-check)
  portfolio_optimization.json
  portfolio_optimization.meta.json   # NEW: {hurricane_scenario_set, included_sims[], solved_at}
```

`.parquet` shape: `(n_cohorts, K)`. Cohort row order enforced via the cohort-key index in `.meta.json`. The MIP `np.concatenate`s the matrices column-wise before TVaR-99.

**Peril-agnostic scenario object** (extends existing hurricane shape — does not replace):

```python
class Scenario(TypedDict):
    id: str                          # "sim:<sim_id>:000123" or "AL092024_0001"
    kind: Literal['hurricane', 'simulation']
    cohort_losses: dict[str, float]  # cohort_key → loss; required for both kinds
    prob: float                       # IS-corrected probability weight
    # hurricane legacy fields (optional)
    path: NotRequired[list[dict]]
    peak_wind: NotRequired[float]
    surge_grid: NotRequired[dict[str, float]]
    # simulation-only fields
    peril: NotRequired[str]
    intensity: NotRequired[str]
```

`cohort_losses` is the new universal invariant. The MIP only reads `cohort_losses` + `prob`. Legacy hurricane fields preserved for UI consumers (cone overlay, surge map).

**Promoted-set selection** — `precompute_portfolio_optimization.py` gets a `--include-sims` flag:

```bash
python -m scripts.precompute_portfolio_optimization                              # default: hurricane only
python -m scripts.precompute_portfolio_optimization --include-sims all           # all promoted, non-retired
python -m scripts.precompute_portfolio_optimization --include-sims sim_abc,sim_def
```

MIP writes the included sim IDs into `portfolio_optimization.meta.json`. `/portfolio` renders "currently optimizing against: AL092024 + Tampa-hail-2026-05-18".

**REST surface:**

| Route | Method | Purpose |
|---|---|---|
| `/api/sim` | GET | Paginated list, filterable by `promoted` |
| `/api/sim` | POST | Create draft (persist footprint + return preview impact) |
| `/api/sim/<id>` | GET | Single sim + footprint + impact summary |
| `/api/sim/<id>/promote` | POST | Generate K=1000 cohort losses; flip `promoted=1` |
| `/api/sim/<id>/retire` | POST | Soft-delete; banner flag clears if no others outstanding |
| `/api/portfolio/reoptimize` | POST | Trigger `precompute_portfolio_optimization.py --include-sims all` |

**Backward compatibility:**
- Existing hurricane scenarios continue to ship `path / peak_wind / surge_grid` untouched. The `kind: 'hurricane'` discriminator is added to existing scenarios by `ml.scenarios.generate.generate_scenarios()`.
- Old portfolio solutions (no `.meta.json`) treated as "hurricane-only" by `/portfolio` — no migration of existing artifacts.

---

## 7. UI — `/simulate` route & banner on `/portfolio`

**Layout:** three columns inside the route.

- **Left** — peril picker (6 perils) + saved-sims list with `DRAFT` / `PROMOTED` / `RETIRED` badges. Top: `+ New simulation`.
- **Center** — MapLibre map + floating draw toolbar (per-peril tools) top-left; intensity / effective-date strip pinned bottom.
- **Right** — preview impact panel: est. gross loss, policies in footprint, TIV, cohorts affected, top-cohort breakdown. Bottom: `Promote to scenario →` button.

**Component split (`components/sim/`):**

| Component | Responsibility |
|---|---|
| `SimPage` (server) | Loads sim list + selected sim by `?id=` |
| `SimWorkspace` (client) | Top-level; owns draw state + footprint object |
| `PerilPicker` | Left sidebar; picks active peril, switches draw mode |
| `SimLibrary` | Left sidebar; lists saved sims with state badges |
| `SimMap` | terra-draw + MapLibre; emits `onFootprintChange` |
| `DrawToolbar` | Floating map toolbar; per-peril tools |
| `IntensityStrip` | Bottom overlay; intensity slider + effective-date picker |
| `ImpactPanel` | Right pane; consumes preview impact response |
| `PromoteButton` | Triggers promote; shows progress; updates badge |

**Routing & URL state:**
- `/simulate` — empty state when no sims exist
- `/simulate?id=<sim_id>` — loads that sim
- `/simulate?peril=hail` — starts a new draft of the given peril
- All persistence is server-driven; URL is the durable share link

**`/portfolio` banner** (`components/grammar/SimulationBanner.tsx`):

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⚠  1 unresolved simulation — Tampa hail, severe                           │
│    Promoted 2 min ago by sagar · Adds K=1000 to joint TVaR-99             │
│    [ Re-optimize portfolio ]  [ View simulation ]  [ Retire ]             │
└───────────────────────────────────────────────────────────────────────────┘
```

Appears when `simulations.promoted=1 AND retired=0` rows exist and `portfolio_optimization.meta.json` doesn't reference them. **Re-optimize** kicks off `POST /api/portfolio/reoptimize`. Multiple unresolved sims collapse to a single banner with a count.

**Empty / error states:**
- Empty footprint — impact panel shows placeholder, promote disabled
- No policies inside footprint — impact shows zeros + "0 policies in this area — promote anyway?" chip; promote stays enabled (zero-loss sim is a legitimate outcome)
- Promote failure — red toast with error code; sim stays `draft`

---

## 8. Testing strategy

| Layer | Test type | What it covers |
|---|---|---|
| `lib/sim/severity.ts` | Vitest unit | HAZUS lookup + clipping; per-peril decay correctness |
| `lib/sim/footprint.ts` | Vitest unit | Polygon → `SimulationFootprint`; tornado swath buffering; earthquake MMI radii |
| `lib/sim/preview.ts` | Vitest unit | Point-in-polygon preview determinism; fixed-fixture per-peril expectations |
| `components/sim/*` | Vitest + RTL | `ImpactPanel` empty-state; `PromoteButton` enable/disable; `SimLibrary` filtering |
| `api_py/sim_loss.py` | Pytest | K=1000 seedable (same `sim_id` → bit-equal parquet); cohort keys match `lib/db/cohorts.ts` |
| `app/api/sim/*/route.ts` | Vitest + mocked DB | Promote idempotency; retire flips banner state |
| `scripts/precompute_portfolio_optimization.py` | Pytest | `--include-sims` flag concatenates K matrices in correct cohort order; joint TVaR-99 differs from hurricane-only |
| `tests/eval/sim_end_to_end.py` | Pytest | Draw → preview → promote → re-optimize → reconciler end-to-end; deterministic PNG output |

**Mock / offline behavior (consistent with `fetch_nhc_cone.ts` convention):**
- TS routes accept `FORGE_TOOLS_MODE=mock` for deterministic fixtures (seeded by `sim_id`)
- `lib/sim/preview.ts` is pure TS — no Python round-trip; `/simulate` renders on a fresh clone
- HAZUS matrix is a JSON literal in code; no external file dependency

---

## 9. Error handling matrix

| Failure | Handled where | UX |
|---|---|---|
| Self-intersecting polygon | `lib/sim/footprint.ts` | Inline toolbar warning; promote disabled until fixed |
| No policies in footprint | `lib/sim/preview.ts` | Impact shows zeros + chip; promote still enabled |
| Python loss compute fails | `app/api/sim/<id>/promote` returns 500 | Red toast with code; sim stays `draft`; log includes sim_id + footprint summary |
| Parquet write OK, MIP re-solve fails | `app/api/portfolio/reoptimize` returns 500 | Banner persists; "Re-optimize failed: <reason>"; `portfolio_optimization.json` unchanged |
| MIP CBC 30s timeout (existing) | Existing optimizer guard | Banner shows "Re-optimize partial — within MIP gap" |
| Concurrent re-optimize | DB row lock on `meta.json` write | Second request returns 409; client polls |
| Retired sim still referenced by stale meta.json | `precompute_portfolio_optimization.py` skips retired | Banner clears on next re-optimize |

---

## 10. Observability

- Each sim emits a structured log line on create / promote / retire / re-optimize: `{sim_id, peril, intensity, drawn_by, est_loss_preview, est_loss_promoted}`
- Promote response includes `compute_time_ms` (target < 3 s for ≤10 k policies)
- `portfolio_optimization.meta.json` writes a `simulations_log: [...]` array per re-optimize for full audit reproducibility

---

## 11. References

- Spec: `docs/superpowers/specs/2026-05-15-forge-design.md`
- Plan: `docs/superpowers/plans/2026-05-15-forge.md`
- Hurricane scenario generator: `ml/scenarios/generate.py`
- Portfolio MIP: `api_py/optimize_portfolio.py`
- Decision Reconciler: `lib/reconciler/index.ts`
- FEMA HAZUS Technical Manual (damage function source for §5 matrix)
