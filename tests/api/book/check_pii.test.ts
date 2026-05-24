// @vitest-environment node
/**
 * Task P3.28a — /api/book/check-pii route tests.
 *
 * mode='name_only' is fully unit-testable without spawning Python.
 * mode='auto' is exercised via FORGE_TOOLS_MODE=mock which forces the
 * JS-only path (same code path as name_only).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/book/check-pii/route';

const originalEnv = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

beforeEach(() => {
  // Force the JS-only path so we don't spawn Python in CI.
  process.env.FORGE_TOOLS_MODE = 'mock';
});

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/book/check-pii', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/book/check-pii (Task P3.28a)', () => {
  test('detects PII column name', async () => {
    const res = await POST(makeRequest({ name: 'cust_ssn_hash' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name_is_pii).toBe(true);
    expect(body.matched_token).toBe('ssn');
    expect(body.category).toBe('id');
    expect(body.backend).toBe('name_only');
  });

  test('allows business_name (P2.39 false-positive fix)', async () => {
    const res = await POST(makeRequest({ name: 'business_name' }));
    const body = await res.json();
    expect(body.name_is_pii).toBe(false);
    expect(body.allowed_by).toBe('business');
  });

  test('rejects missing name', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  test('rejects invalid mode', async () => {
    const res = await POST(makeRequest({ name: 'ssn', mode: 'banana' }));
    expect(res.status).toBe(400);
  });

  test('name_only mode skips value scanning', async () => {
    const res = await POST(makeRequest({
      name: 'random_col',
      values: ['john@example.com', '555-1234'],
      mode: 'name_only',
    }));
    const body = await res.json();
    expect(body.value_pii_detected).toBe(false);   // no Python invoked
    expect(body.sample_size).toBe(0);
  });

  test('returns structured rationale fields', async () => {
    const body = await (await POST(makeRequest({ name: 'cust_ssn_hash' }))).json();
    for (const k of [
      'name_is_pii', 'matched_token', 'category', 'allowed_by',
      'value_pii_detected', 'value_entities', 'backend', 'sample_size',
    ]) {
      expect(k in body).toBe(true);
    }
  });
});
