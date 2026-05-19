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
});
