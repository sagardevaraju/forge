// tests/lib/grammar/freshness.test.ts
// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { formatRefreshAge, freshnessTier } from '@/lib/grammar/freshness';

describe('formatRefreshAge', () => {
  const NOW = new Date('2026-05-15T12:00:00Z');
  test('seconds ago', () => {
    expect(formatRefreshAge(new Date('2026-05-15T11:59:40Z'), NOW)).toBe('20s ago');
  });
  test('minutes ago', () => {
    expect(formatRefreshAge(new Date('2026-05-15T11:50:00Z'), NOW)).toBe('10m ago');
  });
  test('hours ago', () => {
    expect(formatRefreshAge(new Date('2026-05-15T09:00:00Z'), NOW)).toBe('3h ago');
  });
  test('days ago', () => {
    expect(formatRefreshAge(new Date('2026-05-13T12:00:00Z'), NOW)).toBe('2d ago');
  });
});

describe('freshnessTier', () => {
  test('LIVE when within SLA', () => {
    expect(freshnessTier(60, 300)).toBe('LIVE');
  });
  test('STALE when over SLA', () => {
    expect(freshnessTier(600, 300)).toBe('STALE');
  });
});
