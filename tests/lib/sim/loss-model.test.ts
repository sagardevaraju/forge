// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { simulateLossDistribution } from '@/lib/sim/loss-model';
import { previewImpact, type Policy } from '@/lib/sim/preview';
import type { SimulationFootprint } from '@/lib/sim/footprint';

// A fixed hail footprint over Tampa, severity 45 mm (= HAZUS-severe anchor).
const TAMPA_HAIL: SimulationFootprint = {
  peril: 'hail',
  severity: 45,
  intensity: 'severe',
  geometry: {
    type: 'Polygon',
    coordinates: [[[-82.6, 27.4], [-81.9, 27.4], [-81.9, 28.1], [-82.6, 28.1], [-82.6, 27.4]]],
  },
  effective_date: '2026-06-05',
  metadata: { drawn_by: 't', drawn_at: '2026-06-05T00:00:00Z' },
};

// A footprint over open ocean (Gulf of Mexico) where no policies sit.
const OPEN_OCEAN: SimulationFootprint = {
  peril: 'hail',
  severity: 45,
  intensity: 'severe',
  geometry: {
    type: 'Polygon',
    coordinates: [[[-90.0, 25.0], [-89.5, 25.0], [-89.5, 25.5], [-90.0, 25.5], [-90.0, 25.0]]],
  },
  effective_date: '2026-06-05',
  metadata: { drawn_by: 't', drawn_at: '2026-06-05T00:00:00Z' },
};

/**
 * The SAME 200 synthetic policies the Python parity command uses:
 *   [id, lat, lon, tiv=500000, build_type=wood_frame, zip3=335]
 *   lat = 27.5 + 0.05*((i*7)%10), lon = -82.5 + 0.05*((i*3)%10)
 * All sit well inside the Tampa hail polygon.
 */
const PARITY_POLICIES: Policy[] = Array.from({ length: 200 }, (_, i) => ({
  id: i,
  lat: 27.5 + 0.05 * ((i * 7) % 10),
  lon: -82.5 + 0.05 * ((i * 3) % 10),
  tiv: 500_000,
  build_type: 'wood_frame',
  zip3: '335',
}));

describe('simulateLossDistribution', () => {
  test('1. deterministic — same seed yields identical histogram + summary', () => {
    const a = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, { seed: 'fixed_seed_xyz' });
    const b = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, { seed: 'fixed_seed_xyz' });
    expect(a).toEqual(b);
  });

  test('2. different seeds produce different means', () => {
    const a = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, { seed: 'seed_A' });
    const b = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, { seed: 'seed_B' });
    expect(a.summary.mean).not.toBe(b.summary.mean);
  });

  test('3. mean is anchored to the preview gross-loss estimate (within 12%)', () => {
    const preview = previewImpact(PARITY_POLICIES, TAMPA_HAIL);
    const dist = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, { seed: 'anchor_seed' });
    const rel = Math.abs(dist.summary.mean - preview.gross_loss_estimate) / preview.gross_loss_estimate;
    expect(preview.gross_loss_estimate).toBeGreaterThan(0);
    expect(rel).toBeLessThan(0.12);
  });

  test('4. tail ordering: tvar99 >= p99 >= p90 >= p50, max >= tvar99, min >= 0', () => {
    const { summary } = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, { seed: 'tail_seed' });
    expect(summary.tvar99).toBeGreaterThanOrEqual(summary.p99);
    expect(summary.p99).toBeGreaterThanOrEqual(summary.p90);
    expect(summary.p90).toBeGreaterThanOrEqual(summary.p50);
    expect(summary.max).toBeGreaterThanOrEqual(summary.tvar99);
    expect(summary.min).toBeGreaterThanOrEqual(0);
  });

  test('5. histogram shape: 30 counts, 31 edges, counts sum to K', () => {
    const K = 1000;
    const { histogram } = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, { seed: 'hist_seed', K });
    expect(histogram.counts.length).toBe(30);
    expect(histogram.bin_edges.length).toBe(31);
    expect(histogram.counts.reduce((s, c) => s + c, 0)).toBe(K);
    // edges strictly ascending
    for (let i = 1; i < histogram.bin_edges.length; i++) {
      expect(histogram.bin_edges[i]).toBeGreaterThan(histogram.bin_edges[i - 1]);
    }
  });

  test('6. empty footprint (open ocean) — all-zero summary, counts still sum to K', () => {
    const K = 1000;
    const { histogram, summary } = simulateLossDistribution(OPEN_OCEAN, PARITY_POLICIES, { seed: 'ocean_seed', K });
    expect(summary.mean).toBe(0);
    expect(summary.p50).toBe(0);
    expect(summary.p99).toBe(0);
    expect(summary.tvar99).toBe(0);
    expect(summary.min).toBe(0);
    expect(summary.max).toBe(0);
    expect(histogram.counts.reduce((s, c) => s + c, 0)).toBe(K);
  });

  test('6b. no policies at all — all-zero summary, counts sum to K', () => {
    const K = 1000;
    const { histogram, summary } = simulateLossDistribution(TAMPA_HAIL, [], { seed: 's', K });
    expect(summary.mean).toBe(0);
    expect(summary.max).toBe(0);
    expect(histogram.counts.reduce((s, c) => s + c, 0)).toBe(K);
  });

  test('7. Python parity (golden) — TS within 15% mean / 25% tvar99 of Python ref', () => {
    // Python-reference values captured by running the REAL model:
    //   python3 -c "... run_request({'sim_id':'parity_seed_001', footprint=Tampa hail 45,
    //                policies=200×[id, 27.5+0.05*((i*7)%10), -82.5+0.05*((i*3)%10),
    //                500000, wood_frame, 335], K=1000})['summary']"
    // (FORGE_SIM_PERSIST=0, beta=0.5, sigma=0.3 — the in-repo defaults.)
    const PY_MEAN = 17_962_451.17229633; // Python reference (numpy PCG64 stream)
    const PY_TVAR99 = 24_729_976.442963235; // Python reference

    const { summary } = simulateLossDistribution(TAMPA_HAIL, PARITY_POLICIES, {
      seed: 'parity_seed_001',
      beta: 0.5,
      sigma: 0.3,
      K: 1000,
    });

    const meanRel = Math.abs(summary.mean - PY_MEAN) / PY_MEAN;
    const tvarRel = Math.abs(summary.tvar99 - PY_TVAR99) / PY_TVAR99;
    expect(meanRel).toBeLessThan(0.15);
    expect(tvarRel).toBeLessThan(0.25);
  });
});
