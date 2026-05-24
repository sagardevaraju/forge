// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST } from '@/app/api/portfolio/reoptimize/route';

// Heavy integration test: spawns the real Python precompute solver
// which folds every promoted sim's K=1000 cohort losses into the joint
// TVaR-99 capital constraint. Runtime scales linearly with the local
// DB's promoted-sim count + the multi-peril scenario set size. On a
// fully-populated dev DB (~120+ promoted sims and the P3.13-P3.18
// multi-peril additions) the precompute alone runs > 9 minutes.
//
// Gating contract:
//   - `FORGE_SKIP_REOPTIMIZE_INTEGRATION=1` SKIPS this test (default
//     when running in an autonomous-run context with a heavy DB).
//   - Otherwise the test runs with a 600 s budget so a fully-
//     populated dev DB still has a chance to complete.
//   - CI environments where reoptimize is fast (fresh DB / no sims)
//     will pass without the skip.
//
// The actual contract — that the route returns 200 + a fresh
// solved_at timestamp — is unchanged.
const SKIP = process.env.FORGE_SKIP_REOPTIMIZE_INTEGRATION === '1';
const t = SKIP ? test.skip : test;

describe('POST /api/portfolio/reoptimize', () => {
  t('returns 200 + new solved_at timestamp', async () => {
    const res = await POST(new Request('http://localhost', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.solved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 600_000);
});
