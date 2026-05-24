// @vitest-environment node
/**
 * Task P3.23 — US state topojson contract.
 *
 * Pins state coverage + the iso_code lookup + the FeatureCollection
 * shape that the choropleth consumes. v2 uses real Census Bureau
 * cartographic polygons via us-atlas (see lib/geo/state_topojson.ts).
 * Geometries are now Polygon OR MultiPolygon depending on whether the
 * state has islands / exclaves (CA, MI, FL, HI, AK, etc. are
 * MultiPolygon; TX, CO, WY, etc. are single Polygon).
 */
import { describe, test, expect } from 'vitest';
import {
  STATE_FEATURES,
  stateByIsoCode,
  statesFeatureCollection,
} from '@/lib/geo/state_topojson';

describe('STATE_FEATURES coverage', () => {
  test('covers all 50 US states + DC (51 features)', () => {
    // us-atlas ships 50 states + DC; territories are excluded
    // (per the FIPS_TO_USPS map in scripts/build_state_geojson.py).
    expect(STATE_FEATURES).toHaveLength(51);
  });

  test('every state has a valid Polygon or MultiPolygon geometry', () => {
    for (const f of STATE_FEATURES) {
      expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type);
      // Coordinates payload must be non-empty regardless of variant.
      if (f.geometry.type === 'Polygon') {
        const ring = f.geometry.coordinates[0]!;
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring[ring.length - 1]);  // closed
      } else {
        expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(1);
        const firstRing = f.geometry.coordinates[0]![0]!;
        expect(firstRing.length).toBeGreaterThanOrEqual(4);
        expect(firstRing[0]).toEqual(firstRing[firstRing.length - 1]);
      }
    }
  });

  test('every state has a 2-letter USPS iso_code', () => {
    for (const f of STATE_FEATURES) {
      expect(f.iso_code).toMatch(/^[A-Z]{2}$/);
    }
  });

  test('iso_codes are unique', () => {
    const codes = new Set(STATE_FEATURES.map((f) => f.iso_code));
    expect(codes.size).toBe(51);
  });

  test('every state has a 2-digit FIPS code', () => {
    for (const f of STATE_FEATURES) {
      expect(f.fips).toMatch(/^\d{2}$/);
    }
  });

  test('covers the FORGE-relevant coastal states', () => {
    const codes = new Set(STATE_FEATURES.map((f) => f.iso_code));
    for (const code of ['FL', 'TX', 'LA', 'NC', 'SC', 'GA', 'AL', 'MS', 'CA']) {
      expect(codes.has(code)).toBe(true);
    }
  });

  test('island / exclave states render as MultiPolygon', () => {
    // Sanity check that we're not silently dropping islands.
    for (const code of ['CA', 'MI', 'FL', 'HI', 'AK', 'MA']) {
      const f = stateByIsoCode(code);
      expect(f).not.toBeNull();
      expect(f!.geometry.type).toBe('MultiPolygon');
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

  test('FIPS code lookups join correctly (FL = 12)', () => {
    expect(stateByIsoCode('FL')!.fips).toBe('12');
    expect(stateByIsoCode('TX')!.fips).toBe('48');
    expect(stateByIsoCode('CA')!.fips).toBe('06');
  });
});

describe('statesFeatureCollection', () => {
  test('returns a GeoJSON FeatureCollection with 51 features', () => {
    const fc = statesFeatureCollection();
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(51);
  });

  test('each feature carries iso_code + name + fips in properties', () => {
    const fc = statesFeatureCollection();
    for (const f of fc.features) {
      expect(f.properties).not.toBeNull();
      expect(typeof f.properties!.iso_code).toBe('string');
      expect(typeof f.properties!.name).toBe('string');
      expect(typeof f.properties!.fips).toBe('string');
    }
  });
});
