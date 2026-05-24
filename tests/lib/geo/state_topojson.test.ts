// @vitest-environment node
/**
 * Task P3.23 — US state topojson contract.
 *
 * Pins the 50-state coverage + the iso_code lookup + the FeatureCollection
 * shape that the choropleth consumes. v1 uses bounding-box geometries
 * (placeholder — see lib/geo/state_topojson.ts swap-point note).
 */
import { describe, test, expect } from 'vitest';
import {
  STATE_FEATURES,
  stateByIsoCode,
  statesFeatureCollection,
} from '@/lib/geo/state_topojson';

describe('STATE_FEATURES coverage', () => {
  test('covers all 50 US states', () => {
    expect(STATE_FEATURES).toHaveLength(50);
  });

  test('every state has a valid Polygon geometry', () => {
    for (const f of STATE_FEATURES) {
      expect(f.geometry.type).toBe('Polygon');
      const ring = f.geometry.coordinates[0]!;
      expect(ring.length).toBeGreaterThanOrEqual(4);
      // Closed ring.
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  test('every state has a 2-letter USPS iso_code', () => {
    for (const f of STATE_FEATURES) {
      expect(f.iso_code).toMatch(/^[A-Z]{2}$/);
    }
  });

  test('iso_codes are unique', () => {
    const codes = new Set(STATE_FEATURES.map((f) => f.iso_code));
    expect(codes.size).toBe(50);
  });

  test('covers the FORGE-relevant coastal states', () => {
    const codes = new Set(STATE_FEATURES.map((f) => f.iso_code));
    for (const code of ['FL', 'TX', 'LA', 'NC', 'SC', 'GA', 'AL', 'MS', 'CA']) {
      expect(codes.has(code)).toBe(true);
    }
  });
});

describe('stateByIsoCode', () => {
  test('returns the matching state for an uppercase code', () => {
    const fl = stateByIsoCode('FL');
    expect(fl).not.toBeNull();
    expect(fl!.name).toBe('Florida');
  });

  test('normalises lowercase + whitespace', () => {
    const fl = stateByIsoCode('  fl  ');
    expect(fl).not.toBeNull();
    expect(fl!.iso_code).toBe('FL');
  });

  test('returns null for unknown codes', () => {
    expect(stateByIsoCode('ZZ')).toBeNull();
  });
});

describe('statesFeatureCollection', () => {
  test('returns a GeoJSON FeatureCollection with 50 features', () => {
    const fc = statesFeatureCollection();
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(50);
  });

  test('each feature carries iso_code + name in properties', () => {
    const fc = statesFeatureCollection();
    for (const f of fc.features) {
      expect(f.properties).not.toBeNull();
      expect(typeof f.properties!.iso_code).toBe('string');
      expect(typeof f.properties!.name).toBe('string');
    }
  });
});
