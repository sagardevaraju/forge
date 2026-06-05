/**
 * TypeScript port of the K=1000 Monte-Carlo loss-distribution model.
 *
 * This is a faithful port of `api_py/sim_loss.py`'s `generate_sim_losses` +
 * `_summarize`, producing the **scenario-total** loss distribution in-process
 * so the Next.js Node route can compute the live K=1000 loss distribution
 * without a Python round-trip (Vercel can't deploy the Python function inside a
 * Next.js monorepo).
 *
 * The damage-ratio model is REUSED from `lib/sim/severity.ts`
 * (`damageRatio`) — the Python `_damage_ratio` mirrors it exactly, so we do not
 * re-port the HAZUS matrix or per-peril multipliers here. Only the
 * stochastic envelope (geometry perturbation, common-factor residual,
 * point-in-polygon, decay) and the histogram/summary reduction are ported.
 *
 * Bit-exactness with the Python RNG (numpy's PCG64) is impossible across
 * implementations; this module uses a deterministic mulberry32 + Box-Muller
 * stream instead. Same `seed` string → identical output here; the distribution
 * is statistically equivalent to the Python one (tolerance-parity, not
 * bit-parity — see tests/lib/sim/loss-model.test.ts test 7).
 *
 * Task SIM.6 (port) — see api_py/sim_loss.py for the canonical algorithm.
 */
import { createHash } from 'crypto';
import { damageRatio } from './severity';
import type { SimulationFootprint } from './footprint';
import type { Policy } from './preview';

// ── Constants (ported exactly from api_py/sim_loss.py) ──────────────────────

/** Per-peril perturbation σ — mirrors `_PERTURB`. Default vertex_deg = 0.003. */
const PERTURB: Record<string, { vertex_deg?: number; width_pct?: number; epicenter_deg?: number; magnitude?: number }> = {
  tornado: { vertex_deg: 0.005, width_pct: 0.15 },
  flood: { vertex_deg: 0.003 },
  hail: { vertex_deg: 0.003 },
  wildfire: { vertex_deg: 0.003 },
  winter: { vertex_deg: 0.003 },
  earthquake: { epicenter_deg: 0.01, magnitude: 0.15 },
};

const DEFAULT_VERTEX_DEG = 0.003;
/** Common-factor residual: factor = max(0, 1 + β·ε), ε ~ N(0, σ). */
const DEFAULT_BETA = 0.5;
const DEFAULT_SIGMA = 0.3;

export interface LossModelOptions {
  K?: number;
  beta?: number;
  sigma?: number;
  seed: string;
}

export interface LossDistribution {
  histogram: { bin_edges: number[]; counts: number[] };
  summary: {
    mean: number;
    p50: number;
    p90: number;
    p99: number;
    tvar99: number;
    min: number;
    max: number;
  };
}

// ── Deterministic RNG (mulberry32 + Box-Muller) ─────────────────────────────

/**
 * Replicates the Python `_sim_seed`: the first 8 hex chars of sha256(seed)
 * parsed as a 32-bit int (|| 1 so a zero hash maps to a valid seed).
 */
function simSeed(s: string): number {
  return parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) || 1;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(rand: () => number): () => number {
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// ── Geometry helpers ────────────────────────────────────────────────────────

type Ring = number[][]; // array of [lon, lat]

/**
 * Even-odd ray-casting point-in-polygon on a polygon's exterior ring.
 * Inlined (vs. @turf/boolean-point-in-polygon) because this runs K×N times.
 */
function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Jitter every vertex of the exterior ring by an isotropic Gaussian
 * N(0, sigmaDeg). Re-closes the ring (last vertex = first). Mirrors
 * `_perturbed_polygon`.
 */
function perturbRing(ring: Ring, sigmaDeg: number, gaussian: () => number): Ring {
  const out: Ring = ring.map(([x, y]) => [x + gaussian() * sigmaDeg, y + gaussian() * sigmaDeg]);
  // Re-close the ring.
  out[out.length - 1] = out[0];
  return out;
}

/**
 * Squared-distance from point (px,py) to segment (ax,ay)-(bx,by), in deg².
 * Used to compute the exterior-ring distance for the decay term.
 */
function pointSegDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/** Distance (deg) from a point to the polygon exterior ring (segment-wise). */
function distToRingDeg(lon: number, lat: number, ring: Ring): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = pointSegDistSq(lon, lat, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * Severity decay multiplier as a function of distance from the perturbed
 * polygon exterior. Mirrors `peril_decay`. Called only on inside points, so
 * the polygon-bounded perils (flood/wildfire/winter) return 1.0.
 */
function perilDecay(peril: string, distanceKm: number, widthKm: number): number {
  if (peril === 'flood' || peril === 'wildfire' || peril === 'winter') return 1.0;
  if (peril === 'tornado') {
    if (widthKm <= 0) return 1.0;
    return Math.exp(-distanceKm / (widthKm / 2.0));
  }
  if (peril === 'hail') {
    if (widthKm <= 0) return 1.0;
    if (distanceKm <= widthKm) return 1.0;
    return 0.6 * Math.exp(-(distanceKm - widthKm) / widthKm);
  }
  if (peril === 'earthquake') {
    return Math.max(0, 1.0 - distanceKm / Math.max(1.0, widthKm));
  }
  return 1.0;
}

// ── numpy.histogram / numpy.quantile replicas ───────────────────────────────

/**
 * Replicates `numpy.histogram(totals, bins=30)`:
 *   - 30 equal-width bins over [min, max];
 *   - the last bin is right-closed (values == max land in the final bin);
 *   - when max === min, numpy spans [min-0.5, max+0.5] with all counts in
 *     the bin containing the (single) value.
 * Returns { counts (ints, sums to N), edges (N_bins+1 floats) }.
 */
function numpyHistogram(totals: number[], bins: number): { counts: number[]; edges: number[] } {
  const n = totals.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of totals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (n === 0) {
    lo = 0;
    hi = 1;
  }
  // numpy's degenerate-range handling.
  if (lo === hi) {
    lo -= 0.5;
    hi += 0.5;
  }
  const edges: number[] = new Array(bins + 1);
  for (let i = 0; i <= bins; i++) {
    edges[i] = lo + ((hi - lo) * i) / bins;
  }
  edges[bins] = hi; // pin the upper edge to avoid fp drift past `hi`
  const counts: number[] = new Array(bins).fill(0);
  const span = hi - lo;
  for (const v of totals) {
    // numpy uses a normalized index: floor((v - lo) / span * bins), clamped.
    let idx = Math.floor(((v - lo) / span) * bins);
    if (idx === bins) idx = bins - 1; // values == hi go in the last bin
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    counts[idx] += 1;
  }
  return { counts, edges };
}

/**
 * Replicates `numpy.quantile(a, q)` with the default 'linear' interpolation.
 * `sorted` must already be ascending.
 */
function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Simulate the K-scenario total-loss distribution for a footprint over a
 * policy book. Pure function — beta/sigma/seed/K all arrive via `opts`.
 *
 * Algorithm per scenario k (mirrors `generate_sim_losses`):
 *   1. Perturb every footprint vertex by N(0, sigma_deg).
 *   2. Draw one common-factor residual ε ~ N(0, σ); factor = max(0, 1+β·ε).
 *   3. Point-in-polygon: which policies fall inside the perturbed polygon.
 *   4. Per-policy loss = tiv · damageRatio · decay · factor.
 *   5. Scenario total = Σ per-policy losses.
 * Then reduce the K totals via numpyHistogram + summary (port of `_summarize`).
 */
export function simulateLossDistribution(
  footprint: SimulationFootprint,
  policies: Policy[],
  opts: LossModelOptions,
): LossDistribution {
  const K = opts.K ?? 1000;
  const beta = opts.beta ?? DEFAULT_BETA;
  const sigma = opts.sigma ?? DEFAULT_SIGMA;

  const peril = footprint.peril;
  const severity = footprint.severity ?? footprint.intensity;
  const perturb = PERTURB[peril] ?? { vertex_deg: DEFAULT_VERTEX_DEG };
  const sigmaDeg = perturb.vertex_deg ?? DEFAULT_VERTEX_DEG;

  // Decay width (km) — only tornado / hail-with-core need a non-trivial decay.
  let widthKm = 0.0;
  let innerRadiusKm = 0.0;
  if (peril === 'tornado') {
    widthKm = (footprint.width_m ?? 200) / 1000.0;
  }
  if (peril === 'hail' && footprint.inner_geometry) {
    const innerRing = footprint.inner_geometry.coordinates?.[0] as Ring | undefined;
    if (innerRing && innerRing.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of innerRing) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      innerRadiusKm = Math.max(maxX - minX, maxY - minY) * 55.0;
    }
  }
  const decayWidth = widthKm || innerRadiusKm;
  const needsDecay = (peril === 'tornado' || peril === 'hail') && decayWidth > 0.0;

  // Pre-compute per-policy invariants (damage ratio is severity/build-only).
  const n = policies.length;
  const lons = new Float64Array(n);
  const lats = new Float64Array(n);
  const lossBase = new Float64Array(n); // tiv · damageRatio (factor & decay applied per-scenario)
  for (let i = 0; i < n; i++) {
    const p = policies[i];
    lons[i] = p.lon;
    lats[i] = p.lat;
    lossBase[i] = p.tiv * damageRatio(peril, p.build_type, severity);
  }

  const baseRing = footprint.geometry?.coordinates?.[0] as Ring | undefined;

  const rand = mulberry32(simSeed(opts.seed));
  const gaussian = makeGaussian(rand);

  const totals = new Array<number>(K).fill(0);

  if (n === 0 || !baseRing || baseRing.length < 4) {
    // Empty / degenerate: totals are all zero. We still must advance the RNG
    // in the same shape? No — _summarize over a zero matrix is what Python
    // returns when n_cohorts==0 (it short-circuits before the K loop), so the
    // all-zero totals here match the Python empty case.
    return summarize(totals, K);
  }

  for (let k = 0; k < K; k++) {
    // Step 1: perturb geometry.
    const poly = perturbRing(baseRing, sigmaDeg, gaussian);
    // Step 2: common-factor residual (one draw per scenario, all policies).
    const epsilon = gaussian() * sigma;
    const factor = Math.max(0.0, 1.0 + beta * epsilon);

    let total = 0;
    for (let i = 0; i < n; i++) {
      if (lossBase[i] === 0) continue; // unknown build_type / zero damage
      if (!pointInRing(lons[i], lats[i], poly)) continue;
      let decay = 1.0;
      if (needsDecay) {
        const distKm = distToRingDeg(lons[i], lats[i], poly) * 111.0;
        decay = perilDecay(peril, distKm, decayWidth);
      }
      total += lossBase[i] * decay * factor;
    }
    totals[k] = total;
  }

  return summarize(totals, K);
}

/**
 * Reduce the K scenario totals to a histogram + tail summary. Port of
 * `_summarize`: numpy.histogram(bins=30) + linear-interpolation quantiles +
 * TVaR-99 = mean of totals ≥ p99.
 */
function summarize(totals: number[], K: number): LossDistribution {
  const { counts, edges } = numpyHistogram(totals, 30);
  const sorted = [...totals].sort((a, b) => a - b);
  const n = sorted.length;

  if (n === 0) {
    return {
      histogram: { bin_edges: edges, counts },
      summary: { mean: 0, p50: 0, p90: 0, p99: 0, tvar99: 0, min: 0, max: 0 },
    };
  }

  let sum = 0;
  for (const v of totals) sum += v;
  const mean = sum / n;
  const p50 = quantileSorted(sorted, 0.5);
  const p90 = quantileSorted(sorted, 0.9);
  const p99 = quantileSorted(sorted, 0.99);

  // TVaR-99 = mean of the totals >= p99 (0 if none — matches np tail.mean()).
  let tailSum = 0;
  let tailN = 0;
  for (const v of totals) {
    if (v >= p99) {
      tailSum += v;
      tailN += 1;
    }
  }
  const tvar99 = tailN > 0 ? tailSum / tailN : 0;

  void K; // K is implied by totals.length; kept in the signature for parity.

  return {
    histogram: { bin_edges: edges, counts },
    summary: {
      mean,
      p50,
      p90,
      p99,
      tvar99,
      min: sorted[0],
      max: sorted[n - 1],
    },
  };
}
