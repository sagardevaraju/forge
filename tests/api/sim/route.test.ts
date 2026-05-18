// @vitest-environment node
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { POST, GET } from '@/app/api/sim/route';
import { db } from '@/lib/db/client';

async function jsonRequest(body: unknown): Promise<Request> {
  return new Request('http://localhost/api/sim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sim', () => {
  test('persists a draft and returns sim_id + preview', async () => {
    const req = await jsonRequest({
      name: 'Test hail',
      footprint: {
        peril: 'hail',
        intensity: 'severe',
        geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
        effective_date: '2026-05-18',
        metadata: { drawn_by: 'tester', drawn_at: '2026-05-18T00:00:00Z' },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sim_id).toMatch(/^\d{13}_[0-9a-f]{8}$/);
    expect(body.impact).toBeDefined();
    expect(typeof body.impact.gross_loss_estimate).toBe('number');
    // Confirm row exists with promoted=0
    const r = await db.execute({ sql: 'SELECT promoted FROM simulations WHERE id = ?', args: [body.sim_id] });
    expect(r.rows[0].promoted).toBe(0);
  });

  test('rejects malformed footprint', async () => {
    const req = await jsonRequest({ name: 'bad', footprint: { peril: 'hail' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sim', () => {
  test('returns array of sims sorted by drawn_at DESC', async () => {
    const res = await GET(new Request('http://localhost/api/sim'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sims)).toBe(true);
  });
});
