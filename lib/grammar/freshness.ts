/**
 * Freshness grammar helpers — Task 4 (Redesign Phase 1).
 *
 * Pure TypeScript utilities that power the visual freshness grammar used by
 * ThreatBanner (Task 5) and other primitives that display data age + an
 * SLA-derived LIVE/STALE tier. No React, no DOM — safe for any runtime.
 *
 * - `formatRefreshAge` renders a timestamp delta as the largest unit that
 *   fits (`Ns | Nm | Nh | Nd ago`), floored, clamped at 0 for future dates.
 * - `freshnessTier` buckets an age in seconds against an SLA into
 *   `'LIVE' | 'STALE'`.
 */

/**
 * Format a refresh age as a short human-readable suffix.
 *
 * Picks the largest unit that fits (days > hours > minutes > seconds), floors
 * the value, and clamps negative deltas to 0 so `then > now` doesn't leak.
 *
 * @param then - Timestamp the data was last refreshed.
 * @param now  - Reference "current" time; defaults to `new Date()`.
 * @returns A string of the form `'Ns ago' | 'Nm ago' | 'Nh ago' | 'Nd ago'`.
 */
export function formatRefreshAge(then: Date, now: Date = new Date()): string {
  const deltaMs = now.getTime() - then.getTime();
  const seconds = Math.max(0, Math.floor(deltaMs / 1000));

  const MINUTE = 60;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  if (seconds >= DAY) {
    return `${Math.floor(seconds / DAY)}d ago`;
  }
  if (seconds >= HOUR) {
    return `${Math.floor(seconds / HOUR)}h ago`;
  }
  if (seconds >= MINUTE) {
    return `${Math.floor(seconds / MINUTE)}m ago`;
  }
  return `${seconds}s ago`;
}

/**
 * Classify a data age against its SLA.
 *
 * @param ageSeconds - How old the data is, in seconds.
 * @param slaSeconds - The freshness SLA, in seconds.
 * @returns `'LIVE'` when `ageSeconds <= slaSeconds`, otherwise `'STALE'`.
 */
export function freshnessTier(
  ageSeconds: number,
  slaSeconds: number,
): 'LIVE' | 'STALE' {
  return ageSeconds <= slaSeconds ? 'LIVE' : 'STALE';
}
