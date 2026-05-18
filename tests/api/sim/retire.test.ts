// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST as RETIRE } from '@/app/api/sim/[id]/retire/route';
import { POST as CREATE } from '@/app/api/sim/route';
import { db } from '@/lib/db/client';

describe('POST /api/sim/[id]/retire', () => {
  test('flips retired=1 on a draft', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Retire test',
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
    const res = await RETIRE(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id: sim_id }) });
    expect(res.status).toBe(200);
    const r = await db.execute({ sql: 'SELECT retired FROM simulations WHERE id = ?', args: [sim_id] });
    expect(r.rows[0].retired).toBe(1);
  });
});
