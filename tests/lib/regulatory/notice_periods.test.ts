// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { noticeWindowDays } from '@/lib/regulatory/notice_periods';

describe('noticeWindowDays', () => {
  test.each([
    ['FL', 120], ['TX', 60], ['LA', 30], ['NC', 45],
  ])('%s → %i days', (state, days) => {
    expect(noticeWindowDays(state)).toBe(days);
  });
  test('unknown state defaults to 60', () => {
    expect(noticeWindowDays('XX')).toBe(60);
  });
});
