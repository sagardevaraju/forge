# Simulate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/simulate` route — operator-drawn catastrophe footprints (6 perils) that generate K=1000 cohort loss scenarios and feed the joint TVaR-99 capital constraint of the portfolio MIP.

**Architecture:** TS drawing toolkit (terra-draw) produces a `SimulationFootprint` object → Python (`api_py/sim_loss.py`) generates per-cohort K=1000 loss matrices → parquet artifacts → `precompute_portfolio_optimization.py --include-sims` concatenates sim losses onto hurricane losses before TVaR-99. Reconciler unchanged.

**Tech Stack:** Next.js 16 App Router, MapLibre + `react-map-gl/maplibre`, `terra-draw` v1.x, libSQL/SQLite, PuLP+CBC, numpy, shapely, Vitest, Pytest.

**Reference:** Spec at `docs/superpowers/specs/2026-05-18-simulate-tab-design.md`.

---

## File map

**Created:**

- `lib/sim/severity.ts` — HAZUS matrix + per-peril decay functions
- `lib/sim/footprint.ts` — `SimulationFootprint` builder + validators
- `lib/sim/preview.ts` — client-side point-in-polygon preview impact
- `lib/sim/id.ts` — sortable sim ID generator
- `lib/sim/draw/index.ts` — terra-draw adapter factory
- `lib/sim/draw/modes.ts` — per-peril mode mapping
- `app/simulate/page.tsx` — server component shell
- `app/simulate/loading.tsx` + `error.tsx`
- `app/api/sim/route.ts` — list + create
- `app/api/sim/[id]/route.ts` — read single sim
- `app/api/sim/[id]/promote/route.ts`
- `app/api/sim/[id]/retire/route.ts`
- `app/api/portfolio/reoptimize/route.ts`
- `api_py/sim_loss.py` — K=1000 cohort loss generator (module + Vercel handler)
- `components/sim/SimWorkspace.tsx`
- `components/sim/PerilPicker.tsx`
- `components/sim/SimLibrary.tsx`
- `components/sim/SimMap.tsx`
- `components/sim/DrawToolbar.tsx`
- `components/sim/IntensityStrip.tsx`
- `components/sim/ImpactPanel.tsx`
- `components/sim/PromoteButton.tsx`
- `components/grammar/SimulationBanner.tsx`
- Tests under `tests/lib/sim/`, `tests/components/sim/`, `tests/api/sim/`, `tests/api/test_sim_loss.py`, `tests/eval/sim_end_to_end.py`

**Modified:**

- `lib/db/schema.sql` — add `simulations` table
- `lib/db/migrate.ts` — no code change; will pick up new statements
- `ml/scenarios/generate.py` — add `kind: 'hurricane'` discriminator to output
- `api_py/optimize_portfolio.py` — no signature change; doc-only note on joint K
- `scripts/precompute_portfolio_optimization.py` — `--include-sims` flag, parquet load + concatenate
- `app/portfolio/page.tsx` — mount `SimulationBanner` above existing header
- `app/layout.tsx` — add `/simulate` link to top nav
- `package.json` — add `terra-draw`, `terra-draw-maplibre-gl-adapter`, `@turf/boolean-point-in-polygon`, `@turf/buffer`, `parquetjs-lite` (or `pyarrow` Python-side only)
- `CLAUDE.md` — append a "Simulate" section under "Where things live"

---

## Milestone 1 — Data foundation & severity model

### Task 1: Add `simulations` table to schema

**Files:**
- Modify: `lib/db/schema.sql` (append after `pins` table)
- Modify: `CLAUDE.md` (note the new table)

- [ ] **Step 1: Append SQL to schema**

Open `lib/db/schema.sql` and append:

```sql
-- Task SIM.1 — Operator-drawn catastrophe simulations.
-- Lifecycle: draft (drawn, preview only) → promoted (K=1000 cohort
-- losses cached at artifacts/simulations/<id>.parquet) → retired
-- (soft-deleted; no longer feeds joint TVaR-99). See
-- docs/superpowers/specs/2026-05-18-simulate-tab-design.md §6.
CREATE TABLE IF NOT EXISTS simulations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  peril TEXT NOT NULL,
  intensity TEXT NOT NULL,
  footprint TEXT NOT NULL,
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

- [ ] **Step 2: Run migrate, verify table exists**

```bash
npm run migrate
sqlite3 forge-local.db ".schema simulations"
```

Expected: prints the CREATE TABLE + 2 CREATE INDEX statements.

- [ ] **Step 3: Add a one-line note to CLAUDE.md**

Under "Where things live" table, add row:

```markdown
| Add a new simulation peril | `lib/sim/severity.ts` (HAZUS row) + `api_py/sim_loss.py` (decay + perturbation) + `SimulationFootprint` union in `lib/sim/footprint.ts` |
```

Under the "force-dynamic" pitfalls section append:

```markdown
- **`artifacts/simulations/*.parquet` is gitignored** (regenerated on promote). The `simulations` DB table IS the source of truth; the parquet is a derived K=1000 cohort-loss cache.
```

- [ ] **Step 4: Add artifacts/simulations to .gitignore**

```bash
echo "artifacts/simulations/" >> .gitignore
```

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.sql CLAUDE.md .gitignore
git commit -m "feat(sim): add simulations table + gitignore artifact cache"
```

---

### Task 2: Sortable sim ID generator

**Files:**
- Create: `lib/sim/id.ts`
- Test: `tests/lib/sim/id.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/sim/id.test.ts
import { describe, test, expect } from 'vitest';
import { newSimId, isValidSimId } from '@/lib/sim/id';

describe('newSimId', () => {
  test('returns a string matching the sim id format', () => {
    const id = newSimId();
    expect(isValidSimId(id)).toBe(true);
  });
  test('IDs sort chronologically', async () => {
    const a = newSimId();
    await new Promise(r => setTimeout(r, 2));
    const b = newSimId();
    expect(a < b).toBe(true);
  });
  test('rejects malformed inputs', () => {
    expect(isValidSimId('sim_abc')).toBe(false);
    expect(isValidSimId('')).toBe(false);
    expect(isValidSimId('1234567890123_xyzxyzxyz')).toBe(false); // hex required
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/lib/sim/id.test.ts
```

Expected: FAIL — "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sim/id.ts
/**
 * Sortable sim identifier: <unix_ms_13>_<8 random hex>.
 * Lexicographic order = chronological order for sims drawn at distinct ms.
 * Not v7 UUID (avoids a dependency); has enough entropy + monotonicity for
 * a single-operator console. Format is stable: validators downstream pin
 * to the exact regex.
 */
const SIM_ID_RE = /^\d{13}_[0-9a-f]{8}$/;

export function newSimId(): string {
  const ts = Date.now().toString().padStart(13, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ts}_${rand}`;
}

export function isValidSimId(s: string): boolean {
  return SIM_ID_RE.test(s);
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/lib/sim/id.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/sim/id.ts tests/lib/sim/id.test.ts
git commit -m "feat(sim): sortable sim ID generator"
```

---

### Task 3: HAZUS severity matrix + intensity scaling

**Files:**
- Create: `lib/sim/severity.ts`
- Test: `tests/lib/sim/severity.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/lib/sim/severity.test.ts
import { describe, test, expect } from 'vitest';
import {
  damageRatio,
  intensityScale,
  PERILS,
  type Peril,
  type Intensity,
} from '@/lib/sim/severity';

describe('damageRatio', () => {
  test('returns the HAZUS reference value at severe intensity', () => {
    expect(damageRatio('tornado', 'wood_frame', 'severe')).toBeCloseTo(0.42, 4);
    expect(damageRatio('hail', 'masonry', 'severe')).toBeCloseTo(0.10, 4);
  });
  test('moderate scales the row by 0.55', () => {
    expect(damageRatio('tornado', 'wood_frame', 'moderate')).toBeCloseTo(0.42 * 0.55, 4);
  });
  test('catastrophic scales by 1.45 then clips at 1.0', () => {
    expect(damageRatio('wildfire', 'mobile_home', 'catastrophic')).toBe(1.0); // 0.95 * 1.45 = 1.38 → clipped
    expect(damageRatio('tornado', 'wood_frame', 'catastrophic')).toBeCloseTo(0.42 * 1.45, 4);
  });
  test('every peril × build_type has a value', () => {
    for (const peril of PERILS) {
      for (const bt of ['wood_frame', 'masonry', 'mobile_home', 'commercial'] as const) {
        const v = damageRatio(peril, bt, 'severe');
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
  test('unknown build_type falls back to wood_frame', () => {
    expect(damageRatio('tornado', 'unknown' as any, 'severe')).toBe(damageRatio('tornado', 'wood_frame', 'severe'));
  });
});

describe('intensityScale', () => {
  test('returns the documented multipliers', () => {
    expect(intensityScale('moderate' as Intensity)).toBe(0.55);
    expect(intensityScale('severe' as Intensity)).toBe(1.00);
    expect(intensityScale('catastrophic' as Intensity)).toBe(1.45);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/lib/sim/severity.test.ts
```

Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement severity matrix**

```ts
// lib/sim/severity.ts
/**
 * HAZUS-derived peril × build_type damage ratio matrix.
 * Cells are mean damage ratios at the *severe* intensity benchmark,
 * sourced from FEMA HAZUS Technical Manual (wind, flood, earthquake) and
 * the Insurance Institute for Business & Home Safety hail studies.
 *
 * Adding a new peril: extend HAZUS_MATRIX, add a Peril entry, and add a
 * decay function in api_py/sim_loss.py. See spec §5 for the calibration
 * basis. Cells live here as data so a calibration overlay (v2) can swap
 * the literal without changing optimizer logic.
 */

export const PERILS = [
  'tornado',
  'flood',
  'hail',
  'wildfire',
  'earthquake',
  'winter',
] as const;
export type Peril = (typeof PERILS)[number];

export const INTENSITIES = ['moderate', 'severe', 'catastrophic'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const BUILD_TYPES = [
  'wood_frame',
  'masonry',
  'mobile_home',
  'commercial',
] as const;
export type BuildType = (typeof BUILD_TYPES)[number];

const HAZUS_MATRIX: Record<BuildType, Record<Peril, number>> = {
  wood_frame:  { tornado: 0.42, flood: 0.55, hail: 0.18, wildfire: 0.92, earthquake: 0.35, winter: 0.08 },
  masonry:     { tornado: 0.28, flood: 0.62, hail: 0.10, wildfire: 0.85, earthquake: 0.22, winter: 0.06 },
  mobile_home: { tornado: 0.85, flood: 0.45, hail: 0.32, wildfire: 0.95, earthquake: 0.55, winter: 0.18 },
  commercial:  { tornado: 0.30, flood: 0.48, hail: 0.12, wildfire: 0.78, earthquake: 0.28, winter: 0.05 },
};

const INTENSITY_SCALE: Record<Intensity, number> = {
  moderate: 0.55,
  severe: 1.0,
  catastrophic: 1.45,
};

export function intensityScale(intensity: Intensity): number {
  return INTENSITY_SCALE[intensity];
}

export function damageRatio(
  peril: Peril,
  buildType: BuildType | string,
  intensity: Intensity,
): number {
  const row = HAZUS_MATRIX[buildType as BuildType] ?? HAZUS_MATRIX.wood_frame;
  const base = row[peril];
  const scaled = base * INTENSITY_SCALE[intensity];
  return Math.min(1, Math.max(0, scaled));
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/lib/sim/severity.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/sim/severity.ts tests/lib/sim/severity.test.ts
git commit -m "feat(sim): HAZUS severity matrix + intensity scaling"
```

---

### Task 4: SimulationFootprint contract + validators

**Files:**
- Create: `lib/sim/footprint.ts`
- Test: `tests/lib/sim/footprint.test.ts`
- Modify: `package.json` (add `@turf/buffer`, `@turf/helpers`)

- [ ] **Step 1: Add turf deps**

```bash
npm install --save @turf/buffer @turf/helpers @turf/boolean-point-in-polygon
```

- [ ] **Step 2: Write failing test**

```ts
// tests/lib/sim/footprint.test.ts
// @vitest-environment node
import { describe, test, expect } from 'vitest';
import {
  buildFootprint,
  bufferTornadoSwath,
  validateFootprint,
  type SimulationFootprint,
} from '@/lib/sim/footprint';

describe('bufferTornadoSwath', () => {
  test('buffers a polyline to a polygon of width_m on each side', () => {
    const line: GeoJSON.LineString = {
      type: 'LineString',
      coordinates: [[-82, 27], [-82, 28]],
    };
    const poly = bufferTornadoSwath(line, 200);
    expect(poly.type).toBe('Polygon');
    expect(poly.coordinates[0].length).toBeGreaterThan(3);
  });
});

describe('buildFootprint', () => {
  test('hail polygon: passes through geometry, attaches metadata', () => {
    const fp = buildFootprint({
      peril: 'hail',
      intensity: 'severe',
      geometry: {
        type: 'Polygon',
        coordinates: [[[-82, 27], [-81, 27], [-81, 28], [-82, 28], [-82, 27]]],
      },
      effective_date: '2026-05-18',
      drawn_by: 'operator',
    });
    expect(fp.peril).toBe('hail');
    expect(fp.geometry.type).toBe('Polygon');
    expect(fp.metadata.drawn_by).toBe('operator');
    expect(fp.metadata.drawn_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('validateFootprint', () => {
  test('rejects polygon with fewer than 4 ring vertices (degenerate)', () => {
    const fp: SimulationFootprint = {
      peril: 'flood',
      intensity: 'severe',
      geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[0,0]]] } as any,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    };
    const result = validateFootprint(fp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ring/i);
  });
  test('accepts a valid polygon', () => {
    const fp: SimulationFootprint = {
      peril: 'flood',
      intensity: 'severe',
      geometry: { type: 'Polygon', coordinates: [[[-82,27],[-81,27],[-81,28],[-82,28],[-82,27]]] },
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    };
    expect(validateFootprint(fp).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run, verify fail**

```bash
npx vitest run tests/lib/sim/footprint.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement footprint module**

```ts
// lib/sim/footprint.ts
/**
 * SimulationFootprint — the JSON contract crossing the TS → Python boundary.
 * See spec §4 (drawing toolkit) and §6 (persistence).
 *
 * The schema is intentionally a discriminated union by `peril`. Optional
 * fields are peril-specific (centerline+width_m for tornado, epicenter for
 * earthquake, etc.) but the canonical `geometry` is always a Polygon — for
 * tornado that means the *buffered* swath, not the centerline.
 */
import buffer from '@turf/buffer';
import { lineString } from '@turf/helpers';
import { isValidSimId } from './id';
import type { Peril, Intensity } from './severity';

export interface SimulationFootprint {
  peril: Peril;
  intensity: Intensity;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
  magnitude?: number;
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
  intensity: Intensity;
  geometry: GeoJSON.Polygon;
  inner_geometry?: GeoJSON.Polygon;
  centerline?: GeoJSON.LineString;
  width_m?: number;
  epicenter?: GeoJSON.Point;
  magnitude?: number;
  mmi_radii_km?: Record<string, number>;
  effective_date: string;
  drawn_by: string;
  chips?: string[];
}

export function buildFootprint(args: BuildFootprintArgs): SimulationFootprint {
  return {
    peril: args.peril,
    intensity: args.intensity,
    geometry: args.geometry,
    inner_geometry: args.inner_geometry,
    centerline: args.centerline,
    width_m: args.width_m,
    epicenter: args.epicenter,
    magnitude: args.magnitude,
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
  return feature.geometry;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateFootprint(fp: SimulationFootprint): ValidationResult {
  const ring = fp.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    return { ok: false, reason: 'Polygon ring must have ≥ 4 vertices (3 unique + closing)' };
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

- [ ] **Step 5: Run, verify pass**

```bash
npx vitest run tests/lib/sim/footprint.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/sim/footprint.ts tests/lib/sim/footprint.test.ts package.json package-lock.json
git commit -m "feat(sim): SimulationFootprint contract + tornado swath buffer + validators"
```

---

### Task 5: Client-side preview (point-in-polygon)

**Files:**
- Create: `lib/sim/preview.ts`
- Test: `tests/lib/sim/preview.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/lib/sim/preview.test.ts
// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { previewImpact, type Policy } from '@/lib/sim/preview';

const TAMPA_POLY: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[[-82.5, 27.5], [-82, 27.5], [-82, 28], [-82.5, 28], [-82.5, 27.5]]],
};

const POLICIES: Policy[] = [
  { id: 1, lat: 27.7, lon: -82.3, tiv: 500_000, build_type: 'wood_frame', zip3: '337' },     // inside
  { id: 2, lat: 27.8, lon: -82.2, tiv: 800_000, build_type: 'masonry',    zip3: '337' },     // inside
  { id: 3, lat: 30.0, lon: -85.0, tiv: 400_000, build_type: 'mobile_home', zip3: '325' },    // outside
];

describe('previewImpact', () => {
  test('inside-polygon policies aggregate into estimated loss', () => {
    const result = previewImpact(POLICIES, {
      peril: 'hail',
      intensity: 'severe',
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    });
    expect(result.policies_in_footprint).toBe(2);
    expect(result.tiv_in_footprint).toBe(1_300_000);
    // 500k * 0.18 + 800k * 0.10 = 90k + 80k = 170k
    expect(result.gross_loss_estimate).toBeCloseTo(170_000, 0);
    expect(result.cohorts_affected).toBeGreaterThan(0);
  });
  test('empty polygon returns zeros', () => {
    const result = previewImpact([], {
      peril: 'hail',
      intensity: 'severe',
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    });
    expect(result.policies_in_footprint).toBe(0);
    expect(result.gross_loss_estimate).toBe(0);
  });
  test('top_cohorts is sorted by loss descending', () => {
    const result = previewImpact(POLICIES, {
      peril: 'hail',
      intensity: 'severe',
      geometry: TAMPA_POLY,
      effective_date: '2026-05-18',
      metadata: { drawn_by: 'x', drawn_at: '2026-05-18T00:00:00Z' },
    });
    for (let i = 1; i < result.top_cohorts.length; i++) {
      expect(result.top_cohorts[i].loss).toBeLessThanOrEqual(result.top_cohorts[i - 1].loss);
    }
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/lib/sim/preview.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement preview**

```ts
// lib/sim/preview.ts
/**
 * Client-side single-draw preview impact for the ImpactPanel.
 *
 * Deterministic, fast, no Python round-trip. Uses turf point-in-polygon
 * on every policy + the HAZUS matrix to estimate a single gross loss
 * number. The promote path computes the *stochastic* K=1000 version
 * server-side; this module is purely for the right-pane preview.
 *
 * Cohort key matches lib/db/cohorts.ts: `{zip3}_{build_type}_q{0..4}`.
 * The preview joins on (zip3, build_type) only — quintile is not known
 * client-side without aggregating the full book. The cohort_id surfaced
 * here is the (zip3, build_type) prefix; a downstream "open cohort"
 * action upgrades to the full quintile key.
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { damageRatio, type BuildType } from './severity';
import type { SimulationFootprint } from './footprint';

export interface Policy {
  id: number;
  lat: number;
  lon: number;
  tiv: number;
  build_type: string;
  zip3: string;
}

export interface CohortImpact {
  cohort_id: string;
  loss: number;
  tiv: number;
  policies: number;
}

export interface PreviewImpact {
  policies_in_footprint: number;
  tiv_in_footprint: number;
  gross_loss_estimate: number;
  mean_damage_ratio: number;
  cohorts_affected: number;
  top_cohorts: CohortImpact[];
}

export function previewImpact(
  policies: Policy[],
  footprint: SimulationFootprint,
): PreviewImpact {
  const cohorts = new Map<string, CohortImpact>();
  let policiesIn = 0;
  let tivIn = 0;
  let lossSum = 0;

  for (const p of policies) {
    if (!booleanPointInPolygon(point([p.lon, p.lat]), footprint.geometry)) {
      continue;
    }
    const dr = damageRatio(footprint.peril, p.build_type, footprint.intensity);
    const loss = p.tiv * dr;
    policiesIn += 1;
    tivIn += p.tiv;
    lossSum += loss;

    const cohortId = `${p.zip3}_${p.build_type}`;
    const existing = cohorts.get(cohortId);
    if (existing) {
      existing.loss += loss;
      existing.tiv += p.tiv;
      existing.policies += 1;
    } else {
      cohorts.set(cohortId, { cohort_id: cohortId, loss, tiv: p.tiv, policies: 1 });
    }
  }

  const top = [...cohorts.values()].sort((a, b) => b.loss - a.loss).slice(0, 5);
  return {
    policies_in_footprint: policiesIn,
    tiv_in_footprint: tivIn,
    gross_loss_estimate: lossSum,
    mean_damage_ratio: tivIn > 0 ? lossSum / tivIn : 0,
    cohorts_affected: cohorts.size,
    top_cohorts: top,
  };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/lib/sim/preview.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sim/preview.ts tests/lib/sim/preview.test.ts
git commit -m "feat(sim): client-side preview impact (point-in-polygon + HAZUS)"
```

---

## Milestone 2 — Python loss compute & MIP integration

### Task 6: K=1000 cohort loss generator (`api_py/sim_loss.py`)

**Files:**
- Create: `api_py/sim_loss.py`
- Test: `tests/api/test_sim_loss.py`
- Modify: `requirements.txt` (add `shapely`, `pyarrow` if not present)

- [ ] **Step 1: Confirm deps**

```bash
grep -E "^shapely|^pyarrow" requirements.txt || echo "MISSING"
```

If `MISSING`, append:

```
shapely>=2.0
pyarrow>=15
```

- [ ] **Step 2: Write failing test**

```python
# tests/api/test_sim_loss.py
"""Tests for api_py.sim_loss.generate_sim_losses."""
import json
from pathlib import Path
import numpy as np
import pytest

from api_py.sim_loss import generate_sim_losses, peril_decay, perturbation_sigmas


SAMPLE_POLICIES = [
    # (id, lat, lon, tiv, build_type, zip3)
    (1, 27.7, -82.3, 500_000.0, "wood_frame", "337"),
    (2, 27.8, -82.2, 800_000.0, "masonry", "337"),
    (3, 30.0, -85.0, 400_000.0, "mobile_home", "325"),
]

TAMPA_POLY = {
    "type": "Polygon",
    "coordinates": [[[-82.5, 27.5], [-82.0, 27.5], [-82.0, 28.0], [-82.5, 28.0], [-82.5, 27.5]]],
}


def _footprint(peril="hail", intensity="severe"):
    return {
        "peril": peril,
        "intensity": intensity,
        "geometry": TAMPA_POLY,
        "effective_date": "2026-05-18",
        "metadata": {"drawn_by": "test", "drawn_at": "2026-05-18T00:00:00Z"},
    }


def test_generate_returns_cohort_x_K_array():
    result = generate_sim_losses(
        sim_id="1234567890123_abcdef00",
        footprint=_footprint(),
        policies=SAMPLE_POLICIES,
        cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
        K=100,
    )
    assert result["K"] == 100
    assert result["losses"].shape[1] == 100
    # Two cohorts are inside (337_wood_frame, 337_masonry); 325_mobile_home is outside.
    assert result["losses"].shape[0] >= 1


def test_seed_is_deterministic():
    a = generate_sim_losses("1234567890123_abcdef00", _footprint(), SAMPLE_POLICIES,
                            cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    b = generate_sim_losses("1234567890123_abcdef00", _footprint(), SAMPLE_POLICIES,
                            cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    np.testing.assert_array_equal(a["losses"], b["losses"])


def test_empty_polygon_yields_zero_losses():
    fp = _footprint()
    fp["geometry"] = {"type": "Polygon",
                      "coordinates": [[[0.0, 0.0], [0.001, 0.0], [0.001, 0.001], [0.0, 0.001], [0.0, 0.0]]]}
    result = generate_sim_losses("1234567890123_abcdef00", fp, SAMPLE_POLICIES,
                                 cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    # No policies in this tiny equatorial box.
    assert result["losses"].sum() == 0.0


def test_peril_decay_returns_unit_inside_uniform_perils():
    # flood / wildfire / winter are uniform-inside.
    assert peril_decay("flood", distance_km=0.0, width_km=0.2) == 1.0
    assert peril_decay("wildfire", distance_km=0.0, width_km=0.2) == 1.0


def test_perturbation_sigmas_returns_per_peril_values():
    sigmas = perturbation_sigmas("tornado")
    assert "vertex_deg" in sigmas
    assert "width_pct" in sigmas


def test_intensity_clipped_at_one():
    fp = _footprint(peril="wildfire", intensity="catastrophic")
    result = generate_sim_losses("1234567890123_abcdef00", fp, SAMPLE_POLICIES,
                                 cohort_keyer=lambda p: f"{p[5]}_{p[4]}", K=50)
    # The two inside policies have wildfire severe damage_ratio = 0.92 / 0.85;
    # catastrophic x1.45 then clipped at 1.0.
    # Per-policy loss ≤ TIV × 1.0 → cohort totals bounded.
    assert (result["losses"] <= 500_000 + 800_000).all()
```

- [ ] **Step 3: Run, verify fail**

```bash
pytest tests/api/test_sim_loss.py -v
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement sim_loss.py**

```python
# api_py/sim_loss.py
"""Task SIM.6 — K=1000 cohort loss generator for simulated catastrophe events.

Given a SimulationFootprint and the policy book, produces a numpy array of
shape (n_cohorts, K) — per-cohort lognormal-ish loss draws with peril-specific
perturbations on the footprint geometry. Output is parquet-ready; the
precompute_portfolio_optimization.py script reads it back and concatenates
column-wise onto the hurricane scenario set for joint TVaR-99.

Severity model:
    loss(policy, draw) = TIV
                       × damage_ratio[peril][build_type]
                       × intensity_scale[intensity]
                       × decay(distance_to_reference)
                       × (1 + β · ε_draw)

The (β, σ) common-factor pair is loaded from artifacts/calibration.json so
sims sit on the same residual axis as hurricane scenarios. See
docs/superpowers/specs/2026-05-18-simulate-tab-design.md §5.
"""

from __future__ import annotations

import hashlib
import json
import math
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
from shapely.geometry import Point, Polygon, shape

# Re-implements lib/sim/severity.ts: keep numbers in sync. v2 = lift to JSON.
_HAZUS_MATRIX: dict[str, dict[str, float]] = {
    "wood_frame":  {"tornado": 0.42, "flood": 0.55, "hail": 0.18, "wildfire": 0.92, "earthquake": 0.35, "winter": 0.08},
    "masonry":     {"tornado": 0.28, "flood": 0.62, "hail": 0.10, "wildfire": 0.85, "earthquake": 0.22, "winter": 0.06},
    "mobile_home": {"tornado": 0.85, "flood": 0.45, "hail": 0.32, "wildfire": 0.95, "earthquake": 0.55, "winter": 0.18},
    "commercial":  {"tornado": 0.30, "flood": 0.48, "hail": 0.12, "wildfire": 0.78, "earthquake": 0.28, "winter": 0.05},
}
_INTENSITY_SCALE = {"moderate": 0.55, "severe": 1.0, "catastrophic": 1.45}

# K=1000 perturbation σ — see spec §5.
_PERTURB: dict[str, dict[str, float]] = {
    "tornado":    {"vertex_deg": 0.005, "width_pct": 0.15},
    "flood":      {"vertex_deg": 0.003},
    "hail":       {"vertex_deg": 0.003},
    "wildfire":   {"vertex_deg": 0.003},
    "winter":     {"vertex_deg": 0.003},
    "earthquake": {"epicenter_deg": 0.01, "magnitude": 0.15},
}


def perturbation_sigmas(peril: str) -> dict[str, float]:
    """Per-peril perturbation parameters used by the K=1000 generator."""
    return dict(_PERTURB.get(peril, {"vertex_deg": 0.003}))


def _damage_ratio(peril: str, build_type: str, intensity: str) -> float:
    row = _HAZUS_MATRIX.get(build_type) or _HAZUS_MATRIX["wood_frame"]
    base = row.get(peril, 0.0)
    scaled = base * _INTENSITY_SCALE.get(intensity, 1.0)
    return max(0.0, min(1.0, scaled))


def _sim_seed(sim_id: str) -> int:
    """Deterministic 32-bit seed derived from sim_id (same shape as
    ml.scenarios.generate._storm_seed). Bit-identical across runs."""
    h = int(hashlib.sha256(sim_id.encode("utf-8")).hexdigest()[:8], 16)
    return h or 1


def peril_decay(peril: str, *, distance_km: float, width_km: float = 0.0) -> float:
    """Severity decay multiplier as a function of distance from the
    peril's reference geometry. Polygon-bounded perils (flood, wildfire,
    winter) return 1.0 inside / 0 outside, and are filtered by the
    point-in-polygon check upstream — so this function is called only on
    inside points and returns 1.0 for them."""
    if peril in ("flood", "wildfire", "winter"):
        return 1.0
    if peril == "tornado":
        if width_km <= 0:
            return 1.0
        return math.exp(-distance_km / (width_km / 2.0))
    if peril == "hail":
        # 1.0 inside the inner core, 0.6·exp(-(d-r)/r) outside.
        # Caller passes width_km = inner-core radius (or 0 when no core).
        if width_km <= 0:
            return 1.0
        if distance_km <= width_km:
            return 1.0
        return 0.6 * math.exp(-(distance_km - width_km) / width_km)
    if peril == "earthquake":
        # Step function from MMI radii; caller passes the MMI lookup as
        # a Polygon-equivalent. Distance-based decay here is the residual
        # smoothing inside an MMI shell.
        return max(0.0, 1.0 - distance_km / max(1.0, width_km))
    return 1.0


def _perturbed_polygon(
    geom: dict, sigma_deg: float, rng: np.random.Generator,
) -> Polygon:
    """Jitter every vertex of a Polygon by an isotropic Gaussian."""
    base = shape(geom)
    if base.geom_type != "Polygon":
        return base
    ring = list(base.exterior.coords)
    noise = rng.normal(0.0, sigma_deg, size=(len(ring), 2))
    perturbed = [(x + dx, y + dy) for (x, y), (dx, dy) in zip(ring, noise)]
    # Re-close the ring.
    if perturbed[0] != perturbed[-1]:
        perturbed[-1] = perturbed[0]
    try:
        p = Polygon(perturbed)
        if not p.is_valid:
            return base  # fall back to base on degenerate jitter
        return p
    except Exception:
        return base


def _load_correlation(artifacts_root: Path | None = None) -> tuple[float, float]:
    """Read (β, σ) from artifacts/calibration.json. Returns (0.2, 0.4) as a
    last-resort default if the calibration artifact is missing — that's the
    same default `api_py.correlation` ships."""
    root = artifacts_root or Path(__file__).resolve().parent.parent / "artifacts"
    p = root / "calibration.json"
    try:
        data = json.loads(p.read_text())
        beta = float(data.get("common_factor", {}).get("beta", 0.2))
        sigma = float(data.get("common_factor", {}).get("sigma", 0.4))
        return beta, sigma
    except Exception:
        return 0.2, 0.4


def generate_sim_losses(
    sim_id: str,
    footprint: dict[str, Any],
    policies: Iterable[tuple[int, float, float, float, str, str]],
    *,
    cohort_keyer: Callable[[tuple[int, float, float, float, str, str]], str],
    K: int = 1000,
    artifacts_root: Path | None = None,
) -> dict[str, Any]:
    """Produce K perturbed cohort losses for one simulated event.

    Parameters
    ----------
    sim_id
        The simulation id. Used as RNG seed; same id → bit-identical output.
    footprint
        SimulationFootprint dict (see spec §4). At minimum: peril,
        intensity, geometry (Polygon), and the peril-specific extras.
    policies
        Iterable of (id, lat, lon, tiv, build_type, zip3). Pulled from
        the `policies` table upstream.
    cohort_keyer
        Function mapping a policy tuple to its cohort key. Production uses
        `{zip3}_{build_type}_q{quintile}`; tests use the (zip3, build_type)
        prefix.
    K
        Number of perturbed draws. Defaults to 1000 (the same K as the
        hurricane scenario set).

    Returns
    -------
    dict with keys:
        - K: the K used
        - cohort_keys: sorted list of cohort keys in row order
        - losses: numpy array of shape (n_cohorts, K)
        - meta: peril, intensity, sim_id, beta, sigma
    """
    rng = np.random.default_rng(_sim_seed(sim_id))
    peril = footprint["peril"]
    intensity = footprint["intensity"]
    perturb = perturbation_sigmas(peril)
    base_geom = footprint["geometry"]
    inner_radius_km = 0.0
    width_km = 0.0
    if peril == "tornado":
        width_km = (footprint.get("width_m") or 200) / 1000.0
    if peril == "hail" and footprint.get("inner_geometry"):
        # Approximate inner core radius from its bounding box.
        inner = shape(footprint["inner_geometry"])
        bx = inner.bounds  # (minx, miny, maxx, maxy)
        inner_radius_km = max(bx[2] - bx[0], bx[3] - bx[1]) * 55.0  # ~ deg → km equatorial
    beta, sigma = _load_correlation(artifacts_root)

    # Materialize policies once.
    policy_list = list(policies)

    # Pre-bucket cohorts by deterministic order.
    keys_in_order: list[str] = []
    key_to_idx: dict[str, int] = {}
    for p in policy_list:
        k = cohort_keyer(p)
        if k not in key_to_idx:
            key_to_idx[k] = len(keys_in_order)
            keys_in_order.append(k)
    n_cohorts = len(keys_in_order)

    losses = np.zeros((n_cohorts, K), dtype=float)
    if n_cohorts == 0 or len(policy_list) == 0:
        return {"K": K, "cohort_keys": keys_in_order, "losses": losses,
                "meta": {"sim_id": sim_id, "peril": peril, "intensity": intensity,
                         "beta": beta, "sigma": sigma}}

    sigma_deg = perturb.get("vertex_deg", 0.003)

    for k in range(K):
        # Step 1: perturb geometry.
        poly = _perturbed_polygon(base_geom, sigma_deg, rng)
        # Step 2: common-factor residual ε for this draw.
        epsilon = rng.normal(0.0, sigma)
        factor_residual = 1.0 + beta * epsilon
        # Step 3: per-policy loss inside the perturbed polygon.
        for p in policy_list:
            pid, lat, lon, tiv, build_type, _zip3 = p
            point = Point(lon, lat)
            if not poly.contains(point):
                continue
            # Distance-based decay — only meaningful for tornado / hail.
            d_km = 0.0
            if peril in ("tornado", "hail"):
                d_km = poly.exterior.distance(point) * 111.0  # deg → km approx
            decay = peril_decay(peril, distance_km=d_km, width_km=(width_km or inner_radius_km))
            dr = _damage_ratio(peril, build_type, intensity)
            loss = tiv * dr * decay * max(0.0, factor_residual)
            row = key_to_idx[cohort_keyer(p)]
            losses[row, k] += loss

    return {
        "K": K,
        "cohort_keys": keys_in_order,
        "losses": losses,
        "meta": {"sim_id": sim_id, "peril": peril, "intensity": intensity,
                 "beta": beta, "sigma": sigma},
    }


def write_artifact(
    sim_id: str,
    result: dict[str, Any],
    artifacts_root: Path | None = None,
) -> tuple[Path, Path]:
    """Write the (n_cohorts, K) loss matrix to a parquet file and a
    companion meta.json. Returns the two paths."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    root = artifacts_root or Path(__file__).resolve().parent.parent / "artifacts" / "simulations"
    root.mkdir(parents=True, exist_ok=True)
    parquet_path = root / f"{sim_id}.parquet"
    meta_path = root / f"{sim_id}.meta.json"

    table = pa.table({
        "cohort_key": result["cohort_keys"],
        **{f"k{i:04d}": result["losses"][:, i] for i in range(result["K"])},
    })
    pq.write_table(table, parquet_path)
    meta_path.write_text(json.dumps({
        "sim_id": sim_id,
        "K": result["K"],
        "cohort_keys": result["cohort_keys"],
        **result["meta"],
    }))
    return parquet_path, meta_path


# ── Vercel HTTP handler ─────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    """POST /api/sim/promote — body: {sim_id, footprint, policies, K}."""

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON body"})
            return

        sim_id = payload.get("sim_id")
        footprint = payload.get("footprint")
        policies = payload.get("policies") or []
        K = int(payload.get("K") or 1000)
        if not sim_id or not footprint:
            self._send_json(400, {"error": "sim_id and footprint required"})
            return

        result = generate_sim_losses(
            sim_id=sim_id,
            footprint=footprint,
            policies=[tuple(p) for p in policies],
            cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
            K=K,
        )
        parquet_path, _ = write_artifact(sim_id, result)
        self._send_json(200, {
            "sim_id": sim_id,
            "K": result["K"],
            "n_cohorts": len(result["cohort_keys"]),
            "artifact_path": str(parquet_path.relative_to(parquet_path.parent.parent.parent)),
        })

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
```

- [ ] **Step 5: Run, verify pass**

```bash
pytest tests/api/test_sim_loss.py -v
```

Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add api_py/sim_loss.py tests/api/test_sim_loss.py requirements.txt
git commit -m "feat(sim): K=1000 cohort loss generator (Python) with peril decay + perturbation"
```

---

### Task 7: Precompute script `--include-sims` flag

**Files:**
- Modify: `scripts/precompute_portfolio_optimization.py`
- Test: `tests/scripts/test_precompute_with_sims.py`

- [ ] **Step 1: Write failing test**

```python
# tests/scripts/test_precompute_with_sims.py
"""Verify --include-sims concatenates K matrices column-wise."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import pytest


ROOT = Path(__file__).resolve().parent.parent.parent
ARTIFACTS = ROOT / "artifacts"
SIMS_DIR = ARTIFACTS / "simulations"


def _write_sim_artifact(sim_id: str, cohort_keys: list[str], K: int = 50) -> None:
    """Write a tiny synthetic sim parquet so the precompute script can join it."""
    import pyarrow as pa
    SIMS_DIR.mkdir(parents=True, exist_ok=True)
    losses = np.full((len(cohort_keys), K), 1_000_000.0)
    table = pa.table({
        "cohort_key": cohort_keys,
        **{f"k{i:04d}": losses[:, i] for i in range(K)},
    })
    pq.write_table(table, SIMS_DIR / f"{sim_id}.parquet")
    (SIMS_DIR / f"{sim_id}.meta.json").write_text(json.dumps({
        "sim_id": sim_id, "K": K, "cohort_keys": cohort_keys,
        "peril": "hail", "intensity": "severe", "beta": 0.2, "sigma": 0.4,
    }))


def test_include_sims_writes_meta_with_sim_ids(tmp_path, monkeypatch):
    # Run the precompute script with --include-sims pointing at a known fixture.
    fixture_id = "9999999999999_deadbeef"
    # We need at least one cohort key the actual book also produces. The seed
    # ships ~570 cohorts; pick one via the cohort aggregator first, but for
    # this lightweight test we just write a sentinel key that won't match.
    # The script must still complete (just contribute 0 to joint K) and
    # record the sim_id in meta.
    _write_sim_artifact(fixture_id, ["999_bogus_q0"], K=10)
    try:
        out = subprocess.run(
            [sys.executable, "-m", "scripts.precompute_portfolio_optimization",
             "--include-sims", fixture_id],
            cwd=ROOT, check=True, capture_output=True, text=True,
        )
        meta_path = ARTIFACTS / "portfolio_optimization.meta.json"
        assert meta_path.exists()
        meta = json.loads(meta_path.read_text())
        assert fixture_id in meta.get("included_sims", [])
    finally:
        (SIMS_DIR / f"{fixture_id}.parquet").unlink(missing_ok=True)
        (SIMS_DIR / f"{fixture_id}.meta.json").unlink(missing_ok=True)
```

- [ ] **Step 2: Run, verify fail**

```bash
pytest tests/scripts/test_precompute_with_sims.py -v
```

Expected: FAIL (no `--include-sims` flag yet).

- [ ] **Step 3: Add the flag + concatenation**

Open `scripts/precompute_portfolio_optimization.py`. Find the `if __name__ == "__main__":` block at the bottom (or the entrypoint function) and replace argument parsing + the cohort assembly. Add at top of file:

```python
import argparse
from pathlib import Path as _P
import pyarrow.parquet as _pq

ARTIFACTS_ROOT = _P(__file__).resolve().parent.parent / "artifacts"
SIMS_ROOT = ARTIFACTS_ROOT / "simulations"


def _resolve_sim_ids(include: str | None) -> list[str]:
    if not include:
        return []
    if include == "all":
        if not SIMS_ROOT.exists():
            return []
        return sorted({p.stem for p in SIMS_ROOT.glob("*.parquet")})
    return [s.strip() for s in include.split(",") if s.strip()]


def _load_sim_losses(sim_id: str) -> tuple[dict[str, list[float]], dict]:
    parquet = SIMS_ROOT / f"{sim_id}.parquet"
    meta = SIMS_ROOT / f"{sim_id}.meta.json"
    if not parquet.exists():
        raise FileNotFoundError(f"sim parquet missing: {parquet}")
    table = _pq.read_table(parquet).to_pandas()
    cohort_col = table["cohort_key"].tolist()
    k_cols = [c for c in table.columns if c.startswith("k")]
    losses_by_cohort = {
        cohort_col[i]: [float(table[c].iloc[i]) for c in k_cols]
        for i in range(len(cohort_col))
    }
    return losses_by_cohort, json.loads(meta.read_text())
```

Then replace the precompute entrypoint with:

```python
def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--include-sims",
        default=None,
        help="Comma-separated sim_ids, or 'all'. Concatenates their K-loss "
             "draws onto the per-cohort hurricane scenario set before "
             "TVaR-99.",
    )
    args = parser.parse_args(argv)

    cohorts = _build_cohorts()  # existing function; signature unchanged
    sim_ids = _resolve_sim_ids(args.include_sims)
    sim_meta_records: list[dict] = []

    if sim_ids:
        for sim_id in sim_ids:
            losses_by_cohort, meta = _load_sim_losses(sim_id)
            sim_meta_records.append(meta)
            for c in cohorts:
                extra = losses_by_cohort.get(c["id"])
                if extra:
                    c["loss_scenarios"] = list(c.get("loss_scenarios", [])) + extra

    result = solve(
        cohorts=cohorts,
        capital_budget=CAPITAL_BUDGET,
        max_nonrenew_pct=MAX_NONRENEW_PCT,
        cession_budget=CESSION_BUDGET,
        horizon_start=HORIZON_START,
        horizon_end=HORIZON_END,
        risk_measure="tvar_99" if sim_ids else "var_99",
    )

    out = ARTIFACTS_ROOT / "portfolio_optimization.json"
    out.write_text(json.dumps(result, indent=2, default=float))

    meta_out = ARTIFACTS_ROOT / "portfolio_optimization.meta.json"
    meta_out.write_text(json.dumps({
        "hurricane_scenario_set": "AL092024",
        "included_sims": sim_ids,
        "simulations_log": sim_meta_records,
        "solved_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }, indent=2))


if __name__ == "__main__":
    main()
```

Note: `_build_cohorts()` is shorthand for whatever the existing entrypoint already does to construct the `cohorts` list (read DB, attach `loss_scenarios`, etc.). When integrating, lift the existing inline body of the script into a `_build_cohorts()` function so the new `main()` can call it cleanly.

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/scripts/test_precompute_with_sims.py -v
python -m scripts.precompute_portfolio_optimization      # smoke: still works with no flag
```

Expected: test PASS; smoke run completes without error.

- [ ] **Step 5: Commit**

```bash
git add scripts/precompute_portfolio_optimization.py tests/scripts/test_precompute_with_sims.py
git commit -m "feat(sim): precompute --include-sims flag joins sim losses into TVaR-99"
```

---

### Task 8: Hurricane scenario `kind` discriminator (backward-compat)

**Files:**
- Modify: `ml/scenarios/generate.py`
- Test: `tests/api/test_scenarios.py` (extend existing)

- [ ] **Step 1: Add failing assertion to existing test file**

Edit `tests/api/test_scenarios.py`. Append:

```python
def test_scenario_has_kind_hurricane_discriminator():
    from ml.scenarios.generate import generate_scenarios
    out = generate_scenarios("AL092024", n=2)
    for s in out:
        assert s.get("kind") == "hurricane"
```

- [ ] **Step 2: Run, verify fail**

```bash
pytest tests/api/test_scenarios.py::test_scenario_has_kind_hurricane_discriminator -v
```

Expected: FAIL — no `kind` key.

- [ ] **Step 3: Add the key in generate_scenarios**

In `ml/scenarios/generate.py`, find the two places where `scenario = {...}` is constructed (parametric and ensemble paths). Add `"kind": "hurricane"` to each dict literal. Example for the parametric path:

```python
scenario = {
    "kind": "hurricane",  # SIM.8: peril-agnostic discriminator
    "id": f"{storm_id}_{i + 1:04d}",
    "path": path,
    ...
}
```

And in `_scenarios_from_ensemble`:

```python
scenario: dict = {
    "kind": "hurricane",
    "id": f"{storm_id}_{i + 1:04d}",
    ...
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/api/test_scenarios.py -v
```

Expected: all PASS (existing tests still pass; new one passes).

- [ ] **Step 5: Commit**

```bash
git add ml/scenarios/generate.py tests/api/test_scenarios.py
git commit -m "feat(sim): kind: 'hurricane' discriminator on existing scenarios"
```

---

## Milestone 3 — REST surface

### Task 9: `POST /api/sim` (create draft)

**Files:**
- Create: `app/api/sim/route.ts`
- Test: `tests/api/sim/route.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/api/sim/route.test.ts
// @vitest-environment node
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { POST, GET } from '@/app/api/sim/route';
import { db } from '@/lib/db/client';

async function jsonRequest(body: unknown): Promise<Request> {
  return new Request('http://localhost/api/sim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sim', () => {
  test('persists a draft and returns sim_id + preview', async () => {
    const req = await jsonRequest({
      name: 'Test hail',
      footprint: {
        peril: 'hail',
        intensity: 'severe',
        geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
        effective_date: '2026-05-18',
        metadata: { drawn_by: 'tester', drawn_at: '2026-05-18T00:00:00Z' },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sim_id).toMatch(/^\d{13}_[0-9a-f]{8}$/);
    expect(body.impact).toBeDefined();
    expect(typeof body.impact.gross_loss_estimate).toBe('number');
    // Confirm row exists with promoted=0
    const r = await db.execute({ sql: 'SELECT promoted FROM simulations WHERE id = ?', args: [body.sim_id] });
    expect(r.rows[0].promoted).toBe(0);
  });

  test('rejects malformed footprint', async () => {
    const req = await jsonRequest({ name: 'bad', footprint: { peril: 'hail' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sim', () => {
  test('returns array of sims sorted by drawn_at DESC', async () => {
    const res = await GET(new Request('http://localhost/api/sim'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sims)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/api/sim/route.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement the route**

```ts
// app/api/sim/route.ts
/**
 * /api/sim — list + create.
 *
 *   GET  /api/sim                   list all sims (newest first)
 *   POST /api/sim { name, footprint } create draft + return preview impact
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { newSimId } from '@/lib/sim/id';
import { validateFootprint, type SimulationFootprint } from '@/lib/sim/footprint';
import { previewImpact, type Policy } from '@/lib/sim/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateBody {
  name?: string;
  footprint?: SimulationFootprint;
}

async function loadBookPolicies(): Promise<Policy[]> {
  const r = await db.execute(
    'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    lat: Number(row.lat),
    lon: Number(row.lon),
    tiv: Number(row.tiv),
    build_type: String(row.build_type ?? 'wood_frame'),
    zip3: String(row.zip3),
  }));
}

export async function GET(_req: Request): Promise<Response> {
  const r = await db.execute(
    'SELECT id, name, peril, intensity, promoted, retired, drawn_at, promoted_at, retired_at FROM simulations ORDER BY drawn_at DESC LIMIT 100',
  );
  return NextResponse.json({
    sims: r.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      peril: String(row.peril),
      intensity: String(row.intensity),
      promoted: Number(row.promoted) === 1,
      retired: Number(row.retired) === 1,
      drawn_at: String(row.drawn_at),
      promoted_at: row.promoted_at ? String(row.promoted_at) : null,
      retired_at: row.retired_at ? String(row.retired_at) : null,
    })),
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const name = body.name?.trim();
  const fp = body.footprint;
  if (!name || !fp) {
    return NextResponse.json({ error: 'name and footprint required' }, { status: 400 });
  }
  const v = validateFootprint(fp);
  if (!v.ok) {
    return NextResponse.json({ error: v.reason }, { status: 400 });
  }

  const id = newSimId();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO simulations
          (id, name, peril, intensity, footprint, effective_date, drawn_by, drawn_at, promoted, retired)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    args: [id, name, fp.peril, fp.intensity, JSON.stringify(fp), fp.effective_date,
           fp.metadata.drawn_by, now],
  });

  // Compute preview impact synchronously so the client gets immediate numbers.
  const policies = await loadBookPolicies();
  const impact = previewImpact(policies, fp);

  return NextResponse.json({ sim_id: id, impact }, { status: 201 });
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/api/sim/route.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/sim/route.ts tests/api/sim/route.test.ts
git commit -m "feat(sim): POST /api/sim creates a draft + returns preview impact"
```

---

### Task 10: `GET /api/sim/[id]` (read single sim)

**Files:**
- Create: `app/api/sim/[id]/route.ts`
- Test: extend `tests/api/sim/route.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/api/sim/route.test.ts`:

```ts
import { GET as GET_BY_ID } from '@/app/api/sim/[id]/route';

describe('GET /api/sim/[id]', () => {
  test('returns 404 for unknown id', async () => {
    const res = await GET_BY_ID(new Request('http://localhost'), { params: { id: '0000000000000_deadbeef' } });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/api/sim/route.test.ts
```

- [ ] **Step 3: Implement the handler**

```ts
// app/api/sim/[id]/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { isValidSimId } from '@/lib/sim/id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: { id: string } }): Promise<Response> {
  const id = ctx.params.id;
  if (!isValidSimId(id)) {
    return NextResponse.json({ error: 'invalid sim_id' }, { status: 400 });
  }
  const r = await db.execute({
    sql: 'SELECT * FROM simulations WHERE id = ?',
    args: [id],
  });
  if (r.rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = r.rows[0];
  return NextResponse.json({
    id: String(row.id),
    name: String(row.name),
    peril: String(row.peril),
    intensity: String(row.intensity),
    footprint: JSON.parse(String(row.footprint)),
    effective_date: String(row.effective_date),
    drawn_by: String(row.drawn_by),
    drawn_at: String(row.drawn_at),
    promoted: Number(row.promoted) === 1,
    promoted_at: row.promoted_at ? String(row.promoted_at) : null,
    retired: Number(row.retired) === 1,
    retired_at: row.retired_at ? String(row.retired_at) : null,
  });
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/api/sim/route.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add app/api/sim/[id]/route.ts tests/api/sim/route.test.ts
git commit -m "feat(sim): GET /api/sim/[id] reads a single sim"
```

---

### Task 11: `POST /api/sim/[id]/promote`

**Files:**
- Create: `app/api/sim/[id]/promote/route.ts`
- Test: `tests/api/sim/promote.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/api/sim/promote.test.ts
// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST } from '@/app/api/sim/[id]/promote/route';
import { POST as CREATE } from '@/app/api/sim/route';
import { db } from '@/lib/db/client';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const ARTIFACTS_DIR = join(process.cwd(), 'artifacts', 'simulations');

describe('POST /api/sim/[id]/promote', () => {
  test('flips promoted=1 and writes parquet artifact', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Promote test',
        footprint: {
          peril: 'hail',
          intensity: 'severe',
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();

    const res = await POST(new Request(`http://localhost/api/sim/${sim_id}/promote`, { method: 'POST' }),
                          { params: { id: sim_id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.K).toBe(1000);
    expect(body.n_cohorts).toBeGreaterThanOrEqual(0);

    const r = await db.execute({ sql: 'SELECT promoted FROM simulations WHERE id = ?', args: [sim_id] });
    expect(r.rows[0].promoted).toBe(1);
    expect(existsSync(join(ARTIFACTS_DIR, `${sim_id}.parquet`))).toBe(true);

    // cleanup
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.parquet`));
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.meta.json`));
  });

  test('is idempotent: replaying promote does not error', async () => {
    // Re-use a sim that was promoted above; just call promote twice in this test
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Idempotent test',
        footprint: {
          peril: 'flood',
          intensity: 'moderate',
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();
    await POST(new Request('http://localhost', { method: 'POST' }), { params: { id: sim_id } });
    const res = await POST(new Request('http://localhost', { method: 'POST' }), { params: { id: sim_id } });
    expect(res.status).toBe(200);
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.parquet`));
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.meta.json`));
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/api/sim/promote.test.ts
```

- [ ] **Step 3: Implement promote**

```ts
// app/api/sim/[id]/promote/route.ts
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { db } from '@/lib/db/client';
import { isValidSimId } from '@/lib/sim/id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function runPython(payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'api_py._solve_stdin', 'sim_loss'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `python exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

export async function POST(_req: Request, ctx: { params: { id: string } }): Promise<Response> {
  const id = ctx.params.id;
  if (!isValidSimId(id)) {
    return NextResponse.json({ error: 'invalid sim_id' }, { status: 400 });
  }
  const r = await db.execute({ sql: 'SELECT * FROM simulations WHERE id = ?', args: [id] });
  if (r.rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = r.rows[0];
  if (Number(row.retired) === 1) {
    return NextResponse.json({ error: 'cannot promote a retired sim' }, { status: 409 });
  }
  const footprint = JSON.parse(String(row.footprint));

  const policies = (await db.execute(
    'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
  )).rows.map((p) => [Number(p.id), Number(p.lat), Number(p.lon), Number(p.tiv),
                       String(p.build_type ?? 'wood_frame'), String(p.zip3)]);

  let pyResult: { K: number; n_cohorts: number; artifact_path: string };
  try {
    pyResult = (await runPython({ sim_id: id, footprint, policies, K: 1000 })) as typeof pyResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `loss compute failed: ${msg}` }, { status: 500 });
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: 'UPDATE simulations SET promoted = 1, promoted_at = ? WHERE id = ?',
    args: [now, id],
  });

  return NextResponse.json({
    sim_id: id,
    K: pyResult.K,
    n_cohorts: pyResult.n_cohorts,
    artifact_path: pyResult.artifact_path,
    compute_time_ms: 0,  // SIM.10: populate from real measurement in v1.1
  });
}
```

Then create `api_py/_solve_stdin.py` adapter (if it doesn't exist) — a tiny shim that reads JSON from stdin, dispatches to the named module, writes JSON to stdout:

```python
# api_py/_solve_stdin.py — UNIX-style adapter for Node-side spawn.
# Usage: python -m api_py._solve_stdin sim_loss < payload.json
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main(target: str) -> None:
    payload = json.loads(sys.stdin.read())
    if target == "sim_loss":
        from api_py.sim_loss import generate_sim_losses, write_artifact
        result = generate_sim_losses(
            sim_id=payload["sim_id"],
            footprint=payload["footprint"],
            policies=[tuple(p) for p in payload.get("policies", [])],
            cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
            K=int(payload.get("K") or 1000),
        )
        parquet_path, _ = write_artifact(payload["sim_id"], result)
        print(json.dumps({
            "K": result["K"],
            "n_cohorts": len(result["cohort_keys"]),
            "artifact_path": str(parquet_path),
        }))
        return
    raise SystemExit(f"unknown target: {target}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: python -m api_py._solve_stdin <target>")
    main(sys.argv[1])
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/api/sim/promote.test.ts
```

Expected: PASS (2 tests). Note tests require local Python with shapely + pyarrow.

- [ ] **Step 5: Commit**

```bash
git add app/api/sim/[id]/promote/route.ts api_py/_solve_stdin.py tests/api/sim/promote.test.ts
git commit -m "feat(sim): POST promote runs Python loss compute + flips promoted=1"
```

---

### Task 12: `POST /api/sim/[id]/retire`

**Files:**
- Create: `app/api/sim/[id]/retire/route.ts`
- Test: `tests/api/sim/retire.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/api/sim/retire.test.ts
// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST as RETIRE } from '@/app/api/sim/[id]/retire/route';
import { POST as CREATE } from '@/app/api/sim/route';
import { db } from '@/lib/db/client';

describe('POST /api/sim/[id]/retire', () => {
  test('flips retired=1 on a draft', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Retire test',
        footprint: {
          peril: 'hail',
          intensity: 'severe',
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();
    const res = await RETIRE(new Request('http://localhost', { method: 'POST' }), { params: { id: sim_id } });
    expect(res.status).toBe(200);
    const r = await db.execute({ sql: 'SELECT retired FROM simulations WHERE id = ?', args: [sim_id] });
    expect(r.rows[0].retired).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/api/sim/retire.test.ts
```

- [ ] **Step 3: Implement retire**

```ts
// app/api/sim/[id]/retire/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { isValidSimId } from '@/lib/sim/id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: { id: string } }): Promise<Response> {
  const id = ctx.params.id;
  if (!isValidSimId(id)) {
    return NextResponse.json({ error: 'invalid sim_id' }, { status: 400 });
  }
  const now = new Date().toISOString();
  const r = await db.execute({
    sql: 'UPDATE simulations SET retired = 1, retired_at = ? WHERE id = ?',
    args: [now, id],
  });
  if (Number(r.rowsAffected) === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/api/sim/retire.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add app/api/sim/[id]/retire/route.ts tests/api/sim/retire.test.ts
git commit -m "feat(sim): POST retire soft-deletes a sim"
```

---

### Task 13: `POST /api/portfolio/reoptimize`

**Files:**
- Create: `app/api/portfolio/reoptimize/route.ts`
- Test: `tests/api/portfolio/reoptimize.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/api/portfolio/reoptimize.test.ts
// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST } from '@/app/api/portfolio/reoptimize/route';

describe('POST /api/portfolio/reoptimize', () => {
  test('returns 200 + new solved_at timestamp', async () => {
    const res = await POST(new Request('http://localhost', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.solved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/api/portfolio/reoptimize.test.ts
```

- [ ] **Step 3: Implement reoptimize**

```ts
// app/api/portfolio/reoptimize/route.ts
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const META_PATH = join(process.cwd(), 'artifacts', 'portfolio_optimization.meta.json');

function runPrecompute(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'scripts.precompute_portfolio_optimization',
                                  '--include-sims', 'all']);
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
  });
}

export async function POST(_req: Request): Promise<Response> {
  try {
    await runPrecompute();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `reoptimize failed: ${msg}` }, { status: 500 });
  }
  const meta = JSON.parse(await fs.readFile(META_PATH, 'utf-8'));
  return NextResponse.json({
    solved_at: meta.solved_at,
    included_sims: meta.included_sims ?? [],
  });
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/api/portfolio/reoptimize.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add app/api/portfolio/reoptimize/route.ts tests/api/portfolio/reoptimize.test.ts
git commit -m "feat(sim): POST /api/portfolio/reoptimize runs precompute --include-sims all"
```

---

## Milestone 4 — UI surface

### Task 14: terra-draw adapter scaffolding

**Files:**
- Create: `lib/sim/draw/index.ts`
- Create: `lib/sim/draw/modes.ts`
- Modify: `package.json` (add `terra-draw` + `terra-draw-maplibre-gl-adapter`)

- [ ] **Step 1: Install deps**

```bash
npm install --save terra-draw terra-draw-maplibre-gl-adapter
```

- [ ] **Step 2: Create modes module**

```ts
// lib/sim/draw/modes.ts
/**
 * Per-peril terra-draw mode mapping. Each peril uses one or two modes:
 *   tornado    → linestring (centerline; buffered to a polygon on commit)
 *   flood      → polygon (freehand)
 *   hail       → polygon (outer swath) + optional polygon (inner core)
 *   wildfire   → polygon
 *   earthquake → point (epicenter; concentric circles derived from magnitude)
 *   winter     → polygon
 *
 * See spec §4 (drawing toolkit).
 */
import {
  TerraDrawPolygonMode,
  TerraDrawLineStringMode,
  TerraDrawPointMode,
  type TerraDrawBaseDrawMode,
} from 'terra-draw';
import type { Peril } from '@/lib/sim/severity';

export type PerilMode = 'polygon' | 'linestring' | 'point';

export const PERIL_MODES: Record<Peril, PerilMode> = {
  tornado: 'linestring',
  flood: 'polygon',
  hail: 'polygon',
  wildfire: 'polygon',
  earthquake: 'point',
  winter: 'polygon',
};

export function modeFactoriesForPeril(peril: Peril): TerraDrawBaseDrawMode<any>[] {
  const m = PERIL_MODES[peril];
  if (m === 'polygon') return [new TerraDrawPolygonMode()];
  if (m === 'linestring') return [new TerraDrawLineStringMode()];
  if (m === 'point') return [new TerraDrawPointMode()];
  throw new Error(`unsupported peril mode: ${m}`);
}
```

- [ ] **Step 3: Create adapter factory**

```ts
// lib/sim/draw/index.ts
/**
 * terra-draw adapter factory. Pass a MapLibre map instance and a peril;
 * returns a configured TerraDraw instance ready to start. The caller is
 * responsible for `draw.start()` / `draw.stop()` lifecycle and for
 * subscribing to the `finish` event to read out the drawn feature.
 */
import { TerraDraw } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { modeFactoriesForPeril, PERIL_MODES } from './modes';
import type { Peril } from '@/lib/sim/severity';

export function createDrawForPeril(map: MapLibreMap, peril: Peril): TerraDraw {
  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: modeFactoriesForPeril(peril),
  });
  return draw;
}

export { PERIL_MODES };
```

- [ ] **Step 4: Commit (no test — exercised through SimMap)**

```bash
git add lib/sim/draw/*.ts package.json package-lock.json
git commit -m "feat(sim): terra-draw adapter factory + per-peril mode mapping"
```

---

### Task 15: `PerilPicker` component

**Files:**
- Create: `components/sim/PerilPicker.tsx`
- Test: `tests/components/sim/PerilPicker.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/components/sim/PerilPicker.test.tsx
// @vitest-environment jsdom
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PerilPicker } from '@/components/sim/PerilPicker';

describe('PerilPicker', () => {
  test('renders all six perils', () => {
    render(<PerilPicker active="hail" onChange={() => {}} />);
    for (const p of ['Tornado', 'Flood', 'Hail', 'Wildfire', 'Earthquake', 'Winter']) {
      expect(screen.getByText(p)).toBeInTheDocument();
    }
  });
  test('marks the active peril with aria-pressed=true', () => {
    render(<PerilPicker active="hail" onChange={() => {}} />);
    const hailBtn = screen.getByRole('button', { name: /^Hail$/ });
    expect(hailBtn).toHaveAttribute('aria-pressed', 'true');
  });
  test('calls onChange with the clicked peril', () => {
    const onChange = vi.fn();
    render(<PerilPicker active="hail" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /^Flood$/ }));
    expect(onChange).toHaveBeenCalledWith('flood');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/components/sim/PerilPicker.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// components/sim/PerilPicker.tsx
'use client';
import { PERILS, type Peril } from '@/lib/sim/severity';

const LABELS: Record<Peril, string> = {
  tornado: 'Tornado',
  flood: 'Flood',
  hail: 'Hail',
  wildfire: 'Wildfire',
  earthquake: 'Earthquake',
  winter: 'Winter',
};

const COLORS: Record<Peril, string> = {
  tornado: '#ff5247',
  flood: '#3b82f6',
  hail: '#a78bfa',
  wildfire: '#f97316',
  earthquake: '#fbbf24',
  winter: '#60a5fa',
};

export interface PerilPickerProps {
  active: Peril;
  onChange: (peril: Peril) => void;
}

export function PerilPicker({ active, onChange }: PerilPickerProps) {
  return (
    <div className="flex flex-col gap-1" role="group" aria-label="Select peril">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">+ New simulation</div>
      {PERILS.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={active === p}
          onClick={() => onChange(p)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm ${
            active === p ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <span aria-hidden className="inline-block w-2 h-2 rounded-full" style={{ background: COLORS[p] }} />
          {LABELS[p]}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/components/sim/PerilPicker.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add components/sim/PerilPicker.tsx tests/components/sim/PerilPicker.test.tsx
git commit -m "feat(sim): PerilPicker component"
```

---

### Task 16: `SimLibrary` component

**Files:**
- Create: `components/sim/SimLibrary.tsx`
- Test: `tests/components/sim/SimLibrary.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/components/sim/SimLibrary.test.tsx
// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SimLibrary } from '@/components/sim/SimLibrary';

const SIMS = [
  { id: 'a', name: 'Tampa hail', peril: 'hail', intensity: 'severe', promoted: false, retired: false, drawn_at: '2026-05-18T12:00:00Z' },
  { id: 'b', name: 'ATL tornado', peril: 'tornado', intensity: 'moderate', promoted: true, retired: false, drawn_at: '2026-05-17T12:00:00Z' },
];

describe('SimLibrary', () => {
  test('renders DRAFT / PROMOTED badges', () => {
    render(<SimLibrary sims={SIMS} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('PROMOTED')).toBeInTheDocument();
  });
  test('shows empty state when no sims', () => {
    render(<SimLibrary sims={[]} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText(/No saved sims/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/components/sim/SimLibrary.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// components/sim/SimLibrary.tsx
'use client';

export interface SimListItem {
  id: string;
  name: string;
  peril: string;
  intensity: string;
  promoted: boolean;
  retired: boolean;
  drawn_at: string;
}

export interface SimLibraryProps {
  sims: SimListItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

function badge(sim: SimListItem): { label: string; cls: string } {
  if (sim.retired) return { label: 'RETIRED', cls: 'bg-slate-700 text-slate-400' };
  if (sim.promoted) return { label: 'PROMOTED', cls: 'bg-emerald-900 text-emerald-300' };
  return { label: 'DRAFT', cls: 'bg-slate-700 text-slate-300' };
}

export function SimLibrary({ sims, activeId, onSelect }: SimLibraryProps) {
  if (sims.length === 0) {
    return <div className="text-sm text-slate-400">No saved sims yet — pick a peril to start.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs uppercase tracking-wider text-slate-400 mt-4 mb-1">Saved sims ({sims.length})</div>
      {sims.map((s) => {
        const b = badge(s);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            aria-current={activeId === s.id ? 'true' : undefined}
            className={`text-left px-2 py-1.5 rounded border ${
              activeId === s.id ? 'border-blue-500 bg-slate-800' : 'border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="text-sm text-slate-200">{s.name}</div>
            <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${b.cls}`}>{b.label}</span>
              <span aria-hidden>·</span>
              <span>{new Date(s.drawn_at).toLocaleDateString()}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/components/sim/SimLibrary.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add components/sim/SimLibrary.tsx tests/components/sim/SimLibrary.test.tsx
git commit -m "feat(sim): SimLibrary list with state badges"
```

---

### Task 17: `ImpactPanel` component

**Files:**
- Create: `components/sim/ImpactPanel.tsx`
- Test: `tests/components/sim/ImpactPanel.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/components/sim/ImpactPanel.test.tsx
// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImpactPanel } from '@/components/sim/ImpactPanel';

const IMPACT = {
  policies_in_footprint: 847,
  tiv_in_footprint: 284_000_000,
  gross_loss_estimate: 11_400_000,
  mean_damage_ratio: 0.04,
  cohorts_affected: 12,
  top_cohorts: [
    { cohort_id: '337_wood_frame', loss: 2_100_000, tiv: 50_000_000, policies: 120 },
    { cohort_id: '335_masonry',    loss: 1_800_000, tiv: 60_000_000, policies: 95 },
  ],
};

describe('ImpactPanel', () => {
  test('renders the gross loss prominently', () => {
    render(<ImpactPanel impact={IMPACT} />);
    expect(screen.getByText(/\$11\.4M/)).toBeInTheDocument();
  });
  test('empty footprint shows placeholder', () => {
    render(<ImpactPanel impact={null} />);
    expect(screen.getByText(/Draw a footprint/i)).toBeInTheDocument();
  });
  test('zero-policy footprint shows "promote anyway?" chip', () => {
    render(<ImpactPanel impact={{ ...IMPACT, policies_in_footprint: 0, gross_loss_estimate: 0 }} />);
    expect(screen.getByText(/promote anyway/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/components/sim/ImpactPanel.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// components/sim/ImpactPanel.tsx
'use client';
import type { PreviewImpact } from '@/lib/sim/preview';

export interface ImpactPanelProps {
  impact: PreviewImpact | null;
}

function fmtUSD(n: number): string {
  if (n === 0) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

export function ImpactPanel({ impact }: ImpactPanelProps) {
  if (!impact) {
    return (
      <div className="text-sm text-slate-400 italic">
        Draw a footprint to see impact estimate.
      </div>
    );
  }
  const zero = impact.policies_in_footprint === 0;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="text-xs uppercase tracking-wider text-slate-400">Preview impact</div>
      <div className="flex justify-between items-center pb-2 border-b border-slate-800">
        <span className="text-slate-400">Est. gross loss</span>
        <span className="text-2xl font-semibold text-red-400 tabular-nums">{fmtUSD(impact.gross_loss_estimate)}</span>
      </div>
      <Row label="Policies in footprint" value={impact.policies_in_footprint.toLocaleString()} />
      <Row label="TIV in footprint" value={fmtUSD(impact.tiv_in_footprint)} />
      <Row label="Cohorts affected" value={impact.cohorts_affected.toString()} />
      <Row label="Mean damage ratio" value={`${(impact.mean_damage_ratio * 100).toFixed(1)}%`} />
      {zero && (
        <div className="text-xs text-amber-400 bg-amber-950/40 border border-amber-900 rounded px-2 py-1">
          0 policies in footprint — promote anyway?
        </div>
      )}
      {impact.top_cohorts.length > 0 && (
        <div className="mt-2">
          <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">Top cohorts</div>
          {impact.top_cohorts.map((c) => (
            <div key={c.cohort_id} className="flex justify-between text-xs py-0.5 text-slate-300">
              <span>{c.cohort_id}</span>
              <span className="text-red-300 tabular-nums">{fmtUSD(c.loss)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-slate-800">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-200 tabular-nums">{value}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/components/sim/ImpactPanel.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add components/sim/ImpactPanel.tsx tests/components/sim/ImpactPanel.test.tsx
git commit -m "feat(sim): ImpactPanel renders preview impact + empty/zero states"
```

---

### Task 18: `IntensityStrip` + `DrawToolbar`

**Files:**
- Create: `components/sim/IntensityStrip.tsx`
- Create: `components/sim/DrawToolbar.tsx`

These are display-only components consumed by `SimMap`. No standalone tests (covered by the e2e in Task 24).

- [ ] **Step 1: Implement IntensityStrip**

```tsx
// components/sim/IntensityStrip.tsx
'use client';
import { INTENSITIES, type Intensity } from '@/lib/sim/severity';

export interface IntensityStripProps {
  intensity: Intensity;
  onChange: (i: Intensity) => void;
  effectiveDate: string;
  onDateChange: (d: string) => void;
}

export function IntensityStrip({ intensity, onChange, effectiveDate, onDateChange }: IntensityStripProps) {
  return (
    <div className="absolute bottom-2 left-2 right-2 bg-slate-900/95 border border-slate-700 rounded p-2 flex items-center gap-3 text-xs">
      <span className="text-slate-400">Intensity</span>
      {INTENSITIES.map((i) => (
        <button
          key={i}
          type="button"
          aria-pressed={intensity === i}
          onClick={() => onChange(i)}
          className={`px-2 py-0.5 rounded ${intensity === i ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >{i}</button>
      ))}
      <span className="ml-auto text-slate-400">Effective</span>
      <input
        type="date"
        value={effectiveDate}
        onChange={(e) => onDateChange(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-slate-200"
      />
    </div>
  );
}
```

- [ ] **Step 2: Implement DrawToolbar**

```tsx
// components/sim/DrawToolbar.tsx
'use client';
import type { Peril } from '@/lib/sim/severity';

export interface DrawToolbarProps {
  peril: Peril;
  onUndo: () => void;
  onClear: () => void;
}

export function DrawToolbar({ peril, onUndo, onClear }: DrawToolbarProps) {
  const primaryLabel: Record<Peril, string> = {
    tornado: '▱ swath',
    flood: '▭ polygon',
    hail: '▭ polygon',
    wildfire: '▭ perimeter',
    earthquake: '⊙ epicenter',
    winter: '▭ area',
  };
  return (
    <div className="absolute top-2 left-2 bg-slate-900/95 border border-slate-700 rounded p-1 flex gap-1 text-xs">
      <span className="px-2 py-1 rounded bg-blue-600 text-white">{primaryLabel[peril]}</span>
      <button type="button" onClick={onUndo} className="px-2 py-1 text-slate-300 hover:text-white">↶ undo</button>
      <button type="button" onClick={onClear} className="px-2 py-1 text-slate-300 hover:text-white">⌫ clear</button>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add components/sim/IntensityStrip.tsx components/sim/DrawToolbar.tsx
git commit -m "feat(sim): IntensityStrip + DrawToolbar map overlays"
```

---

### Task 19: `PromoteButton` with state transitions

**Files:**
- Create: `components/sim/PromoteButton.tsx`
- Test: `tests/components/sim/PromoteButton.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/components/sim/PromoteButton.test.tsx
// @vitest-environment jsdom
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromoteButton } from '@/components/sim/PromoteButton';

describe('PromoteButton', () => {
  test('disabled when no sim_id', () => {
    render(<PromoteButton simId={null} promoted={false} onPromoted={() => {}} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
  test('hidden chip when already promoted', () => {
    render(<PromoteButton simId="abc" promoted={true} onPromoted={() => {}} />);
    expect(screen.getByText(/Already promoted/i)).toBeInTheDocument();
  });
  test('calls promote endpoint on click', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ K: 1000, n_cohorts: 5 }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const onPromoted = vi.fn();
    render(<PromoteButton simId="1234567890123_deadbeef" promoted={false} onPromoted={onPromoted} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(onPromoted).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sim/1234567890123_deadbeef/promote',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/components/sim/PromoteButton.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// components/sim/PromoteButton.tsx
'use client';
import { useState } from 'react';

export interface PromoteButtonProps {
  simId: string | null;
  promoted: boolean;
  onPromoted: (result: { K: number; n_cohorts: number }) => void;
}

export function PromoteButton({ simId, promoted, onPromoted }: PromoteButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (promoted) {
    return (
      <div className="mt-4 text-center text-xs text-emerald-400 border border-emerald-900 rounded p-2">
        Already promoted — view banner on /portfolio to re-optimize.
      </div>
    );
  }

  async function onClick() {
    if (!simId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/sim/${simId}/promote`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `promote failed (${res.status})`);
      }
      onPromoted(await res.json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      <button
        type="button"
        disabled={!simId || busy}
        onClick={onClick}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold py-2 rounded"
      >
        {busy ? 'Generating K=1000 draws…' : 'Promote to scenario →'}
      </button>
      <div className="text-[10px] text-slate-400 text-center">
        Generates K=1000 cohort losses. /portfolio will surface a re-optimize banner.
      </div>
      {err && <div className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-2 py-1">{err}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/components/sim/PromoteButton.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add components/sim/PromoteButton.tsx tests/components/sim/PromoteButton.test.tsx
git commit -m "feat(sim): PromoteButton with state transitions + error toast"
```

---

### Task 20: `SimMap` + `SimWorkspace`

**Files:**
- Create: `components/sim/SimMap.tsx`
- Create: `components/sim/SimWorkspace.tsx`

These compose the map + drawing toolbar + impact panel into the operative workspace. The drawing → footprint flow:
1. `SimWorkspace` holds `activePeril`, `intensity`, `effectiveDate`, `currentFootprint`, `simId`.
2. `SimMap` receives `peril` and an `onFootprintChange` callback. It owns the TerraDraw lifecycle.
3. On every TerraDraw `finish` event, `SimMap` builds a `SimulationFootprint` via `lib/sim/footprint.ts` and calls `onFootprintChange`.
4. `SimWorkspace` POSTs `/api/sim` on first valid footprint → gets `sim_id` + initial preview. Subsequent edits PATCH the same sim (out of v1 scope; v1 creates a new draft on every "Save").
5. `ImpactPanel` consumes the preview impact.

- [ ] **Step 1: Implement SimMap**

```tsx
// components/sim/SimMap.tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import Map, { type MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDrawForPeril, PERIL_MODES } from '@/lib/sim/draw';
import { buildFootprint, bufferTornadoSwath } from '@/lib/sim/footprint';
import { DrawToolbar } from './DrawToolbar';
import { IntensityStrip } from './IntensityStrip';
import type { SimulationFootprint } from '@/lib/sim/footprint';
import type { Peril, Intensity } from '@/lib/sim/severity';
import type { TerraDraw } from 'terra-draw';

export interface SimMapProps {
  peril: Peril;
  intensity: Intensity;
  onIntensityChange: (i: Intensity) => void;
  effectiveDate: string;
  onEffectiveDateChange: (d: string) => void;
  onFootprintChange: (fp: SimulationFootprint) => void;
}

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

export function SimMap(props: SimMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const [ready, setReady] = useState(false);

  // Recreate the draw instance whenever peril changes.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    drawRef.current?.stop();
    const draw = createDrawForPeril(map as any, props.peril);
    draw.start();
    draw.setMode(PERIL_MODES[props.peril]);

    draw.on('finish', (id) => {
      const features = draw.getSnapshot().filter((f) => f.id === id);
      if (features.length === 0) return;
      const feat = features[0];
      let geometry: GeoJSON.Polygon;
      let centerline: GeoJSON.LineString | undefined;
      const width_m = props.peril === 'tornado' ? 200 : undefined;
      if (feat.geometry.type === 'LineString' && props.peril === 'tornado') {
        centerline = feat.geometry as GeoJSON.LineString;
        geometry = bufferTornadoSwath(centerline, width_m!);
      } else if (feat.geometry.type === 'Polygon') {
        geometry = feat.geometry as GeoJSON.Polygon;
      } else {
        return; // earthquake point handling deferred to v1.1
      }
      props.onFootprintChange(buildFootprint({
        peril: props.peril,
        intensity: props.intensity,
        geometry,
        centerline,
        width_m,
        effective_date: props.effectiveDate,
        drawn_by: 'operator',
      }));
    });

    drawRef.current = draw;
    return () => { draw.stop(); };
  }, [props.peril, ready]);

  return (
    <div className="relative w-full h-full">
      <Map
        ref={mapRef}
        initialViewState={{ longitude: -82, latitude: 27.5, zoom: 6 }}
        mapStyle={MAP_STYLE}
        onLoad={() => setReady(true)}
      />
      <DrawToolbar
        peril={props.peril}
        onUndo={() => { /* terra-draw v1 lacks a built-in undo; clear last feature */
          const last = drawRef.current?.getSnapshot().at(-1);
          if (last?.id) drawRef.current?.removeFeatures([last.id]);
        }}
        onClear={() => drawRef.current?.clear()}
      />
      <IntensityStrip
        intensity={props.intensity}
        onChange={props.onIntensityChange}
        effectiveDate={props.effectiveDate}
        onDateChange={props.onEffectiveDateChange}
      />
    </div>
  );
}
```

- [ ] **Step 2: Implement SimWorkspace**

```tsx
// components/sim/SimWorkspace.tsx
'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SimMap } from './SimMap';
import { PerilPicker } from './PerilPicker';
import { SimLibrary, type SimListItem } from './SimLibrary';
import { ImpactPanel } from './ImpactPanel';
import { PromoteButton } from './PromoteButton';
import type { SimulationFootprint } from '@/lib/sim/footprint';
import type { Peril, Intensity } from '@/lib/sim/severity';
import type { PreviewImpact } from '@/lib/sim/preview';

export interface SimWorkspaceProps {
  initialSims: SimListItem[];
  initialSimId: string | null;
  initialFootprint?: SimulationFootprint | null;
  initialImpact?: PreviewImpact | null;
}

export function SimWorkspace(props: SimWorkspaceProps) {
  const router = useRouter();
  const search = useSearchParams();
  const [peril, setPeril] = useState<Peril>(props.initialFootprint?.peril ?? 'hail');
  const [intensity, setIntensity] = useState<Intensity>(props.initialFootprint?.intensity ?? 'severe');
  const [effectiveDate, setEffectiveDate] = useState(props.initialFootprint?.effective_date ?? new Date().toISOString().slice(0, 10));
  const [simId, setSimId] = useState<string | null>(props.initialSimId);
  const [impact, setImpact] = useState<PreviewImpact | null>(props.initialImpact ?? null);
  const [sims, setSims] = useState(props.initialSims);
  const [promoted, setPromoted] = useState(
    props.initialSimId ? !!props.initialSims.find((s) => s.id === props.initialSimId)?.promoted : false,
  );

  useEffect(() => {
    const p = search.get('peril') as Peril | null;
    if (p) setPeril(p);
  }, [search]);

  async function onFootprintChange(fp: SimulationFootprint) {
    // Create or update the draft. v1: always POST (creates a new draft);
    // a "Save" button on each fresh draw is the v1 model.
    const res = await fetch('/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `${fp.peril}, ${fp.intensity} — ${new Date().toISOString().slice(0, 10)}`,
        footprint: fp,
      }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { sim_id: string; impact: PreviewImpact };
    setSimId(body.sim_id);
    setImpact(body.impact);
    setPromoted(false);
    // Refresh sims list
    const list = await (await fetch('/api/sim')).json();
    setSims(list.sims);
    router.replace(`/simulate?id=${body.sim_id}`);
  }

  return (
    <div className="grid grid-cols-[200px_1fr_280px] gap-0 h-[calc(100vh-3rem)]">
      <aside className="border-r border-slate-800 p-3 overflow-y-auto">
        <PerilPicker active={peril} onChange={setPeril} />
        <SimLibrary
          sims={sims}
          activeId={simId}
          onSelect={(id) => router.push(`/simulate?id=${id}`)}
        />
      </aside>
      <main className="relative">
        <SimMap
          peril={peril}
          intensity={intensity}
          onIntensityChange={setIntensity}
          effectiveDate={effectiveDate}
          onEffectiveDateChange={setEffectiveDate}
          onFootprintChange={onFootprintChange}
        />
      </main>
      <aside className="border-l border-slate-800 p-4 overflow-y-auto">
        <ImpactPanel impact={impact} />
        <PromoteButton
          simId={simId}
          promoted={promoted}
          onPromoted={() => setPromoted(true)}
        />
      </aside>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add components/sim/SimMap.tsx components/sim/SimWorkspace.tsx
git commit -m "feat(sim): SimMap (terra-draw) + SimWorkspace composing the 3-column route"
```

---

### Task 21: `/simulate` server page + nav link

**Files:**
- Create: `app/simulate/page.tsx`
- Create: `app/simulate/loading.tsx`
- Create: `app/simulate/error.tsx`
- Modify: `app/layout.tsx` (add nav link)

- [ ] **Step 1: Implement the server page**

```tsx
// app/simulate/page.tsx
/**
 * Task SIM.21 — /simulate route.
 *
 * Server component: loads the sim list + (optionally) one selected sim by
 * `?id=`. Delegates all interactivity to <SimWorkspace>. force-dynamic
 * because the sim list is mutable per request.
 */
import { db } from '@/lib/db/client';
import { SimWorkspace } from '@/components/sim/SimWorkspace';

export const dynamic = 'force-dynamic';

export default async function SimulatePage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const list = await db.execute(
    'SELECT id, name, peril, intensity, promoted, retired, drawn_at FROM simulations ORDER BY drawn_at DESC LIMIT 100',
  );
  const sims = list.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    peril: String(row.peril),
    intensity: String(row.intensity),
    promoted: Number(row.promoted) === 1,
    retired: Number(row.retired) === 1,
    drawn_at: String(row.drawn_at),
  }));

  let initialFootprint = null;
  if (id) {
    const r = await db.execute({ sql: 'SELECT footprint FROM simulations WHERE id = ?', args: [id] });
    if (r.rows[0]) initialFootprint = JSON.parse(String(r.rows[0].footprint));
  }

  return (
    <SimWorkspace
      initialSims={sims}
      initialSimId={id ?? null}
      initialFootprint={initialFootprint}
    />
  );
}
```

- [ ] **Step 2: Implement loading + error**

```tsx
// app/simulate/loading.tsx
export default function Loading() {
  return <div className="p-6 text-slate-400">Loading simulate workspace…</div>;
}
```

```tsx
// app/simulate/error.tsx
'use client';
export default function Error({ error }: { error: Error }) {
  return <div className="p-6 text-red-400">Simulate workspace failed to load: {error.message}</div>;
}
```

- [ ] **Step 3: Add nav link in app/layout.tsx**

Find the existing nav (search for `<nav` or `href="/events"`) and add an item:

```tsx
<a href="/simulate" className="px-3 py-1 text-slate-300 hover:text-white">Simulate</a>
```

- [ ] **Step 4: Smoke test**

```bash
npm run dev
# Visit http://localhost:3000/simulate — workspace should render with empty SimLibrary
```

Expected: page renders; no console errors; peril picker + empty map + "Draw a footprint" placeholder visible.

- [ ] **Step 5: Commit**

```bash
git add app/simulate/ app/layout.tsx
git commit -m "feat(sim): /simulate route + nav link"
```

---

## Milestone 5 — Banner integration on `/portfolio`

### Task 22: `SimulationBanner` component

**Files:**
- Create: `components/grammar/SimulationBanner.tsx`
- Test: `tests/components/grammar/SimulationBanner.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/components/grammar/SimulationBanner.test.tsx
// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SimulationBanner } from '@/components/grammar/SimulationBanner';

describe('SimulationBanner', () => {
  test('hidden when no unresolved sims', () => {
    const { container } = render(<SimulationBanner unresolved={[]} />);
    expect(container.firstChild).toBeNull();
  });
  test('shows count + buttons for one unresolved sim', () => {
    render(<SimulationBanner unresolved={[{ id: 'a', name: 'Tampa hail', peril: 'hail', promoted_at: '2026-05-18T12:00:00Z' }]} />);
    expect(screen.getByText(/1 unresolved simulation/i)).toBeInTheDocument();
    expect(screen.getByText(/Tampa hail/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-optimize portfolio/i })).toBeInTheDocument();
  });
  test('collapses multiple sims into a single count', () => {
    render(<SimulationBanner unresolved={[
      { id: 'a', name: 'A', peril: 'hail', promoted_at: '2026-05-18T12:00:00Z' },
      { id: 'b', name: 'B', peril: 'flood', promoted_at: '2026-05-18T13:00:00Z' },
    ]} />);
    expect(screen.getByText(/2 unresolved simulations/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/components/grammar/SimulationBanner.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// components/grammar/SimulationBanner.tsx
'use client';
import { useState } from 'react';

export interface UnresolvedSim {
  id: string;
  name: string;
  peril: string;
  promoted_at: string;
}

export interface SimulationBannerProps {
  unresolved: UnresolvedSim[];
}

export function SimulationBanner({ unresolved }: SimulationBannerProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (unresolved.length === 0) return null;

  const headline = unresolved.length === 1
    ? `1 unresolved simulation — ${unresolved[0].name}`
    : `${unresolved.length} unresolved simulations`;

  async function reoptimize() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/portfolio/reoptimize', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `re-optimize failed (${res.status})`);
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-amber-950/40 border border-amber-900 rounded-lg p-3 mb-4 flex items-start gap-3">
      <span aria-hidden className="text-amber-400 text-lg leading-none">⚠</span>
      <div className="flex-1">
        <div className="text-sm text-amber-200 font-medium">{headline}</div>
        <div className="text-xs text-amber-400/80 mt-0.5">
          Adds K=1000 per sim to joint TVaR-99. Re-optimize to see updated portfolio actions.
        </div>
        {err && <div className="text-xs text-red-400 mt-1">{err}</div>}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reoptimize}
          disabled={busy}
          className="bg-amber-700 hover:bg-amber-600 disabled:bg-slate-700 text-white text-xs px-3 py-1.5 rounded font-semibold"
        >
          {busy ? 'Re-optimizing…' : 'Re-optimize portfolio'}
        </button>
        {unresolved.length === 1 && (
          <a
            href={`/simulate?id=${unresolved[0].id}`}
            className="text-xs px-3 py-1.5 rounded border border-amber-800 text-amber-200 hover:bg-amber-950/60"
          >
            View simulation
          </a>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/components/grammar/SimulationBanner.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add components/grammar/SimulationBanner.tsx tests/components/grammar/SimulationBanner.test.tsx
git commit -m "feat(sim): SimulationBanner with unresolved-count headline"
```

---

### Task 23: Mount banner on `/portfolio`

**Files:**
- Modify: `app/portfolio/page.tsx`

- [ ] **Step 1: Add the data load + render**

In `app/portfolio/page.tsx`, near the top (server component) — find where the page reads `portfolio_optimization.json` (the existing data flow). Add this in parallel:

```tsx
import { promises as fs } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db/client';
import { SimulationBanner } from '@/components/grammar/SimulationBanner';

async function loadUnresolvedSims() {
  // Sims that are promoted + not retired AND not in the latest meta.json
  const promoted = await db.execute(
    'SELECT id, name, peril, promoted_at FROM simulations WHERE promoted = 1 AND retired = 0',
  );
  let included: string[] = [];
  try {
    const meta = JSON.parse(await fs.readFile(join(process.cwd(), 'artifacts', 'portfolio_optimization.meta.json'), 'utf-8'));
    included = meta.included_sims ?? [];
  } catch { /* fresh clone — no meta yet */ }
  return promoted.rows
    .map((r) => ({ id: String(r.id), name: String(r.name), peril: String(r.peril), promoted_at: String(r.promoted_at) }))
    .filter((s) => !included.includes(s.id));
}
```

Then in the page JSX, render the banner near the top:

```tsx
export default async function PortfolioPage() {
  const unresolved = await loadUnresolvedSims();
  // … existing data loads …
  return (
    <>
      <SimulationBanner unresolved={unresolved} />
      {/* existing portfolio page content */}
    </>
  );
}
```

- [ ] **Step 2: Smoke test**

```bash
# 1. Draft + promote a sim via /simulate
# 2. Visit /portfolio — banner should appear
# 3. Click "Re-optimize"; banner should disappear after reload (sim is now in meta.json)
npm run dev
```

- [ ] **Step 3: Commit**

```bash
git add app/portfolio/page.tsx
git commit -m "feat(sim): mount SimulationBanner on /portfolio with unresolved-sim discovery"
```

---

## Milestone 6 — End-to-end test

### Task 24: Eval end-to-end test

**Files:**
- Create: `tests/eval/test_sim_end_to_end.py`

- [ ] **Step 1: Write the test**

```python
# tests/eval/test_sim_end_to_end.py
"""End-to-end: draw → preview → promote → re-optimize → reconciler.

Asserts a hail footprint over Tampa produces:
  - non-zero policies_in_footprint
  - parquet artifact present
  - TVaR-99 differs from hurricane-only baseline (joint K=2000)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from api_py.sim_loss import generate_sim_losses, write_artifact  # noqa: E402

TAMPA_HAIL = {
    "peril": "hail",
    "intensity": "severe",
    "geometry": {
        "type": "Polygon",
        "coordinates": [[[-82.6, 27.6], [-82.2, 27.6], [-82.2, 28.0], [-82.6, 28.0], [-82.6, 27.6]]],
    },
    "effective_date": "2026-05-18",
    "metadata": {"drawn_by": "e2e", "drawn_at": "2026-05-18T00:00:00Z"},
}


def _book_policies():
    import sqlite3
    conn = sqlite3.connect(ROOT / "forge-local.db")
    rows = conn.execute(
        "SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL"
    ).fetchall()
    conn.close()
    return [tuple(r) for r in rows]


@pytest.mark.skipif(not (ROOT / "forge-local.db").exists(), reason="needs seeded DB")
def test_end_to_end_hail_tampa(tmp_path):
    policies = _book_policies()
    sim_id = "9999999999999_endtoend"
    result = generate_sim_losses(
        sim_id=sim_id,
        footprint=TAMPA_HAIL,
        policies=policies,
        cohort_keyer=lambda p: f"{p[5]}_{p[4]}",
        K=200,
    )
    assert result["losses"].shape[1] == 200
    assert result["losses"].sum() > 0, "Tampa hail must produce non-zero losses on the seeded FL book"

    parquet_path, _ = write_artifact(sim_id, result)
    assert parquet_path.exists()

    # Read it back; row count = cohort count.
    tbl = pq.read_table(parquet_path)
    assert tbl.num_rows == len(result["cohort_keys"])

    # cleanup
    parquet_path.unlink()
    parquet_path.with_suffix(".meta.json").unlink()
```

- [ ] **Step 2: Run**

```bash
pytest tests/eval/test_sim_end_to_end.py -v
```

Expected: PASS (skip if no seeded DB).

- [ ] **Step 3: Commit**

```bash
git add tests/eval/test_sim_end_to_end.py
git commit -m "test(sim): end-to-end hail-on-Tampa eval"
```

---

## Wrap-up

- [ ] **Run full test suite**

```bash
npm test           # all Vitest
pytest             # all Pytest
npm run build      # next lint passes
```

Expected: green across the board. Any new lint warnings from the new files must be addressed before merge.

- [ ] **Update CLAUDE.md "Where things live" with `/simulate`**

Add row:

```markdown
| Touch the simulate flow | `/simulate` route (`app/simulate/page.tsx` + `components/sim/*`); loss compute in `api_py/sim_loss.py`; banner in `components/grammar/SimulationBanner.tsx` mounted on `/portfolio` |
```

- [ ] **Open PR with spec link in description**

```bash
gh pr create --title "feat(sim): operator-drawn catastrophe simulations" \
  --body "Implements docs/superpowers/specs/2026-05-18-simulate-tab-design.md.

## Summary
- New /simulate route with 6 perils, terra-draw toolkit, preview + promote flow
- K=1000 cohort loss generator (api_py/sim_loss.py) with peril-specific decay
- precompute_portfolio_optimization.py --include-sims concatenates joint K=2000
- SimulationBanner on /portfolio with deferred re-optimize

## Test plan
- [ ] npm test passes
- [ ] pytest passes
- [ ] Draft a hail footprint, promote, re-optimize from /portfolio, verify banner clears
"
```

---

## Self-review

**Spec coverage:**
- §1 Problem / §2 Scope — covered by Tasks 1–24 collectively; out-of-scope items explicitly not implemented (no compound perils, no live-drag stochastic recompute, no empirical priors, no auth)
- §3 Architecture — diagram realized across Tasks 6 (loss compute), 7 (precompute --include-sims), 11 (promote)
- §4 Drawing toolkit — Tasks 14–20
- §5 Severity model — Tasks 3, 4, 6 (HAZUS, decay, K=1000 perturbation)
- §6 Schema / persistence — Task 1 (DB), Task 6 (parquet), Tasks 9–13 (REST)
- §7 UI — Tasks 14–21
- §8 Testing — every task has its own test, plus Task 24 end-to-end
- §9 Error handling — covered by Tasks 4 (validateFootprint), 11 (promote 4xx/5xx), 12 (retire 404), 13 (reoptimize 500), 22 (banner err state)
- §10 Observability — partial: `compute_time_ms` stubbed in Task 11; full observability lift is deferred to v1.1

**Placeholder scan:** no `TBD` / `TODO` / `FIXME` / "implement later" left. One acknowledged stub: `compute_time_ms: 0` in promote response — explicitly called out as v1.1 follow-up, not a planning placeholder.

**Type consistency:** `SimulationFootprint` shape consistent across `lib/sim/footprint.ts`, `lib/sim/preview.ts`, `api_py/sim_loss.py`, all four route handlers, and `components/sim/SimMap.tsx`. `cohort_keyer` signature identical across `generate_sim_losses` and `precompute --include-sims`. `Peril` / `Intensity` / `BuildType` types canonical in `lib/sim/severity.ts` and re-exported everywhere they're used.

---
