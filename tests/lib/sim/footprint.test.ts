// @vitest-environment node
import { describe, test, expect } from 'vitest';
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
