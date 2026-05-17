/**
 * Task P2.23 — Convex hull (Andrew's monotone chain) tests.
 *
 * The hull powers the GEFS cone-uncertainty envelope: given the perturbed
 * track points at a given horizon (24h/48h/72h), we wrap them in a polygon
 * and render the polygon as a heat-tinted fill under the official cone.
 *
 * The function is small and isolated, so the unit tests are exhaustive on
 * the edge cases that matter operationally:
 *   - The "easy" case: corners of a square plus interior points → only the
 *     four corners survive in the hull.
 *   - Collinear points → only the two extremes survive (no degenerate
 *     middle vertex), which matters when the perturbation ensemble
 *     collapses to a line.
 *   - Empty input → empty array (no throw); callers can pipe through.
 *   - Single point / two points → degenerate but non-throwing return.
 *   - Closed ring: the returned ring repeats the first vertex as the last
 *     so it's a valid GeoJSON Polygon coordinate ring.
 */
import { describe, test, expect } from 'vitest';
import { convexHull } from '@/lib/geo/convex_hull';

describe('convexHull (Andrew\'s monotone chain)', () => {
  test('square corners + interior points → 4 corners (closed)', () => {
    const pts = [
      { lng: 0, lat: 0 },
      { lng: 1, lat: 0 },
      { lng: 1, lat: 1 },
      { lng: 0, lat: 1 },
      { lng: 0.5, lat: 0.5 }, // interior
      { lng: 0.3, lat: 0.7 }, // interior
      { lng: 0.8, lat: 0.2 }, // interior
    ];
    const hull = convexHull(pts);
    // Closed ring → 4 corners + 1 repeat
    expect(hull.length).toBe(5);
    expect(hull[0]).toEqual(hull[hull.length - 1]);
    // All 4 corners present (order is implementation-defined but the set is fixed).
    const set = new Set(hull.map((p) => `${p[0]},${p[1]}`));
    expect(set.has('0,0')).toBe(true);
    expect(set.has('1,0')).toBe(true);
    expect(set.has('1,1')).toBe(true);
    expect(set.has('0,1')).toBe(true);
    // No interior point survived.
    expect(set.has('0.5,0.5')).toBe(false);
  });

  test('collinear points return only the extremes', () => {
    // All on the line y=0 from x=0..4. Hull should be just the two endpoints.
    const pts = [
      { lng: 0, lat: 0 },
      { lng: 1, lat: 0 },
      { lng: 2, lat: 0 },
      { lng: 3, lat: 0 },
      { lng: 4, lat: 0 },
    ];
    const hull = convexHull(pts);
    // Two unique extremes; ring closes by repeating first.
    const unique = new Set(hull.map((p) => `${p[0]},${p[1]}`));
    expect(unique.has('0,0')).toBe(true);
    expect(unique.has('4,0')).toBe(true);
    expect(unique.size).toBe(2);
  });

  test('empty input returns empty array', () => {
    expect(convexHull([])).toEqual([]);
  });

  test('single point returns that point (degenerate but non-throwing)', () => {
    const hull = convexHull([{ lng: 1, lat: 2 }]);
    expect(hull.length).toBeGreaterThanOrEqual(1);
    expect(hull[0]).toEqual([1, 2]);
  });

  test('two distinct points return the two extremes', () => {
    const hull = convexHull([
      { lng: 0, lat: 0 },
      { lng: 1, lat: 1 },
    ]);
    const unique = new Set(hull.map((p) => `${p[0]},${p[1]}`));
    expect(unique.has('0,0')).toBe(true);
    expect(unique.has('1,1')).toBe(true);
  });

  test('returned ring is closed (first == last) when there are 3+ unique points', () => {
    const pts = [
      { lng: 0, lat: 0 },
      { lng: 2, lat: 0 },
      { lng: 1, lat: 2 },
      { lng: 1, lat: 0.5 }, // interior
    ];
    const hull = convexHull(pts);
    expect(hull[0]).toEqual(hull[hull.length - 1]);
  });

  test('handles duplicate points without exploding', () => {
    const pts = [
      { lng: 0, lat: 0 },
      { lng: 0, lat: 0 },
      { lng: 1, lat: 0 },
      { lng: 1, lat: 1 },
      { lng: 1, lat: 1 },
      { lng: 0, lat: 1 },
    ];
    const hull = convexHull(pts);
    const unique = new Set(hull.map((p) => `${p[0]},${p[1]}`));
    expect(unique.size).toBe(4);
  });
});
