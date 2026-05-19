// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { POST } from '@/app/api/portfolio/reoptimize/route';

describe('POST /api/portfolio/reoptimize', () => {
  test('returns 200 + new solved_at timestamp', async () => {
    const res = await POST(new Request('http://localhost', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.solved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 90_000);
});
