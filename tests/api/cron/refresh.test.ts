// @vitest-environment node
/**
 * Task 23 — Cron refresh route auth + fan-out.
 *
 * The route invokes the three external-feed tool handlers via Promise.allSettled,
 * so we stub them with vi.mock and assert on the response shape. Auth behavior
 * is exercised twice: once with CRON_SECRET unset (open access) and once with
 * it set (Bearer required).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/app/api/agent/tools/fetch_nhc_cone', () => ({
  fetchNhcCone: { handler: vi.fn().mockResolvedValue({ source: 'mock' }) },
}));
vi.mock('@/app/api/agent/tools/fetch_firms_fires', () => ({
  fetchFirmsFires: { handler: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/app/api/agent/tools/fetch_fema_declarations', () => ({
  fetchFemaDeclarations: { handler: vi.fn().mockResolvedValue([]) },
}));

import { GET } from '@/app/api/cron/refresh/route';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';
import { fetchFirmsFires } from '@/app/api/agent/tools/fetch_firms_fires';
import { fetchFemaDeclarations } from '@/app/api/agent/tools/fetch_fema_declarations';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
}

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/refresh', { method: 'GET', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  restoreEnv();
  delete process.env.CRON_SECRET;
});
afterEach(() => {
  restoreEnv();
});

describe('GET /api/cron/refresh', () => {
  test('200 OK when CRON_SECRET is unset (open access)', async () => {
    const r = await GET(req());
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; summary: string[] };
    expect(json.ok).toBe(true);
    expect(json.summary).toEqual(['ok', 'ok', 'ok']);
    expect(fetchNhcCone.handler).toHaveBeenCalledTimes(1);
    expect(fetchFirmsFires.handler).toHaveBeenCalledTimes(1);
    expect(fetchFemaDeclarations.handler).toHaveBeenCalledTimes(1);
  });

  test('401 when CRON_SECRET set and Authorization header missing', async () => {
    process.env.CRON_SECRET = 'topsecret';
    const r = await GET(req());
    expect(r.status).toBe(401);
    expect(fetchNhcCone.handler).not.toHaveBeenCalled();
  });

  test('401 when CRON_SECRET set and Bearer mismatches', async () => {
    process.env.CRON_SECRET = 'topsecret';
    const r = await GET(req({ authorization: 'Bearer wrong' }));
    expect(r.status).toBe(401);
  });

  test('200 OK when CRON_SECRET set and Bearer matches', async () => {
    process.env.CRON_SECRET = 'topsecret';
    const r = await GET(req({ authorization: 'Bearer topsecret' }));
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; summary: string[] };
    expect(json.ok).toBe(true);
    expect(json.summary).toEqual(['ok', 'ok', 'ok']);
  });

  test('summary records errors from individual handlers without failing the route', async () => {
    process.env.CRON_SECRET = 'topsecret';
    (fetchFirmsFires.handler as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('FIRMS upstream 503'),
    );
    const r = await GET(req({ authorization: 'Bearer topsecret' }));
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; summary: string[] };
    expect(json.ok).toBe(true);
    expect(json.summary[0]).toBe('ok');
    expect(json.summary[1]).toMatch(/FIRMS upstream 503/);
    expect(json.summary[2]).toBe('ok');
  });
});
