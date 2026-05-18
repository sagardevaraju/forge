/**
 * Task P2.21 — Point-in-polygon (ray casting).
 *
 * Standard W. Randolph Franklin / "PNPOLY" ray-casting algorithm. Cast a
 * horizontal ray from the test point to the right and count the number of
 * polygon edge crossings — odd means inside, even means outside.
 *
 * We accept GeoJSON Polygon / MultiPolygon geometries (or wrapped Feature)
 * because that's what `fetch_nhc_cone` emits. Holes (inner rings) flip the
 * crossing-count so a point that's inside the outer ring but inside a hole is
 * reported as outside, matching GeoJSON-rfc7946 semantics.
 *
 * Boundary handling is deterministic but arbitrary: the strict-less
 * comparison used here treats a point exactly on a vertical edge as outside.
 * That's fine for our use case (ZIP3 centroids sitting on the FIRMS cone
 * boundary is astronomically unlikely in practice, but we want the function
 * to be a pure function with no random results — every input maps to the
 * same boolean).
 *
 * No external deps — Turf would be a 100kB add for a 20-line algorithm.
 */

export type LngLat = readonly [number, number]; // [lon, lat]
export type Ring = readonly LngLat[];

interface PolygonGeom {
  type: 'Polygon';
  coordinates: number[][][]; // [outer, ...holes][ring_idx][vertex_idx][lon|lat]
}

interface MultiPolygonGeom {
  type: 'MultiPolygon';
  coordinates: number[][][][]; // [polygon][ring][vertex][lon|lat]
}

interface FeatureGeom {
  type: 'Feature';
  geometry: PolygonGeom | MultiPolygonGeom;
}

export type PolygonLike = PolygonGeom | MultiPolygonGeom | FeatureGeom;

/**
 * Ray-cast against a single closed ring. Returns true when the point's
 * horizontal ray to +infinity crosses an odd number of edges.
 */
function pointInRing(point: LngLat, ring: Ring): boolean {
  const [x, y] = point;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringFromCoords(raw: number[][]): Ring {
  return raw.map((p) => [p[0], p[1]] as LngLat);
}

/**
 * Point-in-polygon for a GeoJSON Polygon / MultiPolygon / Feature wrapper.
 * Returns false for malformed inputs rather than throwing — callers (the
 * exposure mini-map) treat "couldn't classify" the same as "outside the
 * cone" for the headline ratio.
 */
export function pointInPolygon(point: LngLat, poly: PolygonLike | null | undefined): boolean {
  if (!poly) return false;
  const geom = poly.type === 'Feature' ? poly.geometry : poly;
  if (!geom) return false;

  if (geom.type === 'Polygon') {
    const rings = geom.coordinates;
    if (!rings || rings.length === 0) return false;
    const outer = ringFromCoords(rings[0]);
    if (!pointInRing(point, outer)) return false;
    // Holes: must be outside every inner ring.
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(point, ringFromCoords(rings[i]))) return false;
    }
    return true;
  }

  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (!poly || poly.length === 0) continue;
      const outer = ringFromCoords(poly[0]);
      if (!pointInRing(point, outer)) continue;
      let inHole = false;
      for (let i = 1; i < poly.length; i++) {
        if (pointInRing(point, ringFromCoords(poly[i]))) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    return false;
  }

  return false;
}
