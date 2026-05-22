/**
 * Task 20 — Statutory non-renewal notice-period lookup for the Claims Pre-Brief.
 *
 * Each state regulates how many days of advance notice a homeowners carrier
 * must give before a non-renewal can take effect. The Claims table surfaces
 * this number per row so the ops user can sanity-check that any non-renewal
 * action the Portfolio MIP recommends is operationally feasible against the
 * statutory clock.
 *
 * Statute references are encoded as comments next to each entry. For ZIP3s
 * outside the seeded book we fall back to a conservative 60-day default so
 * the UI never renders an empty cell. ZIP3→state resolution uses
 * `lib/regulatory/zip3_geo.ts`, the canonical (DB-verified) ZIP3 reference.
 */
import { zip3State } from './zip3_geo';

const NOTICE_PERIOD_DAYS: Record<string, number> = {
  FL: 120, // per Fla. Stat. §627.4133 (homeowners cancellation / non-renewal notice)
  TX: 60,  // per Tex. Ins. Code §551.105
  LA: 30,  // per La. Rev. Stat. §22:1265
  NC: 45,  // per N.C. Gen. Stat. §58-41-15
};
const DEFAULT = 60;

export function noticeWindowDays(state: string): number {
  return NOTICE_PERIOD_DAYS[state.toUpperCase()] ?? DEFAULT;
}

export function noticeWindowForZip3(zip3: string): number {
  return noticeWindowDays(zip3State(zip3) ?? 'XX');
}
