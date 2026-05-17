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
 * the UI never renders an empty cell. The ZIP3→state mapping covers all 38
 * ZIP3s in `lib/regulatory/zip3_to_county.ts`.
 */
const NOTICE_PERIOD_DAYS: Record<string, number> = {
  FL: 120, // per Fla. Stat. §627.7277 (homeowners non-renewal notice)
  TX: 60,  // per Tex. Ins. Code §551.105
  LA: 30,  // per La. Rev. Stat. §22:1265
  NC: 45,  // per N.C. Gen. Stat. §58-41-15
};
const DEFAULT = 60;

export function noticeWindowDays(state: string): number {
  return NOTICE_PERIOD_DAYS[state.toUpperCase()] ?? DEFAULT;
}

const ZIP3_TO_STATE: Record<string, string> = {
  '320':'FL','330':'FL','331':'FL','332':'FL','334':'FL','335':'FL','337':'FL','338':'FL','339':'FL','341':'FL','342':'FL','346':'FL','349':'FL',
  '770':'TX','774':'TX','775':'TX','776':'TX','777':'TX','778':'TX','783':'TX','784':'TX',
  '703':'LA','704':'LA','705':'LA','706':'LA','707':'LA','708':'LA','714':'LA',
  '275':'NC','280':'NC','281':'NC','282':'NC','283':'NC','284':'NC','285':'NC','286':'NC','287':'NC','289':'NC',
};

export function noticeWindowForZip3(zip3: string): number {
  return noticeWindowDays(ZIP3_TO_STATE[zip3] ?? 'XX');
}
