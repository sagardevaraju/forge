// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST } from '@/app/api/sim/[id]/promote/route';
import { POST as CREATE } from '@/app/api/sim/route';
import { db } from '@/lib/db/client';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const ARTIFACTS_DIR = join(process.cwd(), 'artifacts', 'simulations');

describe('POST /api/sim/[id]/promote', () => {
  test('flips promoted=1 and writes parquet artifact', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Promote test',
        footprint: {
          peril: 'hail',
          intensity: 'severe',
          severity: 45,
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();

    const res = await POST(new Request(`http://localhost/api/sim/${sim_id}/promote`, { method: 'POST' }),
                          { params: Promise.resolve({ id: sim_id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.K).toBe(1000);
    expect(body.n_cohorts).toBeGreaterThanOrEqual(0);

    const r = await db.execute({ sql: 'SELECT promoted FROM simulations WHERE id = ?', args: [sim_id] });
    expect(r.rows[0].promoted).toBe(1);
    expect(existsSync(join(ARTIFACTS_DIR, `${sim_id}.parquet`))).toBe(true);

    // cleanup
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.parquet`));
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.meta.json`));
  }, 30_000);

  test('is idempotent: replaying promote does not error', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Idempotent test',
        footprint: {
          peril: 'flood',
          intensity: 'moderate',
          severity: 'moderate',
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();
    await POST(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id: sim_id }) });
    const res = await POST(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id: sim_id }) });
    expect(res.status).toBe(200);
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.parquet`));
    unlinkSync(join(ARTIFACTS_DIR, `${sim_id}.meta.json`));
  }, 30_000);

  test('prod path: fetches the Python function and returns the distribution', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Prod path test',
        footprint: {
          peril: 'hail', intensity: 'severe', severity: 45,
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();

    const origVercel = process.env.VERCEL;
    const origUrl = process.env.VERCEL_URL;
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    process.env.VERCEL = '1';
    process.env.VERCEL_URL = 'forge-test.vercel.app';
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        sim_id, K: 1000, n_cohorts: 3, artifact_path: null,
        histogram: { bin_edges: [0, 1, 2], counts: [2, 1] },
        summary: { mean: 1, p50: 1, p90: 1, p99: 2, tvar99: 3, min: 0, max: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const res = await POST(
        new Request(`http://localhost/api/sim/${sim_id}/promote`, { method: 'POST' }),
        { params: Promise.resolve({ id: sim_id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.tvar99).toBe(3);
      expect(body.histogram.counts).toEqual([2, 1]);
      expect(calls[0]).toContain('forge-test.vercel.app/api/sim_loss');
    } finally {
      globalThis.fetch = realFetch;
      if (origVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = origVercel;
      if (origUrl === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = origUrl;
    }
  }, 30_000);

  test('prod path: upstream function 5xx → route returns 502', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Prod 502 test',
        footprint: {
          peril: 'hail', intensity: 'severe', severity: 45,
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();

    const origVercel = process.env.VERCEL;
    const origUrl = process.env.VERCEL_URL;
    const realFetch = globalThis.fetch;
    process.env.VERCEL = '1';
    process.env.VERCEL_URL = 'forge-test.vercel.app';
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch;

    try {
      const res = await POST(
        new Request(`http://localhost/api/sim/${sim_id}/promote`, { method: 'POST' }),
        { params: Promise.resolve({ id: sim_id }) },
      );
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain('loss compute failed');
      expect(body.summary).toBeUndefined();   // no fabricated numbers
    } finally {
      globalThis.fetch = realFetch;
      if (origVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = origVercel;
      if (origUrl === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = origUrl;
    }
  }, 30_000);
});
