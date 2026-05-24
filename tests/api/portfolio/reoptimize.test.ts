// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST } from '@/app/api/portfolio/reoptimize/route';

describe('POST /api/portfolio/reoptimize', () => {
  // Runtime scales linearly with the number of promoted, unretired
  // simulations in the local DB — each one folds K=1000 cohort losses
  // into the joint TVaR-99 capital constraint before the CBC solver
  // re-runs. 90 s was tight on a fresh DB; with ~120+ promoted sims
  // accumulated locally the precompute alone runs ~ 90-95 s, leaving
  // no headroom for the spawn round-trip. 180 s is ~2× the empirical
  // P95 on a fully-populated dev DB.
  test('returns 200 + new solved_at timestamp', async () => {
    const res = await POST(new Request('http://localhost', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.solved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 180_000);
});
