# Peril-Specific Intensity Scales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the universal three-tier `Intensity` enum in the `/simulate` flow with per-peril, source-cited severity scales — continuous sliders for earthquake (Mw) and hail (stone Ø), discrete pickers for tornado/flood/wildfire/winter — and fix the on-map severity control's visibility.

**Architecture:** A `PERIL_SCALES` registry in `lib/sim/severity.ts` defines each peril's scale (continuous or discrete) plus its damage multiplier. Footprints carry a canonical `severity` value and a *derived* legacy `intensity` tier (for the existing NOT NULL DB column and old-sim fallback). `api_py/sim_loss.py` mirrors the multiplier numbers so TS↔Python loss math stays in sync. The renamed `SeverityStrip` component renders the control peril-aware and is lifted clear of the MapLibre attribution widget.

**Tech Stack:** TypeScript / Next.js 16 (App Router, Node runtime), Vitest + React Testing Library, Python 3.12 + Pytest, MapLibre / react-map-gl.

---

## Orientation for the implementer

Read these first — they are the empirical and design backing for every number in this plan:

- **Spec:** `docs/superpowers/specs/2026-05-22-peril-intensity-scales-design.md`
- **Source proofs:** `research.md` (repo root) — every scale, geometry relationship, and multiplier traces here. CLAUDE.md forbids fabricated data; the numbers in this plan are copied from `research.md`.

**Two kinds of numbers** (per `research.md` and CLAUDE.md):
- *Empirically cited* — EF wind bands, Brooks 2004 path widths, Bakun–Wentworth attenuation. Used directly; must not change without a new citation.
- *Modelling parameter* — the per-peril damage multipliers, anchored to the existing `INTENSITY_SCALE` spine (`0.55 / 1.0 / 1.45`). Documented design choices, not measurements.

**Working-tree note:** the repo already has uncommitted "earthquake scaffolding" edits in `lib/sim/footprint.ts`, `components/sim/SimMap.tsx`, `components/sim/SimWorkspace.tsx`, and `tests/lib/sim/footprint.test.ts`. Each task below scopes its `git add` to its own files; those pre-existing deltas ride along with the first task that touches each file. Do not try to commit them separately.

**Build-green policy:** `npm test` (Vitest) does **not** typecheck — it must stay green after *every* task. `npm run build` (which typechecks app files) will be **intentionally red from Task 4 through Task 7** because `SimMap.tsx` / `SimWorkspace.tsx` still reference the old footprint API; it returns to green at **Task 8** and stays green. This is called out again in the affected tasks.

**Cohort key / MIP / Reconciler:** untouched. No DB migration. The `simulations.intensity` column is reused.

---

### Task 1: `PERIL_SCALES` registry + scale types

Add the per-peril scale registry and its types to `lib/sim/severity.ts`. Purely additive — no existing export changes.

**Files:**
- Modify: `lib/sim/severity.ts`
- Test: `tests/lib/sim/severity.test.ts`

- [ ] **Step 1: Write the failing test**

Update the import block at the top of `tests/lib/sim/severity.test.ts` to add the new symbols:

```typescript
import { describe, test, expect } from 'vitest';
import {
  damageRatio,
  intensityScale,
  PERILS,
  PERIL_SCALES,
  type Peril,
  type Intensity,
} from '@/lib/sim/severity';
```

Append this describe block to the **end** of `tests/lib/sim/severity.test.ts`:

```typescript
describe('PERIL_SCALES', () => {
  test('has an entry for every peril', () => {
    for (const p of PERILS) expect(PERIL_SCALES[p]).toBeDefined();
  });
  test('earthquake and hail are continuous; the rest are discrete', () => {
    expect(PERIL_SCALES.earthquake.kind).toBe('continuous');
    expect(PERIL_SCALES.hail.kind).toBe('continuous');
    for (const p of ['tornado', 'flood', 'wildfire', 'winter'] as const) {
      expect(PERIL_SCALES[p].kind).toBe('discrete');
    }
  });
  test('the earthquake slider spans Mw 5.0-9.0 with a 7.0 default', () => {
    const s = PERIL_SCALES.earthquake;
    if (s.kind !== 'continuous') throw new Error('expected continuous');
    expect([s.min, s.max, s.step, s.default]).toEqual([5.0, 9.0, 0.1, 7.0]);
  });
  test('tornado has six EF levels, each carrying a Brooks-2004 width_m', () => {
    const t = PERIL_SCALES.tornado;
    if (t.kind !== 'discrete') throw new Error('expected discrete');
    expect(t.levels.map((l) => l.id)).toEqual(['ef0', 'ef1', 'ef2', 'ef3', 'ef4', 'ef5']);
    expect(t.levels.map((l) => l.width_m)).toEqual([30, 60, 120, 240, 480, 550]);
    expect(t.default).toBe('ef3');
  });
  test('winter has the five WSSI loss-bearing categories', () => {
    const w = PERIL_SCALES.winter;
    if (w.kind !== 'discrete') throw new Error('expected discrete');
    expect(w.levels.map((l) => l.id)).toEqual(['limited', 'minor', 'moderate', 'major', 'extreme']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/sim/severity.test.ts`
Expected: FAIL — `PERIL_SCALES` is not exported.

- [ ] **Step 3: Add the types and registry**

In `lib/sim/severity.ts`, immediately **after** the `INTENSITY_SCALE` constant and its `intensityScale()` function (i.e. after the current line 49), insert:

```typescript
/** A severity value: a number for continuous scales, a level id for discrete. */
export type SeverityValue = number | string;

/** One step of a discrete per-peril scale. */
export interface ScaleLevel {
  id: string;          // stable id stored on the footprint, e.g. 'ef3'
  label: string;       // UI label, e.g. 'EF3'
  sublabel?: string;   // e.g. '136-165 mph' (tornado wind band — cited)
  multiplier: number;  // damage multiplier (modelling parameter)
  width_m?: number;    // tornado only — swath corridor width (Brooks 2004)
}

/**
 * A per-peril severity scale — either a continuous slider or a discrete
 * picker. Numbers and citations live in research.md.
 */
export type PerilScale =
  | {
      kind: 'continuous';
      unit: string;
      min: number;
      max: number;
      step: number;
      default: number;
      multiplier(v: number): number; // damage multiplier (modelling parameter)
      label(v: number): string;      // UI label, e.g. 'M7.2'
    }
  | { kind: 'discrete'; levels: ScaleLevel[]; default: string };

/**
 * Per-peril severity scales. Geometry-driving numbers (EF wind bands, Brooks
 * 2004 path widths) are empirically cited; the damage multipliers are
 * modelling parameters anchored to the INTENSITY_SCALE spine. See research.md.
 */
export const PERIL_SCALES: Record<Peril, PerilScale> = {
  earthquake: {
    kind: 'continuous',
    unit: 'Mw',
    min: 5.0,
    max: 9.0,
    step: 0.1,
    default: 7.0,
    // Modelling parameter — anchored M6/M7/M8 -> 0.55/1.0/1.45 (research.md S2c).
    multiplier: (v) => Math.max(0.05, 1.0 + 0.45 * (v - 7.0)),
    label: (v) => `M${v.toFixed(1)}`,
  },
  hail: {
    kind: 'continuous',
    unit: 'mm',
    min: 10,
    max: 120,
    step: 5,
    default: 45,
    // Modelling parameter — anchored 25 mm -> 0.55, 45 mm -> 1.0 (research.md S3b).
    multiplier: (v) => Math.max(0.05, 0.55 + 0.0225 * (v - 25)),
    label: (v) => `${v} mm`,
  },
  tornado: {
    kind: 'discrete',
    default: 'ef3',
    levels: [
      { id: 'ef0', label: 'EF0', sublabel: '65-85 mph',   multiplier: 0.325, width_m: 30 },
      { id: 'ef1', label: 'EF1', sublabel: '86-110 mph',  multiplier: 0.55,  width_m: 60 },
      { id: 'ef2', label: 'EF2', sublabel: '111-135 mph', multiplier: 0.775, width_m: 120 },
      { id: 'ef3', label: 'EF3', sublabel: '136-165 mph', multiplier: 1.0,   width_m: 240 },
      { id: 'ef4', label: 'EF4', sublabel: '166-200 mph', multiplier: 1.225, width_m: 480 },
      { id: 'ef5', label: 'EF5', sublabel: 'over 200 mph', multiplier: 1.45, width_m: 550 },
    ],
  },
  flood: {
    kind: 'discrete',
    default: 'moderate',
    levels: [
      { id: 'minor',    label: 'Minor',    multiplier: 0.55 },
      { id: 'moderate', label: 'Moderate', multiplier: 1.0 },
      { id: 'major',    label: 'Major',    multiplier: 1.45 },
    ],
  },
  wildfire: {
    kind: 'discrete',
    default: 'moderate',
    levels: [
      { id: 'low',      label: 'Low',      multiplier: 0.55 },
      { id: 'moderate', label: 'Moderate', multiplier: 1.0 },
      { id: 'high',     label: 'High',     multiplier: 1.45 },
    ],
  },
  winter: {
    kind: 'discrete',
    default: 'moderate',
    levels: [
      { id: 'limited',  label: 'Limited',  multiplier: 0.325 },
      { id: 'minor',    label: 'Minor',    multiplier: 0.55 },
      { id: 'moderate', label: 'Moderate', multiplier: 1.0 },
      { id: 'major',    label: 'Major',    multiplier: 1.45 },
      { id: 'extreme',  label: 'Extreme',  multiplier: 1.90 },
    ],
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/sim/severity.test.ts`
Expected: PASS — all describe blocks (including the pre-existing `damageRatio` / `intensityScale` blocks) green.

- [ ] **Step 5: Commit**

```bash
git add lib/sim/severity.ts tests/lib/sim/severity.test.ts research.md \
        docs/superpowers/specs/2026-05-22-peril-intensity-scales-design.md \
        docs/superpowers/plans/2026-05-22-peril-intensity-scales.md
git commit -m "feat(sim): add PERIL_SCALES per-peril severity registry"
```

---

### Task 2: severity lookup helpers — `damageMultiplier`, `severityLabel`, `legacyTier`, `severityFromLegacy`, `tornadoWidthM`

Add the five pure functions that read `PERIL_SCALES`. All keep `INTENSITY_SCALE` as a legacy fallback.

**Files:**
- Modify: `lib/sim/severity.ts`
- Test: `tests/lib/sim/severity.test.ts`

- [ ] **Step 1: Write the failing test**

Update the import block in `tests/lib/sim/severity.test.ts` to:

```typescript
import { describe, test, expect } from 'vitest';
import {
  damageRatio,
  intensityScale,
  damageMultiplier,
  severityLabel,
  legacyTier,
  severityFromLegacy,
  tornadoWidthM,
  PERILS,
  PERIL_SCALES,
  type Peril,
  type Intensity,
} from '@/lib/sim/severity';
```

Append these describe blocks to the **end** of `tests/lib/sim/severity.test.ts`:

```typescript
describe('damageMultiplier', () => {
  test('earthquake is linear in Mw, anchored M6/M7/M8 -> 0.55/1.0/1.45', () => {
    expect(damageMultiplier('earthquake', 6.0)).toBeCloseTo(0.55, 6);
    expect(damageMultiplier('earthquake', 7.0)).toBeCloseTo(1.0, 6);
    expect(damageMultiplier('earthquake', 8.0)).toBeCloseTo(1.45, 6);
  });
  test('hail is linear in stone diameter, anchored 25 mm -> 0.55, 45 mm -> 1.0', () => {
    expect(damageMultiplier('hail', 25)).toBeCloseTo(0.55, 6);
    expect(damageMultiplier('hail', 45)).toBeCloseTo(1.0, 6);
  });
  test('continuous multipliers clamp at a 0.05 floor', () => {
    expect(damageMultiplier('earthquake', 1.0)).toBe(0.05);
  });
  test('tornado EF levels return the documented multipliers', () => {
    expect(damageMultiplier('tornado', 'ef0')).toBe(0.325);
    expect(damageMultiplier('tornado', 'ef3')).toBe(1.0);
    expect(damageMultiplier('tornado', 'ef5')).toBe(1.45);
  });
  test('winter spans the five WSSI multipliers', () => {
    expect(damageMultiplier('winter', 'limited')).toBe(0.325);
    expect(damageMultiplier('winter', 'extreme')).toBe(1.90);
  });
  test('falls back to the legacy tier scale for a tier string', () => {
    expect(damageMultiplier('tornado', 'severe')).toBe(1.0);
    expect(damageMultiplier('hail', 'moderate')).toBe(0.55);
    expect(damageMultiplier('earthquake', 'catastrophic')).toBe(1.45);
  });
});

describe('severityLabel', () => {
  test('formats continuous values', () => {
    expect(severityLabel('earthquake', 7.2)).toBe('M7.2');
    expect(severityLabel('hail', 45)).toBe('45 mm');
  });
  test('returns the level label for discrete values', () => {
    expect(severityLabel('tornado', 'ef3')).toBe('EF3');
    expect(severityLabel('winter', 'extreme')).toBe('Extreme');
  });
});

describe('legacyTier', () => {
  test('buckets a severity value into the nearest legacy tier', () => {
    expect(legacyTier('earthquake', 7.0)).toBe('severe');
    expect(legacyTier('earthquake', 5.5)).toBe('moderate');
    expect(legacyTier('earthquake', 9.0)).toBe('catastrophic');
    expect(legacyTier('tornado', 'ef0')).toBe('moderate');
    expect(legacyTier('tornado', 'ef5')).toBe('catastrophic');
  });
});

describe('severityFromLegacy', () => {
  test('derives a representative severity from a legacy tier', () => {
    expect(severityFromLegacy('earthquake', 'severe')).toBe(7.0);
    expect(severityFromLegacy('hail', 'severe')).toBe(45);
    expect(severityFromLegacy('tornado', 'severe')).toBe('ef3');
    expect(severityFromLegacy('flood', 'moderate')).toBe('minor');
  });
  test('round-trips through legacyTier for every peril and tier', () => {
    for (const peril of PERILS) {
      for (const tier of ['moderate', 'severe', 'catastrophic'] as const) {
        expect(legacyTier(peril, severityFromLegacy(peril, tier))).toBe(tier);
      }
    }
  });
});

describe('tornadoWidthM', () => {
  test('returns the Brooks 2004 path width for an EF level', () => {
    expect(tornadoWidthM('ef0')).toBe(30);
    expect(tornadoWidthM('ef3')).toBe(240);
    expect(tornadoWidthM('ef5')).toBe(550);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/sim/severity.test.ts`
Expected: FAIL — `damageMultiplier` etc. are not exported.

- [ ] **Step 3: Implement the helpers**

In `lib/sim/severity.ts`, append these five functions to the **end** of the file (after `PERIL_SCALES`):

```typescript
/**
 * Per-peril damage multiplier. For a continuous peril `severity` is a number;
 * for a discrete peril it is a level id. A legacy tier string ('moderate' |
 * 'severe' | 'catastrophic') falls back to INTENSITY_SCALE so footprints
 * stored before the per-peril scales still resolve.
 */
export function damageMultiplier(peril: Peril, severity: SeverityValue): number {
  const scale = PERIL_SCALES[peril];
  if (scale.kind === 'continuous') {
    if (typeof severity === 'number') return scale.multiplier(severity);
    return INTENSITY_SCALE[severity as Intensity] ?? 1.0;
  }
  const level = scale.levels.find((l) => l.id === severity);
  if (level) return level.multiplier;
  return INTENSITY_SCALE[severity as Intensity] ?? 1.0;
}

/** Human-readable label for a severity value (e.g. 'M7.2', '45 mm', 'EF3'). */
export function severityLabel(peril: Peril, severity: SeverityValue): string {
  const scale = PERIL_SCALES[peril];
  if (scale.kind === 'continuous') {
    return typeof severity === 'number' ? scale.label(severity) : String(severity);
  }
  const level = scale.levels.find((l) => l.id === severity);
  return level ? level.label : String(severity);
}

/**
 * Bucket a severity value into the legacy three-tier Intensity enum. Used to
 * fill the NOT NULL `simulations.intensity` column — the column is no longer
 * an operator input, just a derived label. Thresholds sit at the midpoints of
 * the INTENSITY_SCALE spine (0.775, 1.225).
 */
export function legacyTier(peril: Peril, severity: SeverityValue): Intensity {
  const m = damageMultiplier(peril, severity);
  if (m < 0.775) return 'moderate';
  if (m < 1.225) return 'severe';
  return 'catastrophic';
}

/**
 * Derive a representative severity value from a legacy Intensity tier — used
 * to normalise footprints stored before the per-peril scales. The result is
 * the scale value whose multiplier equals INTENSITY_SCALE[intensity], so it
 * round-trips back through legacyTier().
 */
export function severityFromLegacy(peril: Peril, intensity: Intensity): SeverityValue {
  const m = INTENSITY_SCALE[intensity];
  const scale = PERIL_SCALES[peril];
  if (scale.kind === 'discrete') {
    const level = scale.levels.find((l) => l.multiplier === m);
    return (level ?? scale.levels.find((l) => l.id === scale.default)!).id;
  }
  // Continuous — invert multiplier(v) = m (research.md S2c, S3b).
  if (peril === 'earthquake') return 7.0 + (m - 1.0) / 0.45;
  return 25 + (m - 0.55) / 0.0225; // hail
}

/** Tornado swath corridor width (m) for an EF level id (Brooks 2004). */
export function tornadoWidthM(severity: SeverityValue): number {
  const scale = PERIL_SCALES.tornado;
  if (scale.kind !== 'discrete') return 240;
  return scale.levels.find((l) => l.id === severity)?.width_m ?? 240;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/sim/severity.test.ts`
Expected: PASS — every block green.

- [ ] **Step 5: Commit**

```bash
git add lib/sim/severity.ts tests/lib/sim/severity.test.ts
git commit -m "feat(sim): add damageMultiplier/severityLabel/legacyTier severity helpers"
```

---

### Task 3: widen `damageRatio` to accept a `SeverityValue`

Re-point `damageRatio` at `damageMultiplier`. The third parameter widens from `Intensity` to `SeverityValue` — all existing callers still compile and (via the legacy fallback) still produce identical numbers.

**Files:**
- Modify: `lib/sim/severity.ts:51-60` (the `damageRatio` function)
- Test: `tests/lib/sim/severity.test.ts` (existing `damageRatio` block — must stay green)

- [ ] **Step 1: Add a regression test for the new signature**

Append to the **end** of `tests/lib/sim/severity.test.ts`:

```typescript
describe('damageRatio with per-peril severity', () => {
  test('a continuous severity drives the ratio (hail 45 mm -> multiplier 1.0)', () => {
    expect(damageRatio('hail', 'wood_frame', 45)).toBeCloseTo(0.18, 4);
  });
  test('a discrete severity drives the ratio (tornado EF1 -> multiplier 0.55)', () => {
    expect(damageRatio('tornado', 'wood_frame', 'ef1')).toBeCloseTo(0.42 * 0.55, 4);
  });
  test('a legacy tier string still resolves via the fallback', () => {
    expect(damageRatio('tornado', 'wood_frame', 'severe')).toBeCloseTo(0.42, 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/sim/severity.test.ts -t "per-peril severity"`
Expected: FAIL — `damageRatio('hail', 'wood_frame', 45)` is a type/runtime mismatch (current third arg is `Intensity`; numeric `45` resolves through `INTENSITY_SCALE[45]` → `undefined` → `base * undefined` → `NaN`).

- [ ] **Step 3: Rewrite `damageRatio`**

In `lib/sim/severity.ts`, replace the entire current `damageRatio` function (currently lines 51-60) with:

```typescript
export function damageRatio(
  peril: Peril,
  buildType: BuildType | string,
  severity: SeverityValue,
): number {
  const row = HAZUS_MATRIX[buildType as BuildType] ?? HAZUS_MATRIX.wood_frame;
  const base = row[peril];
  const scaled = base * damageMultiplier(peril, severity);
  return Math.min(1, Math.max(0, scaled));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/sim/severity.test.ts`
Expected: PASS — the new block **and** the pre-existing `damageRatio` block (which passes `'moderate'`/`'severe'`/`'catastrophic'` strings) are both green, because `damageMultiplier` falls back to `INTENSITY_SCALE` for tier strings.

- [ ] **Step 5: Commit**

```bash
git add lib/sim/severity.ts tests/lib/sim/severity.test.ts
git commit -m "feat(sim): damageRatio takes a per-peril SeverityValue"
```

---

### Task 4: `footprint.ts` — per-peril severity contract

Add the canonical `severity` field; derive `intensity`; drop `magnitude` and `EARTHQUAKE_MAGNITUDE`; make `earthquakeFootprintGeometry` take a magnitude number; make `rebuildFootprint` recompute geometry per peril.

> **Build note:** after this task `components/sim/SimMap.tsx` and `components/sim/SimWorkspace.tsx` will have TypeScript errors (they still call the old API). `npm test` stays green (Vitest does not typecheck); `npm run build` is intentionally red until Task 8.

**Files:**
- Modify: `lib/sim/footprint.ts` (full rewrite — content below)
- Test: `tests/lib/sim/footprint.test.ts` (full rewrite — content below)

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `tests/lib/sim/footprint.test.ts` with:

```typescript
// @vitest-environment node
import { describe, test, expect } from 'vitest';
import {
  buildFootprint,
  bufferTornadoSwath,
  validateFootprint,
  mmiRadiusKm,
  earthquakeFootprintGeometry,
  rebuildFootprint,
} from '@/lib/sim/footprint';
import { tornadoWidthM } from '@/lib/sim/severity';

const SQUARE: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[[-82, 27], [-81, 27], [-81, 28], [-82, 28], [-82, 27]]],
};
const EPICENTER: GeoJSON.Point = { type: 'Point', coordinates: [-82, 27.5] };

describe('bufferTornadoSwath', () => {
  test('buffers a polyline into a polygon', () => {
    const line: GeoJSON.LineString = { type: 'LineString', coordinates: [[-82, 27], [-82, 28]] };
    const poly = bufferTornadoSwath(line, 200);
    expect(poly.type).toBe('Polygon');
    expect(poly.coordinates[0].length).toBeGreaterThan(3);
  });
});

describe('buildFootprint', () => {
  test('hail polygon: stores severity, derives the legacy intensity tier', () => {
    const fp = buildFootprint({
      peril: 'hail',
      severity: 45,
      geometry: SQUARE,
      effective_date: '2026-05-22',
      drawn_by: 'operator',
    });
    expect(fp.severity).toBe(45);
    expect(fp.intensity).toBe('severe'); // 45 mm -> multiplier 1.0 -> severe
    expect(fp.metadata.drawn_by).toBe('operator');
    expect(fp.metadata.drawn_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test('tornado: an EF0 severity derives the moderate tier', () => {
    const fp = buildFootprint({
      peril: 'tornado',
      severity: 'ef0',
      geometry: SQUARE,
      effective_date: '2026-05-22',
      drawn_by: 'operator',
    });
    expect(fp.intensity).toBe('moderate'); // ef0 -> 0.325 -> moderate
  });
});

describe('mmiRadiusKm', () => {
  test('inverts Bakun-Wentworth: M7.0 reaches MMI VI at ~120 km', () => {
    expect(mmiRadiusKm(7.0, 6)).toBeCloseTo(119.9, 1);
  });
  test('clamps to 0 when the magnitude never reaches the intensity', () => {
    expect(mmiRadiusKm(6.0, 8)).toBe(0);
  });
  test('radius grows with magnitude for a fixed MMI', () => {
    expect(mmiRadiusKm(8.0, 6)).toBeGreaterThan(mmiRadiusKm(6.0, 6));
  });
});

describe('earthquakeFootprintGeometry', () => {
  test('produces a circular Polygon for a given moment magnitude', () => {
    const eq = earthquakeFootprintGeometry(EPICENTER, 7.0);
    expect(eq.geometry.type).toBe('Polygon');
    expect(eq.mmi_radii_km['6']).toBeGreaterThan(0);
  });
  test('a larger magnitude yields a larger damage circle', () => {
    const small = earthquakeFootprintGeometry(EPICENTER, 6.0);
    const big = earthquakeFootprintGeometry(EPICENTER, 8.0);
    expect(big.mmi_radii_km['6']).toBeGreaterThan(small.mmi_radii_km['6']);
  });
  test('a sub-damage magnitude (Mw 5.0) still yields a constructible Polygon', () => {
    const eq = earthquakeFootprintGeometry(EPICENTER, 5.0);
    expect(eq.geometry.type).toBe('Polygon');
    expect(eq.geometry.coordinates[0].length).toBeGreaterThan(3);
  });
});

describe('rebuildFootprint', () => {
  test('a polygon peril keeps geometry, swaps severity + date', () => {
    const original = buildFootprint({
      peril: 'flood', severity: 'minor', geometry: SQUARE,
      effective_date: '2026-05-18', drawn_by: 'operator',
    });
    const rebuilt = rebuildFootprint(original, 'major', '2026-06-01');
    expect(rebuilt.severity).toBe('major');
    expect(rebuilt.intensity).toBe('catastrophic');
    expect(rebuilt.effective_date).toBe('2026-06-01');
    expect(rebuilt.geometry).toEqual(original.geometry);
  });
  test('earthquake recomputes the damage circle when magnitude changes', () => {
    const eq = earthquakeFootprintGeometry(EPICENTER, 6.0);
    const original = buildFootprint({
      peril: 'earthquake', severity: 6.0, geometry: eq.geometry,
      epicenter: EPICENTER, mmi_radii_km: eq.mmi_radii_km,
      effective_date: '2026-05-18', drawn_by: 'operator',
    });
    const rebuilt = rebuildFootprint(original, 8.0, '2026-05-18');
    expect(rebuilt.severity).toBe(8.0);
    expect(rebuilt.mmi_radii_km!['6']).toBeGreaterThan(original.mmi_radii_km!['6']);
  });
  test('tornado re-buffers the centerline to the new EF width', () => {
    const centerline: GeoJSON.LineString = {
      type: 'LineString', coordinates: [[-82, 27], [-82, 28]],
    };
    const original = buildFootprint({
      peril: 'tornado', severity: 'ef1',
      geometry: bufferTornadoSwath(centerline, tornadoWidthM('ef1')),
      centerline, width_m: tornadoWidthM('ef1'),
      effective_date: '2026-05-18', drawn_by: 'operator',
    });
    const rebuilt = rebuildFootprint(original, 'ef5', '2026-05-18');
    expect(rebuilt.severity).toBe('ef5');
    expect(rebuilt.width_m).toBe(550);
    const span = (g: GeoJSON.Polygon) => {
      const xs = g.coordinates[0].map((c) => c[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(rebuilt.geometry)).toBeGreaterThan(span(original.geometry));
  });
});

describe('validateFootprint (geometry)', () => {
  test('rejects a degenerate polygon ring', () => {
    const fp = buildFootprint({
      peril: 'flood', severity: 'minor',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] } as unknown as GeoJSON.Polygon,
      effective_date: '2026-05-22', drawn_by: 'x',
    });
    const r = validateFootprint(fp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ring/i);
  });
  test('accepts a valid polygon footprint', () => {
    const fp = buildFootprint({
      peril: 'flood', severity: 'moderate', geometry: SQUARE,
      effective_date: '2026-05-22', drawn_by: 'x',
    });
    expect(validateFootprint(fp).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/sim/footprint.test.ts`
Expected: FAIL — `buildFootprint` does not accept a `severity` arg; `earthquakeFootprintGeometry` expects an `Intensity`.

- [ ] **Step 3: Rewrite `lib/sim/footprint.ts`**

Replace the entire contents of `lib/sim/footprint.ts` with:

```typescript
/**
 * SimulationFootprint — the JSON contract crossing the TS -> Python boundary.
 * See spec S4 (drawing toolkit) and S6 (persistence).
 *
 * The schema is a discriminated union by `peril`. Optional fields are
 * peril-specific (centerline+width_m for tornado, epicenter for earthquake).
 * The canonical `geometry` is always a Polygon — for tornado the *buffered*
 * swath, not the centerline.
 *
 * `severity` is the canonical per-peril severity value (a Mw number, a
 * stone-diameter number, or a discrete scale-level id like 'ef3'). `intensity`
 * is *derived* from it via legacyTier() — it satisfies the NOT NULL
 * `simulations.intensity` column and is the fallback for footprints stored
 * before the per-peril severity scales existed.
 *
 * Task 4 / peril-intensity-scales: per-peril severity contract.
 */
import buffer from '@turf/buffer';
import { lineString, point } from '@turf/helpers';
import { isValidSimId } from './id';
import {
  legacyTier,
  tornadoWidthM,
  type Peril,
  type Intensity,
  type SeverityValue,
} from './severity';

export interface SimulationFootprint {
  peril: Peril;
  severity: SeverityValue;
  intensity: Intensity;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
  mmi_radii_km?: Record<string, number>;
  effective_date: string;
  metadata: {
    drawn_by: string;
    drawn_at: string;
    chips?: string[];
  };
}

export interface BuildFootprintArgs {
  peril: Peril;
  severity: SeverityValue;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
  mmi_radii_km?: Record<string, number>;
  effective_date: string;
  drawn_by: string;
  chips?: string[];
}

/** Build a footprint from operator input. `intensity` is derived, not passed. */
export function buildFootprint(args: BuildFootprintArgs): SimulationFootprint {
  return {
    peril: args.peril,
    severity: args.severity,
    intensity: legacyTier(args.peril, args.severity),
    geometry: args.geometry,
    inner_geometry: args.inner_geometry,
    centerline: args.centerline,
    width_m: args.width_m,
    epicenter: args.epicenter,
    mmi_radii_km: args.mmi_radii_km,
    effective_date: args.effective_date,
    metadata: {
      drawn_by: args.drawn_by,
      drawn_at: new Date().toISOString(),
      chips: args.chips,
    },
  };
}

/**
 * Buffer a tornado centerline by half the swath width on each side.
 * width_m is the TOTAL corridor width; turf/buffer takes a radius, so we
 * pass width_m/2 in kilometers.
 */
export function bufferTornadoSwath(
  centerline: GeoJSON.LineString,
  width_m: number,
): GeoJSON.Polygon {
  const radiusKm = (width_m / 2) / 1000;
  const feature = buffer(lineString(centerline.coordinates), radiusKm, { units: 'kilometers' });
  if (!feature || feature.geometry.type !== 'Polygon') {
    throw new Error('Tornado swath buffer produced a non-Polygon geometry');
  }
  return feature.geometry as GeoJSON.Polygon;
}

/**
 * Earthquake footprint geometry.
 *
 * The operator drops a single epicenter point and dials a moment magnitude
 * (Mw) on the severity slider. The damage footprint is the circular area
 * inside which shaking reaches the Modified Mercalli damage threshold
 * (MMI VI — onset of structural damage). The radius comes from the Bakun &
 * Wentworth (1997) California intensity-attenuation relation, inverted for
 * distance:
 *
 *   MMI = 1.68*Mw - 3.29 - 0.0206*Delta        (Delta = epicentral distance, km)
 *
 * Source: Bakun, W.H. & Wentworth, C.M. (1997), "Estimating earthquake
 * location and magnitude from seismic intensity data", BSSA 87(6), 1502-1521.
 * The three attenuation coefficients below are the empirical part and must not
 * be edited without a new citation (research.md S2b).
 */

// Bakun & Wentworth (1997) California MMI attenuation coefficients.
const BW_MAGNITUDE_COEF = 1.68;
const BW_CONSTANT = 3.29;
const BW_DISTANCE_COEF = 0.0206;

// Modified Mercalli VI — onset of structural damage. Bounds the footprint.
const DAMAGE_THRESHOLD_MMI = 6;

// Below ~Mw 5.5 the MMI-VI contour has zero radius. The footprint contract
// still needs a constructible Polygon, so the buffer is floored at this small
// epsilon — a degenerate-case guard, not a measurement. mmi_radii_km still
// honestly omits any shell whose true radius is 0.
const MIN_BUFFER_KM = 0.5;

/**
 * Epicentral distance (km) at which Bakun-Wentworth shaking decays to the
 * given Modified Mercalli intensity. Clamped at 0 — a magnitude too small to
 * ever reach `mmi` (even at the epicenter) yields no radius.
 */
export function mmiRadiusKm(magnitude: number, mmi: number): number {
  const km = (BW_MAGNITUDE_COEF * magnitude - BW_CONSTANT - mmi) / BW_DISTANCE_COEF;
  return Math.max(0, km);
}

/** Buffer an epicenter point into a circular Polygon of `radiusKm`. */
export function bufferEpicenterCircle(
  epicenter: GeoJSON.Point,
  radiusKm: number,
): GeoJSON.Polygon {
  if (!(radiusKm > 0)) {
    throw new Error('Earthquake footprint requires a positive radius');
  }
  const feature = buffer(point(epicenter.coordinates), radiusKm, {
    units: 'kilometers',
    steps: 64,
  });
  if (!feature || feature.geometry.type !== 'Polygon') {
    throw new Error('Earthquake circle buffer produced a non-Polygon geometry');
  }
  return feature.geometry as GeoJSON.Polygon;
}

export interface EarthquakeGeometry {
  geometry: GeoJSON.Polygon;
  mmi_radii_km: Record<string, number>;
}

/**
 * Derive the earthquake footprint geometry from an epicenter + a moment
 * magnitude: the MMI-VI damage circle (`geometry`) plus the MMI VI/VII/VIII
 * shell radii (`mmi_radii_km`, omitting any non-positive radius).
 */
export function earthquakeFootprintGeometry(
  epicenter: GeoJSON.Point,
  magnitude: number,
): EarthquakeGeometry {
  const mmi_radii_km: Record<string, number> = {};
  for (const mmi of [6, 7, 8]) {
    const r = mmiRadiusKm(magnitude, mmi);
    if (r > 0) mmi_radii_km[String(mmi)] = r;
  }
  const radiusKm = Math.max(MIN_BUFFER_KM, mmiRadiusKm(magnitude, DAMAGE_THRESHOLD_MMI));
  return { geometry: bufferEpicenterCircle(epicenter, radiusKm), mmi_radii_km };
}

/**
 * Rebuild a footprint under a new severity / effective date — used when the
 * operator changes the SeverityStrip after a footprint already exists.
 *
 * - earthquake: the circle radius is a function of Mw, so geometry and the
 *   MMI shell radii are recomputed from the stored epicenter.
 * - tornado: the swath width is a function of the EF level, so the stored
 *   centerline is re-buffered to the new width.
 * - hail / flood / wildfire / winter: geometry is severity-independent, so
 *   only severity, the derived intensity, and effective_date change.
 */
export function rebuildFootprint(
  fp: SimulationFootprint,
  severity: SeverityValue,
  effectiveDate: string,
): SimulationFootprint {
  if (fp.peril === 'earthquake' && fp.epicenter) {
    const eq = earthquakeFootprintGeometry(fp.epicenter, severity as number);
    return buildFootprint({
      peril: 'earthquake',
      severity,
      geometry: eq.geometry,
      epicenter: fp.epicenter,
      mmi_radii_km: eq.mmi_radii_km,
      effective_date: effectiveDate,
      drawn_by: fp.metadata.drawn_by,
      chips: fp.metadata.chips,
    });
  }
  if (fp.peril === 'tornado' && fp.centerline) {
    const width_m = tornadoWidthM(severity);
    return buildFootprint({
      peril: 'tornado',
      severity,
      geometry: bufferTornadoSwath(fp.centerline, width_m),
      centerline: fp.centerline,
      width_m,
      effective_date: effectiveDate,
      drawn_by: fp.metadata.drawn_by,
      chips: fp.metadata.chips,
    });
  }
  return buildFootprint({
    peril: fp.peril,
    severity,
    geometry: fp.geometry,
    inner_geometry: fp.inner_geometry,
    centerline: fp.centerline,
    width_m: fp.width_m,
    effective_date: effectiveDate,
    drawn_by: fp.metadata.drawn_by,
    chips: fp.metadata.chips,
  });
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateFootprint(fp: SimulationFootprint): ValidationResult {
  const ring = fp.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    return { ok: false, reason: 'Polygon ring must have >= 4 vertices (3 unique + closing)' };
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return { ok: false, reason: 'Polygon ring must be closed (first vertex repeated as last)' };
  }
  if (fp.peril === 'tornado' && (!fp.width_m || fp.width_m <= 0)) {
    return { ok: false, reason: 'Tornado footprint requires positive width_m' };
  }
  if (fp.peril === 'earthquake' && !fp.epicenter) {
    return { ok: false, reason: 'Earthquake footprint requires epicenter' };
  }
  return { ok: true };
}

export { isValidSimId };
```

> Note: `validateFootprint` above is unchanged from the current implementation — it does not yet check `severity`, and `parseFootprint` does not yet exist. Both are added in Task 5. The Task 4 test file deliberately uses only geometry-level `validateFootprint` cases.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/sim/footprint.test.ts`
Expected: PASS — all blocks green.

- [ ] **Step 5: Confirm the wider TS suite still passes**

Run: `npx vitest run tests/lib/sim/`
Expected: PASS — `severity.test.ts`, `footprint.test.ts`, `preview.test.ts`, `id.test.ts` all green. (`preview.test.ts` still passes: it constructs footprints with `intensity` and `previewImpact` resolves them via the legacy fallback — `preview.ts` itself is updated in Task 9.)

- [ ] **Step 6: Commit**

```bash
git add lib/sim/footprint.ts tests/lib/sim/footprint.test.ts
git commit -m "feat(sim): footprint carries canonical severity, derives intensity"
```

---

### Task 5: `footprint.ts` — `validateFootprint` severity checks + `parseFootprint` normaliser

Make `validateFootprint` reject a missing or out-of-scale `severity`, and add `parseFootprint` to normalise footprints read back from storage. Also add `severity` to the footprint literals in the three API tests so their `POST /api/sim` calls keep passing.

**Files:**
- Modify: `lib/sim/footprint.ts` (`validateFootprint`; add `parseFootprint`; extend imports)
- Test: `tests/lib/sim/footprint.test.ts` (replace the `validateFootprint` block, add `parseFootprint`)
- Modify: `tests/api/sim/route.test.ts`, `tests/api/sim/retire.test.ts`, `tests/api/sim/promote.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/lib/sim/footprint.test.ts`, update the import block to add `parseFootprint` and the `SimulationFootprint` type:

```typescript
import {
  buildFootprint,
  bufferTornadoSwath,
  validateFootprint,
  parseFootprint,
  mmiRadiusKm,
  earthquakeFootprintGeometry,
  rebuildFootprint,
  type SimulationFootprint,
} from '@/lib/sim/footprint';
```

Then **replace** the entire `describe('validateFootprint (geometry)', ...)` block with:

```typescript
describe('validateFootprint', () => {
  test('rejects a degenerate polygon ring', () => {
    const fp = buildFootprint({
      peril: 'flood', severity: 'minor',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] } as unknown as GeoJSON.Polygon,
      effective_date: '2026-05-22', drawn_by: 'x',
    });
    const r = validateFootprint(fp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ring/i);
  });
  test('rejects a footprint with no severity', () => {
    const fp = buildFootprint({
      peril: 'flood', severity: 'minor', geometry: SQUARE,
      effective_date: '2026-05-22', drawn_by: 'x',
    });
    delete (fp as { severity?: unknown }).severity;
    const r = validateFootprint(fp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/severity/i);
  });
  test('rejects a severity outside a continuous scale range', () => {
    const fp = buildFootprint({
      peril: 'earthquake', severity: 7.0, geometry: SQUARE, epicenter: EPICENTER,
      effective_date: '2026-05-22', drawn_by: 'x',
    });
    fp.severity = 12.0; // above the Mw 9.0 max
    const r = validateFootprint(fp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/severity/i);
  });
  test('rejects a severity that is not a valid discrete level', () => {
    const fp = buildFootprint({
      peril: 'tornado', severity: 'ef3', geometry: SQUARE,
      centerline: { type: 'LineString', coordinates: [[-82, 27], [-82, 28]] },
      width_m: 240, effective_date: '2026-05-22', drawn_by: 'x',
    });
    fp.severity = 'ef9';
    expect(validateFootprint(fp).ok).toBe(false);
  });
  test('accepts a valid footprint', () => {
    const fp = buildFootprint({
      peril: 'flood', severity: 'moderate', geometry: SQUARE,
      effective_date: '2026-05-22', drawn_by: 'x',
    });
    expect(validateFootprint(fp).ok).toBe(true);
  });
});

describe('parseFootprint', () => {
  test('passes a modern footprint (with severity) through unchanged', () => {
    const fp = buildFootprint({
      peril: 'hail', severity: 45, geometry: SQUARE,
      effective_date: '2026-05-22', drawn_by: 'x',
    });
    expect(parseFootprint(fp).severity).toBe(45);
  });
  test('derives a continuous severity for a legacy footprint (intensity only)', () => {
    const legacy = {
      peril: 'hail', intensity: 'severe', geometry: SQUARE,
      effective_date: '2026-05-22',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-22T00:00:00Z' },
    } as unknown as SimulationFootprint;
    expect(parseFootprint(legacy).severity).toBe(45); // severe hail -> 45 mm
  });
  test('derives a discrete severity for a legacy tornado footprint', () => {
    const legacy = {
      peril: 'tornado', intensity: 'catastrophic', geometry: SQUARE,
      effective_date: '2026-05-22',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-22T00:00:00Z' },
    } as unknown as SimulationFootprint;
    expect(parseFootprint(legacy).severity).toBe('ef5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/sim/footprint.test.ts`
Expected: FAIL — `parseFootprint` is not exported; the new `validateFootprint` severity cases fail (current `validateFootprint` does not check `severity`).

- [ ] **Step 3: Implement in `lib/sim/footprint.ts`**

Update the `severity` import block at the top of `lib/sim/footprint.ts` to:

```typescript
import {
  legacyTier,
  severityFromLegacy,
  tornadoWidthM,
  PERIL_SCALES,
  type Peril,
  type Intensity,
  type SeverityValue,
} from './severity';
```

In `validateFootprint`, insert the severity check **immediately before** the final `return { ok: true };`:

```typescript
  if (fp.severity === undefined || fp.severity === null) {
    return { ok: false, reason: 'Footprint requires a severity value' };
  }
  const scale = PERIL_SCALES[fp.peril];
  if (scale.kind === 'continuous') {
    if (typeof fp.severity !== 'number' || fp.severity < scale.min || fp.severity > scale.max) {
      return {
        ok: false,
        reason: `severity must be a number in [${scale.min}, ${scale.max}] for ${fp.peril}`,
      };
    }
  } else if (!scale.levels.some((l) => l.id === fp.severity)) {
    return { ok: false, reason: `severity '${fp.severity}' is not a valid ${fp.peril} scale level` };
  }
```

Then add `parseFootprint` **immediately after** `validateFootprint` (before `export { isValidSimId };`):

```typescript
/**
 * Normalise a footprint read back from storage. Footprints persisted before
 * the per-peril severity scales carry `intensity` but no `severity`; derive a
 * representative `severity` for them via severityFromLegacy(). Modern
 * footprints already carry `severity` and pass through unchanged. Apply at
 * every stored-footprint read site (see spec "Backward compatibility").
 */
export function parseFootprint(raw: SimulationFootprint): SimulationFootprint {
  if (raw.severity !== undefined && raw.severity !== null) return raw;
  return { ...raw, severity: severityFromLegacy(raw.peril, raw.intensity) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/sim/footprint.test.ts`
Expected: PASS — all blocks green.

- [ ] **Step 5: Add `severity` to the API-test footprint literals**

`validateFootprint` now rejects a missing `severity`, so the `POST /api/sim` calls in three tests must include one.

In `tests/api/sim/route.test.ts`, in the `persists a draft` test, change the footprint literal so it reads:

```typescript
      footprint: {
        peril: 'hail',
        intensity: 'severe',
        severity: 45,
        geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
        effective_date: '2026-05-18',
        metadata: { drawn_by: 'tester', drawn_at: '2026-05-18T00:00:00Z' },
      },
```

In `tests/api/sim/retire.test.ts`, in the `flips retired=1` test, change the footprint literal so it reads:

```typescript
        footprint: {
          peril: 'hail',
          intensity: 'severe',
          severity: 45,
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
```

In `tests/api/sim/promote.test.ts` there are **two** footprint literals. In the `flips promoted=1` test (peril `hail`) add `severity: 45`:

```typescript
        footprint: {
          peril: 'hail',
          intensity: 'severe',
          severity: 45,
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
```

In the `is idempotent` test (peril `flood`) add `severity: 'moderate'`:

```typescript
        footprint: {
          peril: 'flood',
          intensity: 'moderate',
          severity: 'moderate',
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
```

- [ ] **Step 6: Run the API test suite to verify it passes**

Run: `npx vitest run tests/api/sim/`
Expected: PASS — `route.test.ts`, `retire.test.ts`, `promote.test.ts` green (the `promote` tests have a 30 s timeout; allow them to run).

- [ ] **Step 7: Commit**

```bash
git add lib/sim/footprint.ts tests/lib/sim/footprint.test.ts \
        tests/api/sim/route.test.ts tests/api/sim/retire.test.ts tests/api/sim/promote.test.ts
git commit -m "feat(sim): validateFootprint checks severity; add parseFootprint normaliser"
```

---

### Task 6: `SeverityStrip` — peril-aware on-map severity control

Create the new component. It replaces `IntensityStrip` (deleted in Task 7).

> **Build note:** `npm run build` is still red after this task (SimMap/SimWorkspace not yet updated). `SeverityStrip.tsx` itself compiles — it only depends on `severity.ts` and `footprint.ts`, both complete.

**Files:**
- Create: `components/sim/SeverityStrip.tsx`
- Test: `tests/components/sim/SeverityStrip.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/sim/SeverityStrip.test.tsx`:

```typescript
// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SeverityStrip } from '@/components/sim/SeverityStrip';

afterEach(() => cleanup());

const noop = () => {};

describe('SeverityStrip', () => {
  test('renders a range slider + readout for a continuous peril (earthquake)', () => {
    render(
      <SeverityStrip peril="earthquake" severity={7.0} onSeverityChange={noop}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(screen.getByText(/M7\.0/)).toBeInTheDocument();
  });

  test('renders six EF buttons for a discrete peril (tornado)', () => {
    render(
      <SeverityStrip peril="tornado" severity="ef3" onSeverityChange={noop}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    for (const ef of ['EF0', 'EF1', 'EF2', 'EF3', 'EF4', 'EF5']) {
      expect(screen.getByRole('button', { name: new RegExp(ef) })).toBeInTheDocument();
    }
  });

  test('clicking an EF button calls onSeverityChange with the level id', () => {
    const onSeverityChange = vi.fn();
    render(
      <SeverityStrip peril="tornado" severity="ef3" onSeverityChange={onSeverityChange}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /EF5/ }));
    expect(onSeverityChange).toHaveBeenCalledWith('ef5');
  });

  test('moving the slider calls onSeverityChange with a number', () => {
    const onSeverityChange = vi.fn();
    render(
      <SeverityStrip peril="hail" severity={45} onSeverityChange={onSeverityChange}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    fireEvent.change(screen.getByRole('slider'), { target: { value: '60' } });
    expect(onSeverityChange).toHaveBeenCalledWith(60);
  });

  test('the card is lifted off the bottom edge and left-anchored (visibility fix)', () => {
    const { container } = render(
      <SeverityStrip peril="flood" severity="moderate" onSeverityChange={noop}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bottom-8');
    expect(card).toHaveClass('left-2');
    expect(card.className).not.toContain('right-2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/sim/SeverityStrip.test.tsx`
Expected: FAIL — `components/sim/SeverityStrip.tsx` does not exist.

- [ ] **Step 3: Create the component**

Create `components/sim/SeverityStrip.tsx`:

```typescript
'use client';
/**
 * SeverityStrip — peril-aware severity + effective-date control overlaid on
 * the SimMap. Replaces the universal three-tier IntensityStrip.
 *
 * Rendered off PERIL_SCALES[peril]: continuous perils (earthquake, hail) get
 * a range slider with a live readout; discrete perils (tornado, flood,
 * wildfire, winter) get a segmented row of scale-level buttons. See
 * lib/sim/severity.ts and research.md for the per-peril scales.
 *
 * Visibility fix (spec S5): the card sits at bottom-8 / left-2 — lifted clear
 * of the ~24 px MapLibre attribution bar, content-fit width, left-anchored so
 * the date control is never occluded by the bottom-right attribution widget.
 */
import {
  PERIL_SCALES,
  severityLabel,
  type Peril,
  type SeverityValue,
} from '@/lib/sim/severity';
import { mmiRadiusKm } from '@/lib/sim/footprint';

export interface SeverityStripProps {
  peril: Peril;
  severity: SeverityValue;
  onSeverityChange: (s: SeverityValue) => void;
  effectiveDate: string;
  onDateChange: (d: string) => void;
}

/** Live readout for a continuous control — earthquake appends the MMI-VI radius. */
function readout(peril: Peril, severity: SeverityValue): string {
  const label = severityLabel(peril, severity);
  if (peril === 'earthquake' && typeof severity === 'number') {
    return `${label} - ~${Math.round(mmiRadiusKm(severity, 6))} km radius`;
  }
  return label;
}

export function SeverityStrip({
  peril,
  severity,
  onSeverityChange,
  effectiveDate,
  onDateChange,
}: SeverityStripProps) {
  const scale = PERIL_SCALES[peril];
  return (
    <div className="absolute bottom-8 left-2 bg-slate-900/95 border border-slate-700 rounded-lg p-3 flex items-center gap-4 text-xs shadow-lg">
      <div className="flex items-center gap-3">
        <span className="text-slate-400 uppercase tracking-wide">Severity</span>
        {scale.kind === 'continuous' ? (
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={scale.min}
              max={scale.max}
              step={scale.step}
              value={typeof severity === 'number' ? severity : scale.default}
              onChange={(e) => onSeverityChange(Number(e.target.value))}
              className="w-40 accent-blue-500"
            />
            <span className="text-slate-200 tabular-nums whitespace-nowrap">
              {readout(peril, severity)}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {scale.levels.map((lvl) => (
              <button
                key={lvl.id}
                type="button"
                aria-pressed={severity === lvl.id}
                onClick={() => onSeverityChange(lvl.id)}
                className={`flex flex-col items-center px-2 py-1 rounded ${
                  severity === lvl.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <span className="font-medium">{lvl.label}</span>
                {lvl.sublabel && <span className="text-[10px] opacity-80">{lvl.sublabel}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-l border-slate-700 pl-4">
        <span className="text-slate-400">Effective</span>
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => onDateChange(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-slate-200"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/sim/SeverityStrip.test.tsx`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add components/sim/SeverityStrip.tsx tests/components/sim/SeverityStrip.test.tsx
git commit -m "feat(sim): add peril-aware SeverityStrip control"
```

---

### Task 7: `SimMap` — mount `SeverityStrip`, build footprints with `severity`

Switch `SimMap` to the severity API and delete `IntensityStrip`.

> **Build note:** after this task `SimMap.tsx` compiles, but `SimWorkspace.tsx` still passes the old `intensity` props to it — `npm run build` stays red until Task 8.

**Files:**
- Modify: `components/sim/SimMap.tsx`
- Delete: `components/sim/IntensityStrip.tsx`

- [ ] **Step 1: Update the imports**

In `components/sim/SimMap.tsx`, replace the import on line 31:

```typescript
import { buildFootprint, bufferTornadoSwath, earthquakeFootprintGeometry } from '@/lib/sim/footprint';
```

with (note `tornadoWidthM` comes from `severity`, and `SeverityStrip` replaces `IntensityStrip`):

```typescript
import { buildFootprint, bufferTornadoSwath, earthquakeFootprintGeometry } from '@/lib/sim/footprint';
import { SeverityStrip } from './SeverityStrip';
import { tornadoWidthM } from '@/lib/sim/severity';
```

Delete the old `import { IntensityStrip } from './IntensityStrip';` line (line 33).

Change the type import on line 35 from:

```typescript
import type { Peril, Intensity } from '@/lib/sim/severity';
```

to:

```typescript
import type { Peril, SeverityValue } from '@/lib/sim/severity';
```

- [ ] **Step 2: Update `SimMapProps`**

Replace the `intensity` / `onIntensityChange` fields in `SimMapProps` (lines 52-53) so the interface reads:

```typescript
export interface SimMapProps {
  peril: Peril;
  severity: SeverityValue;
  onSeverityChange: (s: SeverityValue) => void;
  effectiveDate: string;
  onEffectiveDateChange: (d: string) => void;
  onFootprintChange: (fp: SimulationFootprint) => void;
  currentFootprint: SimulationFootprint | null;
}
```

- [ ] **Step 3: Rewrite the `finish` callback**

Replace the entire body of the `draw.on('finish', ...)` callback (current lines 156-201) with:

```typescript
    draw.on('finish', (id: FeatureId) => {
      const { peril, severity, effectiveDate, onFootprintChange } = propsRef.current;
      const snapshot = draw.getSnapshot();
      const feat = snapshot.find((f) => f.id === id);
      if (!feat) return;

      let geometry: GeoJSON.Polygon;
      let centerline: GeoJSON.LineString | undefined;
      let width_m: number | undefined;
      let epicenter: GeoJSON.Point | undefined;
      let mmi_radii_km: Record<string, number> | undefined;

      if (feat.geometry.type === 'LineString' && peril === 'tornado') {
        centerline = feat.geometry as GeoJSON.LineString;
        width_m = tornadoWidthM(severity);
        geometry = bufferTornadoSwath(centerline, width_m);
      } else if (feat.geometry.type === 'Point' && peril === 'earthquake') {
        // Earthquake: the drawn feature is the epicenter; the footprint is the
        // MMI-VI damage circle derived from the epicenter + the Mw severity.
        epicenter = feat.geometry as GeoJSON.Point;
        const eq = earthquakeFootprintGeometry(epicenter, severity as number);
        geometry = eq.geometry;
        mmi_radii_km = eq.mmi_radii_km;
      } else if (feat.geometry.type === 'Polygon') {
        geometry = feat.geometry as GeoJSON.Polygon;
      } else {
        return;
      }

      onFootprintChange(
        buildFootprint({
          peril,
          severity,
          geometry,
          centerline,
          width_m,
          epicenter,
          mmi_radii_km,
          effective_date: effectiveDate,
          drawn_by: 'operator',
        }),
      );
    });
```

- [ ] **Step 4: Swap the overlay component**

Replace the `<IntensityStrip ... />` block at the end of the JSX (current lines 296-301) with:

```typescript
      <SeverityStrip
        peril={props.peril}
        severity={props.severity}
        onSeverityChange={props.onSeverityChange}
        effectiveDate={props.effectiveDate}
        onDateChange={props.onEffectiveDateChange}
      />
```

- [ ] **Step 5: Update the file docstring**

In the `SimMap` docstring near the top, change the line that mentions `IntensityStrip` (line 8) to read:

```
 * changes. The DrawToolbar + SeverityStrip overlays are positioned absolutely
```

- [ ] **Step 6: Delete `IntensityStrip`**

```bash
git rm components/sim/IntensityStrip.tsx
```

- [ ] **Step 7: Verify the TS test suite still passes**

Run: `npx vitest run`
Expected: PASS — the full Vitest suite is green (Vitest does not typecheck, so `SimWorkspace.tsx`'s transient type error does not surface here). `SimMap` has no component test; correctness is confirmed by `npm run build` in Task 8.

- [ ] **Step 8: Commit**

```bash
git add components/sim/SimMap.tsx
git commit -m "feat(sim): SimMap mounts SeverityStrip and builds footprints with severity"
```

---

### Task 8: `SimWorkspace` — `severity` state, peril-reset, rebuild effect, sim name

Swap `SimWorkspace`'s `intensity` state for `severity`. This closes the type-error window — `npm run build` returns to green.

**Files:**
- Modify: `components/sim/SimWorkspace.tsx`

- [ ] **Step 1: Update the imports**

In `components/sim/SimWorkspace.tsx`, change the two `@/lib/sim` imports (lines 22-23) to:

```typescript
import { rebuildFootprint, type SimulationFootprint } from '@/lib/sim/footprint';
import { PERIL_SCALES, severityLabel, type Peril, type SeverityValue } from '@/lib/sim/severity';
```

- [ ] **Step 2: Replace the `intensity` state with `severity`**

Replace the `peril` and `intensity` `useState` declarations (lines 37-40) with:

```typescript
  const [peril, setPeril] = useState<Peril>(props.initialFootprint?.peril ?? 'hail');
  const [severity, setSeverity] = useState<SeverityValue>(
    props.initialFootprint?.severity ??
      PERIL_SCALES[props.initialFootprint?.peril ?? 'hail'].default,
  );
```

- [ ] **Step 3: Add a `changePeril` helper that resets severity**

Immediately **after** the `useState` block (after the `currentFootprint` / `promoted` states, before the `useEffect` for `?peril=`), add:

```typescript
  // Switching peril resets severity to the new peril's scale default — a Mw
  // value is meaningless as a hail diameter, etc.
  function changePeril(p: Peril) {
    setPeril(p);
    setSeverity(PERIL_SCALES[p].default);
  }
```

- [ ] **Step 4: Route the `?peril=` effect through `changePeril`**

Replace the `?peril=` `useEffect` (lines 57-60) with:

```typescript
  // Honour ?peril= query param (set by PerilPicker links in other pages).
  useEffect(() => {
    const p = search.get('peril') as Peril | null;
    if (p) changePeril(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
```

- [ ] **Step 5: Build the sim name from `severityLabel`**

In `onFootprintChange`, replace the `name` field of the POST body (line 69) with:

```typescript
        name: `${fp.peril}, ${severityLabel(fp.peril, fp.severity)} - ${new Date().toISOString().slice(0, 10)}`,
```

- [ ] **Step 6: Re-key the rebuild effect on `severity`**

Replace the entire "Re-apply intensity / effective-date changes" `useEffect` (lines 89-104) with:

```typescript
  // Re-apply severity / effective-date changes to an existing footprint.
  // Without this the SeverityStrip silently does nothing once a footprint is
  // drawn — the impact panel and the stored sim stay frozen at draw-time
  // values. For earthquake this resizes the Mw-derived circle; for tornado it
  // re-buffers the swath to the new EF width.
  useEffect(() => {
    if (!currentFootprint) return;
    if (
      currentFootprint.severity === severity &&
      currentFootprint.effective_date === effectiveDate
    ) {
      return;
    }
    onFootprintChange(rebuildFootprint(currentFootprint, severity, effectiveDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity, effectiveDate]);
```

- [ ] **Step 7: Update the `PerilPicker` and `SimMap` props**

Change the `<PerilPicker ... />` (line 110) to:

```typescript
        <PerilPicker active={peril} onChange={changePeril} />
```

Change the `<SimMap ... />` props (lines 120-128) so they read:

```typescript
        <SimMap
          peril={peril}
          severity={severity}
          onSeverityChange={setSeverity}
          effectiveDate={effectiveDate}
          onEffectiveDateChange={setEffectiveDate}
          onFootprintChange={onFootprintChange}
          currentFootprint={currentFootprint}
        />
```

- [ ] **Step 8: Update the file docstring**

In the `SimWorkspace` docstring, change the `State:` line (line 9) to:

```
 * State: activePeril, severity, effectiveDate, currentFootprint, simId.
```

- [ ] **Step 9: Verify the build and the full test suite**

Run: `npm run build`
Expected: SUCCESS — no TypeScript errors. This is the first task where `npm run build` is green again.

Run: `npx vitest run`
Expected: PASS — full Vitest suite green.

- [ ] **Step 10: Commit**

```bash
git add components/sim/SimWorkspace.tsx
git commit -m "feat(sim): SimWorkspace drives per-peril severity state"
```

---

### Task 9: `preview.ts` — score the preview off `severity`

Point the client-side preview at the footprint's `severity` (falling back to the legacy `intensity` for un-normalised footprints).

**Files:**
- Modify: `lib/sim/preview.ts:66`
- Test: `tests/lib/sim/preview.test.ts` (add `severity` to the literals; add one new case)

- [ ] **Step 1: Write the failing test**

In `tests/lib/sim/preview.test.ts`, add `severity: 45` to each of the three footprint literals (each is `peril: 'hail'`), so for example the first becomes:

```typescript
    const result = previewImpact(POLICIES, {
      peril: 'hail',
      intensity: 'severe',
      severity: 45,
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    });
```

Apply the same `severity: 45` addition to the literal in the `empty polygon returns zeros` test and the `top_cohorts is sorted` test.

Then append this new describe block to the **end** of `tests/lib/sim/preview.test.ts`:

```typescript
describe('previewImpact honours per-peril severity', () => {
  test('a higher hail diameter produces a larger gross loss', () => {
    const base = {
      peril: 'hail' as const,
      intensity: 'severe' as const,
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    };
    const small = previewImpact(POLICIES, { ...base, severity: 25 });
    const large = previewImpact(POLICIES, { ...base, severity: 90 });
    expect(large.gross_loss_estimate).toBeGreaterThan(small.gross_loss_estimate);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/sim/preview.test.ts`
Expected: FAIL — the new case fails: `previewImpact` still reads `footprint.intensity`, so severity `25` vs `90` produce an identical loss.

- [ ] **Step 3: Update `previewImpact`**

In `lib/sim/preview.ts`, replace line 66:

```typescript
    const dr = damageRatio(footprint.peril, p.build_type, footprint.intensity);
```

with:

```typescript
    const dr = damageRatio(footprint.peril, p.build_type, footprint.severity ?? footprint.intensity);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/sim/preview.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/sim/preview.ts tests/lib/sim/preview.test.ts
git commit -m "feat(sim): preview impact scores off per-peril severity"
```

---

### Task 10: `api_py/sim_loss.py` — Python `_damage_multiplier` mirror

Mirror the per-peril multipliers in Python so the K=1000 loss generator honours `severity`, with the legacy `intensity` fallback. Per CLAUDE.md the TS and Python copies must stay in sync — the numbers below are identical to `PERIL_SCALES` and traced to `research.md`.

**Files:**
- Modify: `api_py/sim_loss.py`
- Test: `tests/api/test_sim_loss.py`

- [ ] **Step 1: Write the failing tests**

In `tests/api/test_sim_loss.py`, replace the `_footprint` helper (lines 34-42) with a version that accepts an optional `severity`:

```python
def _footprint(peril="hail", intensity="severe", severity=None):
    fp = {
        "peril": peril,
        "intensity": intensity,
        "geometry": TAMPA_POLY,
        "effective_date": "2026-05-18",
        "metadata": {"drawn_by": "test", "drawn_at": "2026-05-18T00:00:00Z"},
    }
    if severity is not None:
        fp["severity"] = severity
    return fp
```

Append these tests to the **end** of `tests/api/test_sim_loss.py`:

```python
def test_damage_multiplier_continuous_anchors():
    from api_py.sim_loss import _damage_multiplier
    assert _damage_multiplier("earthquake", 6.0) == pytest.approx(0.55)
    assert _damage_multiplier("earthquake", 7.0) == pytest.approx(1.0)
    assert _damage_multiplier("earthquake", 8.0) == pytest.approx(1.45)
    assert _damage_multiplier("hail", 25) == pytest.approx(0.55)
    assert _damage_multiplier("hail", 45) == pytest.approx(1.0)


def test_damage_multiplier_clamps_low():
    from api_py.sim_loss import _damage_multiplier
    # Below-range inputs clamp at the 0.05 floor (matches TS damageMultiplier).
    assert _damage_multiplier("earthquake", 1.0) == pytest.approx(0.05)
    assert _damage_multiplier("hail", 0) == pytest.approx(0.05)


def test_damage_multiplier_discrete():
    from api_py.sim_loss import _damage_multiplier
    assert _damage_multiplier("tornado", "ef0") == pytest.approx(0.325)
    assert _damage_multiplier("tornado", "ef3") == pytest.approx(1.0)
    assert _damage_multiplier("tornado", "ef5") == pytest.approx(1.45)
    assert _damage_multiplier("winter", "extreme") == pytest.approx(1.90)
    assert _damage_multiplier("flood", "major") == pytest.approx(1.45)


def test_damage_multiplier_legacy_tier_fallback():
    from api_py.sim_loss import _damage_multiplier
    # Footprints stored before the per-peril scales carry a tier string.
    assert _damage_multiplier("hail", "severe") == pytest.approx(1.0)
    assert _damage_multiplier("tornado", "moderate") == pytest.approx(0.55)
    assert _damage_multiplier("earthquake", "catastrophic") == pytest.approx(1.45)


def test_generate_honours_severity():
    # An EF5 tornado footprint produces strictly larger losses than EF0.
    big = generate_sim_losses(
        "1234567890123_abcdef02", _footprint(peril="tornado", severity="ef5"),
        SAMPLE_POLICIES, cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    small = generate_sim_losses(
        "1234567890123_abcdef02", _footprint(peril="tornado", severity="ef0"),
        SAMPLE_POLICIES, cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    assert big["losses"].sum() > small["losses"].sum()


def test_generate_legacy_intensity_fallback():
    # A footprint with only `intensity` (no `severity`) still produces losses.
    result = generate_sim_losses(
        "1234567890123_abcdef03", _footprint(peril="hail", intensity="severe"),
        SAMPLE_POLICIES, cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    assert result["losses"].sum() > 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/api/test_sim_loss.py -v`
Expected: FAIL — `_damage_multiplier` does not exist (`ImportError`).

- [ ] **Step 3: Add the multiplier table and function**

In `api_py/sim_loss.py`, **after** the `_INTENSITY_SCALE` line (line 41), insert:

```python
# Mirrors lib/sim/severity.ts PERIL_SCALES discrete multipliers — keep in sync.
# Modelling parameters anchored to the INTENSITY_SCALE spine (research.md).
_PERIL_LEVEL_MULT: dict[str, dict[str, float]] = {
    "tornado":  {"ef0": 0.325, "ef1": 0.55, "ef2": 0.775, "ef3": 1.0, "ef4": 1.225, "ef5": 1.45},
    "flood":    {"minor": 0.55, "moderate": 1.0, "major": 1.45},
    "wildfire": {"low": 0.55, "moderate": 1.0, "high": 1.45},
    "winter":   {"limited": 0.325, "minor": 0.55, "moderate": 1.0, "major": 1.45, "extreme": 1.90},
}


def _damage_multiplier(peril: str, severity) -> float:
    """Per-peril damage multiplier — mirrors lib/sim/severity.ts damageMultiplier.

    `severity` is a number for continuous perils (earthquake Mw, hail stone
    diameter mm) and a level id for discrete perils. A legacy tier string
    ('moderate' | 'severe' | 'catastrophic') falls back to _INTENSITY_SCALE so
    footprints stored before the per-peril scales still resolve. Numbers trace
    to research.md (S2c earthquake, S3b hail, S1c/S6b discrete)."""
    if peril == "earthquake":
        if isinstance(severity, (int, float)) and not isinstance(severity, bool):
            return max(0.05, 1.0 + 0.45 * (severity - 7.0))
        return _INTENSITY_SCALE.get(severity, 1.0)
    if peril == "hail":
        if isinstance(severity, (int, float)) and not isinstance(severity, bool):
            return max(0.05, 0.55 + 0.0225 * (severity - 25.0))
        return _INTENSITY_SCALE.get(severity, 1.0)
    levels = _PERIL_LEVEL_MULT.get(peril, {})
    if severity in levels:
        return levels[severity]
    return _INTENSITY_SCALE.get(severity, 1.0)
```

- [ ] **Step 4: Re-point `_damage_ratio` at `_damage_multiplier`**

Replace the entire `_damage_ratio` function (currently lines 59-63) with:

```python
def _damage_ratio(peril: str, build_type: str, severity) -> float:
    row = _HAZUS_MATRIX.get(build_type) or _HAZUS_MATRIX["wood_frame"]
    base = row.get(peril, 0.0)
    scaled = base * _damage_multiplier(peril, severity)
    return max(0.0, min(1.0, scaled))
```

- [ ] **Step 5: Read `severity` in `generate_sim_losses`**

In `generate_sim_losses`, **after** the line `intensity = footprint["intensity"]` (line 177), insert:

```python
    # Canonical per-peril severity; legacy footprints carry only `intensity`.
    severity = footprint.get("severity", intensity)
```

Then change the `dr_arr` line (line 217) from:

```python
    dr_arr = np.array([_damage_ratio(peril, p[4], intensity) for p in policy_list], dtype=float)
```

to:

```python
    dr_arr = np.array([_damage_ratio(peril, p[4], severity) for p in policy_list], dtype=float)
```

- [ ] **Step 6: Update the module docstring**

In the `Severity model:` block of the module docstring (line 13), change the line:

```
                       × intensity_scale[intensity]
```

to:

```
                       × damage_multiplier[peril][severity]
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pytest tests/api/test_sim_loss.py -v`
Expected: PASS — the new tests and every pre-existing test green (the pre-existing tests pass `intensity` only and resolve via the legacy fallback).

- [ ] **Step 8: Run the dependent Python sim tests**

Run: `pytest tests/scripts/test_precompute_with_sims.py tests/eval/test_sim_end_to_end.py -v`
Expected: PASS — these feed footprints carrying only `intensity`; the fallback keeps them green.

- [ ] **Step 9: Commit**

```bash
git add api_py/sim_loss.py tests/api/test_sim_loss.py
git commit -m "feat(sim): mirror per-peril damage multiplier in sim_loss.py"
```

---

### Task 11: API + page — derived `intensity` column, `parseFootprint` on read

Make `POST /api/sim` store the derived `legacyTier` value in the `intensity` column, and normalise every stored-footprint read with `parseFootprint` so old sims gain a `severity`.

**Files:**
- Modify: `app/api/sim/route.ts`
- Modify: `app/api/sim/[id]/route.ts`
- Modify: `app/simulate/page.tsx`
- Test: `tests/api/sim/route.test.ts` (add one assertion)

- [ ] **Step 1: Write the failing test**

In `tests/api/sim/route.test.ts`, add a new test inside the `describe('GET /api/sim/[id]', ...)` block (after the existing `returns 404` test):

```typescript
  test('normalises a stored footprint so it carries a severity', async () => {
    const create = await POST(await jsonRequest({
      name: 'Severity read test',
      footprint: {
        peril: 'hail',
        intensity: 'severe',
        severity: 60,
        geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
        effective_date: '2026-05-22',
        metadata: { drawn_by: 'tester', drawn_at: '2026-05-22T00:00:00Z' },
      },
    }));
    const { sim_id } = await create.json();
    const res = await GET_BY_ID(new Request('http://localhost'), {
      params: Promise.resolve({ id: sim_id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.footprint.severity).toBe(60);
  });
```

(`POST`, `GET_BY_ID`, and `jsonRequest` are already imported / defined at the top of the file.)

- [ ] **Step 2: Run test to verify it fails or passes trivially**

Run: `npx vitest run tests/api/sim/route.test.ts -t "normalises a stored footprint"`
Expected: PASS already — the footprint is POSTed *with* `severity: 60`, so it round-trips even before `parseFootprint` is wired in. This test is a regression guard; it must still pass after Step 3-4 and proves the read path does not strip `severity`.

- [ ] **Step 3: Derive the `intensity` column in `POST /api/sim`**

In `app/api/sim/route.ts`, change the import on line 12 to add `legacyTier`:

```typescript
import { validateFootprint, type SimulationFootprint } from '@/lib/sim/footprint';
import { legacyTier } from '@/lib/sim/severity';
```

In the `POST` handler, **after** the `validateFootprint` check (after line 71) and **before** `const id = newSimId();`, add:

```typescript
  // The intensity column is now a derived legacy tier, not an operator input.
  const intensityTier = legacyTier(fp.peril, fp.severity);
```

Then in the `INSERT` statement's `args` array (line 79), replace `fp.intensity` with `intensityTier`:

```typescript
    args: [id, name, fp.peril, intensityTier, JSON.stringify(fp), fp.effective_date,
           fp.metadata.drawn_by, now],
```

- [ ] **Step 4: Apply `parseFootprint` on the single-sim read**

In `app/api/sim/[id]/route.ts`, change the import on line 7 to also pull in `parseFootprint`:

```typescript
import { isValidSimId } from '@/lib/sim/id';
import { parseFootprint } from '@/lib/sim/footprint';
```

Change the `footprint` field of the JSON response (line 33) from:

```typescript
    footprint: JSON.parse(String(row.footprint)),
```

to:

```typescript
    footprint: parseFootprint(JSON.parse(String(row.footprint))),
```

- [ ] **Step 5: Apply `parseFootprint` on the `/simulate` page read**

In `app/simulate/page.tsx`, change the import on line 10 to:

```typescript
import { parseFootprint, type SimulationFootprint } from '@/lib/sim/footprint';
```

Change the footprint read (line 32) from:

```typescript
    if (r.rows[0]) initialFootprint = JSON.parse(String(r.rows[0].footprint));
```

to:

```typescript
    if (r.rows[0]) initialFootprint = parseFootprint(JSON.parse(String(r.rows[0].footprint)));
```

- [ ] **Step 6: Run the API test suite**

Run: `npx vitest run tests/api/sim/`
Expected: PASS — `route.test.ts` (including the new case), `retire.test.ts`, `promote.test.ts` all green.

- [ ] **Step 7: Full verification**

Run: `npm run build`
Expected: SUCCESS — no TypeScript errors.

Run: `npm test`
Expected: PASS — the full Vitest suite green.

Run: `pytest tests/api/test_sim_loss.py tests/scripts/test_precompute_with_sims.py tests/eval/test_sim_end_to_end.py -v`
Expected: PASS — all Python sim tests green.

- [ ] **Step 8: Commit**

```bash
git add app/api/sim/route.ts app/api/sim/[id]/route.ts app/simulate/page.tsx tests/api/sim/route.test.ts
git commit -m "feat(sim): store derived intensity tier; normalise footprints on read"
```

---

## Spec coverage check

| Spec section | Task(s) |
|---|---|
| Per-peril scale registry (`PERIL_SCALES`, `PerilScale`, `ScaleLevel`) | 1 |
| `damageMultiplier`, `severityLabel`, `legacyTier`, `severityFromLegacy` | 2 |
| `tornadoWidthM` (DRY helper for SimMap + rebuildFootprint) | 2 |
| `damageRatio` takes `SeverityValue` | 3 |
| Footprint `severity` field; derived `intensity`; drop `magnitude` + `EARTHQUAKE_MAGNITUDE` | 4 |
| `earthquakeFootprintGeometry` from Mw; `rebuildFootprint` per-peril geometry | 4 |
| `validateFootprint` severity checks; `parseFootprint` normaliser | 5 |
| `SeverityStrip` peril-aware control + visibility/occlusion fix | 6 |
| `SimMap` wiring (`finish` builds with `severity`) | 7 |
| `SimWorkspace` (`severity` state, peril-reset, rebuild effect, sim name) | 8 |
| `preview.ts` scores off `severity` | 9 |
| Python `_damage_multiplier` mirror + legacy fallback | 10 |
| API derived `intensity` column; `parseFootprint` on read; backward compatibility | 5, 11 |

**Non-goals respected:** `HAZUS_MATRIX` cells unchanged (only the multiplier changes); no earthquake drag-to-resize; no DB migration (`simulations.intensity` reused); cohort key / MIP / Decision Reconciler untouched.

**Design decision recorded in the plan (not explicit in the spec):** the earthquake slider's `min` is Mw 5.0, but the MMI-VI damage radius is zero below ~Mw 5.5. `earthquakeFootprintGeometry` floors the *buffer* radius at 0.5 km (`MIN_BUFFER_KM`) so the footprint always has a constructible Polygon; `mmi_radii_km` still honestly omits any zero-radius shell. This is a degenerate-case guard, not a measurement.
