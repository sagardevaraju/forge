// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { GET } from '@/app/api/policies/points/route';

describe('GET /api/policies/points', () => {
  test('returns policy points array with lat/lon/tiv', async () => {
    const res = await GET(new Request('http://localhost/api/policies/points'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.policies)).toBe(true);
    expect(body.policies.length).toBeGreaterThan(0);
    const first = body.policies[0];
    expect(typeof first.lat).toBe('number');
    expect(typeof first.lon).toBe('number');
    expect(typeof first.tiv).toBe('number');
  });
});
