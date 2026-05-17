/**
 * Task P2.23 — Convex hull via Andrew's monotone chain.
 *
 * Used by `generate_scenarios` to wrap the perturbed-track point cloud at
 * each forecast horizon (24h/48h/72h) into a single Polygon ring that the
 * EventConsole can render as a heat-tinted uncertainty band underneath the
 * official NHC cone.
 *
 * Why Andrew's monotone chain:
 *   - O(n log n), no recursion, ~25 lines — trivial to inline.
 *   - Adding a hull library (Turf, hull.js) would be a 50–100 kB import for
 *     a function we can write by hand. Per CLAUDE.md: "Don't add a
 *     convex-hull library."
 *   - Works on raw (lng, lat) pairs treated as flat 2D points. We don't
 *     need spherical geometry — the perturbations span tens of degrees at
 *     most, and the rendering layer is a flat Web Mercator basemap.
 *
 * The cross-product test uses strict `<= 0` so collinear interior points
 * are dropped — only the extremes of a degenerate (line/coincident) cloud
 * survive. The returned ring is closed (first vertex repeated as the
 * last) so it can be dropped straight into a GeoJSON Polygon's
 * `coordinates: [ring]` slot.
 */

export interface LngLat {
  lng: number;
  lat: number;
}

export type HullPoint = [number, number]; // [lng, lat]

/**
 * Cross product of OA × OB. Positive → counter-clockwise turn,
 * negative → clockwise turn, zero → collinear.
 */
function cross(O: HullPoint, A: HullPoint, B: HullPoint): number {
  return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
}

/**
 * Andrew's monotone chain. Returns the convex hull as a closed ring
 * `[[lng, lat], ..., [lng, lat]]` where the first vertex equals the last.
 * Returns `[]` for empty input, the single point for one input, and a
 * 2-point pseudo-ring for two distinct points.
 */
export function convexHull(points: ReadonlyArray<LngLat>): HullPoint[] {
  if (points.length === 0) return [];
  // De-dup + sort by (lng, lat).
  const seen = new Set<string>();
  const pts: HullPoint[] = [];
  for (const p of points) {
    const key = `${p.lng},${p.lat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push([p.lng, p.lat]);
  }
  if (pts.length === 1) return [pts[0]];
  pts.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length === 2) return [pts[0], pts[1]];

  // Lower hull.
  const lower: HullPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  // Upper hull.
  const upper: HullPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  // Concat without repeating the boundary points; then close by appending
  // the start vertex.
  lower.pop();
  upper.pop();
  const ring = lower.concat(upper);
  if (ring.length === 0) return [];
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}
