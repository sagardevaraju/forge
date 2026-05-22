# Peril-Specific Intensity Scales — Design

**Date:** 2026-05-22
**Status:** Approved for planning
**Source proofs:** [`research.md`](../../../research.md) — all empirical citations

## Problem

The `/simulate` flow models six perils but flattens every one onto a single
universal three-tier `Intensity` enum (`moderate | severe | catastrophic`).
This is wrong in three ways:

1. **It loses real resolution.** Tornadoes have a six-level EF scale;
   earthquakes a continuous magnitude; hail a continuous stone-size scale.
   Collapsing them to three generic tiers discards genuine, published
   structure.
2. **It cannot express what operators ask for.** There is no way to dial a
   magnitude or pick an EF category — the request that motivated this work.
3. **The control is invisible.** `IntensityStrip` is a thin `text-xs` bar
   pinned to `bottom-2`, flush with the map edge, and its right half (the
   "Effective" date control) is fully occluded by the MapLibre attribution
   widget. Operators report not finding it at all.

## Goals

- Replace the universal three-tier intensity with a **per-peril scale**, each
  traceable to a published source (`research.md`).
- Earthquake: a **continuous Mw magnitude slider** that drives the damage
  circle radius continuously.
- Tornado: an **EF0–EF5 picker** that drives both the damage multiplier and
  the swath corridor width.
- Hail: a **continuous max-stone-diameter slider**.
- Flood / Wildfire / Winter: relabel the discrete control to the real scale
  (NWS flood categories / dNBR burn severity / NWS WSSI).
- Fix the severity control's **visibility and occlusion**.

## Non-goals

- No fragility-curve re-derivation of the HAZUS damage matrix. The
  `HAZUS_MATRIX` cells are unchanged; only the *intensity multiplier* applied
  to them changes.
- No drag-to-resize of the earthquake circle — the magnitude slider is the
  single source of truth for radius.
- No DB schema migration. The `simulations.intensity` column is reused.
- No change to the cohort key, the MIP, or the Decision Reconciler.

## Data-integrity principle

Per CLAUDE.md, every value traces to a real source. This design draws a sharp
line, recorded in `research.md`:

- **Geometry is empirically cited.** Earthquake radius (Bakun–Wentworth 1997),
  tornado path width (Brooks 2004), EF wind bands (NWS) — published numbers,
  used directly.
- **The damage multiplier is a modelling parameter**, anchored to FORGE's
  pre-existing calibration spine `INTENSITY_SCALE` (`{0.55, 1.0, 1.45}`). It
  has exactly the status `INTENSITY_SCALE` already holds — a documented design
  choice, not a measurement. It is *not* presented in the UI as cited data.

## Architecture

### 1. Per-peril scale registry — `lib/sim/severity.ts`

A `PERIL_SCALES: Record<Peril, PerilScale>` registry. `PerilScale` is a
discriminated union of two kinds:

```ts
interface ScaleLevel {
  id: string;          // stable id stored on the footprint, e.g. 'ef3'
  label: string;       // UI label, e.g. 'EF3'
  sublabel?: string;   // e.g. '136–165 mph'
  multiplier: number;  // damage multiplier (modelling parameter)
  width_m?: number;    // tornado only — swath corridor width
}

type PerilScale =
  | { kind: 'continuous'; unit: string; min: number; max: number;
      step: number; default: number;
      multiplier(v: number): number;     // modelling parameter
      label(v: number): string; }        // e.g. 'M7.2'
  | { kind: 'discrete'; levels: ScaleLevel[]; default: string };
```

Registry contents (numbers and citations in `research.md`):

| Peril | kind | Control | Detail |
|-------|------|---------|--------|
| earthquake | continuous | slider | Mw 5.0–9.0, step 0.1, default 7.0 |
| hail | continuous | slider | Ø 10–120 mm, step 5, default 45 |
| tornado | discrete | 6 buttons | EF0–EF5, default EF3, each carries `width_m` |
| flood | discrete | 3 buttons | Minor / Moderate / Major, default Moderate |
| wildfire | discrete | 3 buttons | Low / Moderate / High, default Moderate |
| winter | discrete | 5 buttons | Limited → Extreme, default Moderate |

Multiplier definitions:

- earthquake: `1.0 + 0.45·(Mw − 7.0)`, clamped ≥ 0.05
- hail: `0.55 + 0.0225·(Ø − 25)`, clamped ≥ 0.05
- tornado: `[0.325, 0.55, 0.775, 1.0, 1.225, 1.45]` for EF0–EF5
- flood: `[0.55, 1.0, 1.45]`
- wildfire: `[0.55, 1.0, 1.45]`
- winter: `[0.325, 0.55, 1.0, 1.45, 1.90]`

Tornado `width_m` per level: `[30, 60, 120, 240, 480, 550]` (Brooks 2004).

### 2. Severity value & the loss coupling

A new module-level helper supersedes the `INTENSITY_SCALE[intensity]` lookup:

```ts
type SeverityValue = number | string;   // number for continuous, level id for discrete
function damageMultiplier(peril: Peril, severity: SeverityValue): number;
function severityLabel(peril: Peril, severity: SeverityValue): string;
function legacyTier(peril: Peril, severity: SeverityValue): Intensity;  // → DB column
```

`damageRatio(peril, buildType, severity)` becomes
`HAZUS_MATRIX[buildType][peril] · damageMultiplier(peril, severity)`, clamped
to `[0, 1]`. `INTENSITY_SCALE` and `intensityScale()` are **kept** as the
legacy fallback for sims that carry only `intensity` (see Backward
compatibility).

**Python mirror.** `api_py/sim_loss.py` re-implements `damageMultiplier` as
`_damage_multiplier(peril, severity)` with the identical numbers. Per CLAUDE.md
the TS and Python copies must stay in sync; both reference `research.md`. The
continuous forms are simple linear expressions, trivially mirrored. The
existing `_INTENSITY_SCALE` stays as the legacy fallback.

### 3. Footprint contract — `lib/sim/footprint.ts`

`SimulationFootprint` gains one canonical field and keeps one derived field:

- **`severity: SeverityValue`** — new canonical per-peril value (Mw number,
  stone-Ø number, or level id like `'ef3'`).
- **`intensity: Intensity`** — retained, now **derived** via
  `legacyTier(peril, severity)`. It satisfies the `NOT NULL` DB column and is
  the fallback for old sims. No longer an operator input.

The standalone `magnitude` field added in the earlier earthquake work is
**removed** — for earthquake, `severity` *is* the magnitude, so a separate
field would be a second source of truth. `mmi_radii_km` stays: it is genuinely
derived display metadata (three shell radii), not an input. `EARTHQUAKE_MAGNITUDE`
(the old tier→magnitude lookup) is deleted — magnitude is now a free slider
value.

`buildFootprint` takes `severity` and derives `intensity` internally.
`validateFootprint` keeps the earthquake-needs-`epicenter` and
tornado-needs-`width_m` checks, and adds: `severity` must be present and valid
for the peril's scale.

### 4. Geometry coupling — `rebuildFootprint`

`rebuildFootprint(fp, severity, effectiveDate)` (renamed param) recomputes
geometry per peril:

- **earthquake** — `severity` (Mw) → `earthquakeFootprintGeometry` recomputes
  the MMI-VI circle and `mmi_radii_km` from the stored `epicenter`.
- **tornado** — `severity` (EF id) → `width_m` from the scale level →
  `bufferTornadoSwath(centerline, width_m)` re-buffers the stored
  `centerline`. (The footprint already persists `centerline`.)
- **hail / flood / wildfire / winter** — geometry is intensity-independent;
  only `severity`, `intensity`, and `effective_date` change.

### 5. UI — `IntensityStrip` → `SeverityStrip`

`components/sim/IntensityStrip.tsx` is renamed/rewritten as `SeverityStrip.tsx`.

Props: `{ peril, severity, onSeverityChange, effectiveDate, onDateChange }`.

Render is peril-aware off `PERIL_SCALES[peril]`:

- **continuous** (earthquake, hail) → `<input type="range">` with a live
  readout: earthquake shows `M7.2 · ~120 km radius`; hail shows `55 mm`.
- **discrete** (tornado, flood, wildfire, winter) → a segmented row of
  buttons, one per `ScaleLevel`, with `sublabel` (e.g. EF wind band) shown.

**Visibility fix.** The control becomes a proper card:

- lifted off the bottom edge (`bottom-8`, above the ~24 px attribution bar);
- content-fit width anchored `left-2` (no longer full-bleed `right-2`), so it
  never runs under the bottom-right MapLibre attribution — the date control is
  fully visible again;
- real padding and `bg-slate-900/95` contrast; the active level highlighted.

### 6. Wiring — `SimMap`, `SimWorkspace`

- `SimWorkspace` state: `severity: SeverityValue` replaces `intensity`,
  initialised from `PERIL_SCALES[peril].default` (or the loaded footprint).
  Switching peril resets `severity` to the new peril's default.
- The existing "re-apply on change" effect keys on `[severity, effectiveDate]`
  and calls `rebuildFootprint`.
- `SimMap` passes `peril` + `severity` to `SeverityStrip`; its terra-draw
  `finish` callback reads `severity` from `propsRef` and passes it to
  `buildFootprint`.
- The sim display name becomes `` `${peril}, ${severityLabel(...)} — ${date}` ``
  (e.g. `earthquake, M7.2 — 2026-05-22`).

### 7. API & DB — `app/api/sim/route.ts`, `[id]/route.ts`

- No schema change. `simulations.intensity` stores the derived `legacyTier`
  value (a known enum, satisfies `NOT NULL`).
- The footprint JSON in `simulations.footprint` carries the canonical
  `severity`. The sim `name` is built at POST time embedding `severityLabel`
  (e.g. `earthquake, M7.2 — 2026-05-22`), so `SimLibrary`, which renders the
  `name`, shows the right label with no functional change.
- `validateFootprint` in the POST path now also rejects a missing/invalid
  `severity`.

## Backward compatibility

The 56 rows currently in `simulations` are test data with footprints that have
`intensity` but no `severity`. The read path normalises them:

`parseFootprint(raw)` — a normaliser in `lib/sim/footprint.ts`, applied at
every stored-footprint read site (the `/api/sim` routes and the `/simulate`
page server component). If `severity` is absent it derives one from the legacy
`intensity` via `severityFromLegacy(peril, intensity)`, which returns a
representative scale value (earthquake `severe → 7.0`, tornado `severe → 'ef3'`,
hail `severe → 45`, etc.). The loss models (`damageRatio`,
`generate_sim_losses`) also fall back to `INTENSITY_SCALE` / `_INTENSITY_SCALE`
when only `intensity` is present. No migration script; no data loss.

## Testing

- **`tests/lib/sim/severity.test.ts`** (new) — `PERIL_SCALES` shape;
  `damageMultiplier` anchor values (M7→1.0, EF3→1.0, 45 mm→1.0, etc.);
  continuous clamps; `legacyTier` mapping.
- **`tests/lib/sim/footprint.test.ts`** — update earthquake tests for
  `severity` replacing `magnitude`; new tornado `rebuildFootprint` test
  (EF change re-buffers the centerline to the new width); `validateFootprint`
  severity checks.
- **`tests/api/test_sim_loss.py`** — `_damage_multiplier` matches the TS
  values; `generate_sim_losses` honours `severity`; legacy `intensity`
  fallback path.
- **`tests/components/`** — `SeverityStrip` renders a slider for continuous
  perils and the right button count for discrete ones; the visibility card
  classes are present.
- The TS↔Python multiplier parity is asserted on both sides against the
  numbers in `research.md`.

## Files touched

| File | Change |
|------|--------|
| `lib/sim/severity.ts` | `PERIL_SCALES`, `damageMultiplier`, `severityLabel`, `legacyTier`, `severityFromLegacy`; `damageRatio` signature |
| `lib/sim/footprint.ts` | `severity` field; derived `intensity`; `parseFootprint` normaliser; drop `magnitude` + `EARTHQUAKE_MAGNITUDE`; `rebuildFootprint` geometry per peril; `validateFootprint` |
| `lib/sim/preview.ts` | `damageRatio` call uses `severity` |
| `api_py/sim_loss.py` | `_damage_multiplier` + scale mirror; read `footprint["severity"]` with legacy fallback |
| `components/sim/SeverityStrip.tsx` | renamed from `IntensityStrip.tsx`; peril-aware control + visibility fix |
| `components/sim/SimMap.tsx` | pass `peril`/`severity`; `finish` builds with `severity` |
| `components/sim/SimWorkspace.tsx` | `severity` state; rebuild effect; sim name |
| `app/api/sim/route.ts`, `app/api/sim/[id]/route.ts`, `app/simulate/page.tsx` | derived `intensity` column; apply `parseFootprint` on read |
| `research.md` | source proofs (created) |
| tests | as above |
