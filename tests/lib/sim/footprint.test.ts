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
