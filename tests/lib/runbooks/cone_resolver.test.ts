// @vitest-environment node
/**
 * Task AUDIT.5 — Cone → ZIP3 resolver tests.
 *
 * `resolveConeToZip3s` is a pure function (cone + centroids → zip3 list)
 * so the tests just feed synthetic centroids + synthetic cone polygons
 * and verify the right ZIP3s come out.
 */
import { describe, expect, test } from 'vitest';
import {
  resolveConeToZip3s,
  resolveConeToZip3sFromBook,
} from '@/lib/runbooks/cone_resolver';
import type { PolygonLike } from '@/lib/geo/point_in_polygon';

// A unit square polygon centered at the origin: [-1, 1] × [-1, 1].
function unitSquareCone(): PolygonLike {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ],
    ],
  };
}

// A FL-coast-ish cone (the demo Idalia / Helene approach footprint):
// rough Polygon covering 27-31N lat × 81-86W lon.
function flCoastCone(): PolygonLike {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-86, 27],
        [-81, 27],
        [-81, 31],
        [-86, 31],
        [-86, 27],
      ],
    ],
  };
}

describe('resolveConeToZip3s', () => {
  test('returns empty list when cone is null', () => {
    const centroids = { '330': [-82, 28] } as const;
    expect(resolveConeToZip3s(null, centroids as never)).toEqual([]);
    expect(resolveConeToZip3s(undefined, centroids as never)).toEqual([]);
  });

  test('returns empty list when no centroids match', () => {
    const cone = unitSquareCone();
    const centroids = {
      'far-1': [10, 10] as [number, number],
      'far-2': [-10, -10] as [number, number],
    };
    expect(resolveConeToZip3s(cone, centroids)).toEqual([]);
  });

  test('returns all centroids inside the cone, sorted', () => {
    const cone = unitSquareCone();
    const centroids = {
      // Insertion order intentionally NOT lex-sorted to verify the
      // resolver applies its own sort.
      zzz: [0, 0] as [number, number],
      aaa: [0.5, 0.5] as [number, number],
      mmm: [-0.5, -0.5] as [number, number],
      outside: [5, 5] as [number, number],
    };
    expect(resolveConeToZip3s(cone, centroids)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  test('FL coast cone catches FL ZIPs and rejects out-of-state', () => {
    const cone = flCoastCone();
    const centroids = {
      '330': [-82.5, 28.0] as [number, number], // Tampa-ish — in cone
      '335': [-82.4, 28.5] as [number, number], // Pasco — in cone
      '286': [-82.5, 35.5] as [number, number], // NC mountains — OUT (lat)
      '770': [-95.4, 29.7] as [number, number], // Houston — OUT (lon)
      '396': [-89.4, 32.3] as [number, number], // Jackson MS — OUT (lon)
    };
    expect(resolveConeToZip3s(cone, centroids)).toEqual(['330', '335']);
  });

  test('Feature-wrapped cone is accepted (matches fetch_nhc_cone shape)', () => {
    const cone: PolygonLike = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: unitSquareCone().type === 'Polygon'
          ? (unitSquareCone() as { coordinates: number[][][] }).coordinates
          : [],
      },
    };
    const centroids = { in: [0, 0] as [number, number], out: [5, 5] as [number, number] };
    expect(resolveConeToZip3s(cone, centroids)).toEqual(['in']);
  });
});

describe('resolveConeToZip3sFromBook', () => {
  test('returns {zip3_list, count, centroids_count} with the centroid-loader result', async () => {
    const cone = unitSquareCone();
    const loader = async () => ({
      a: [0, 0] as [number, number],
      b: [5, 5] as [number, number],
      c: [-0.5, 0.5] as [number, number],
    });
    const result = await resolveConeToZip3sFromBook(cone, loader);
    expect(result.zip3_list).toEqual(['a', 'c']);
    expect(result.count).toBe(2);
    expect(result.centroids_count).toBe(3);
  });

  test('null cone short-circuits — empty list, but centroids_count still reflects the loader', async () => {
    const loader = async () => ({ a: [0, 0] as [number, number] });
    const result = await resolveConeToZip3sFromBook(null, loader);
    expect(result.zip3_list).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.centroids_count).toBe(1);
  });
});
