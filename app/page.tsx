/**
 * Task 8 (Redesign Phase 1) — Landing dashboard.
 *
 * Replaces the centered nav with a four-`ExecCard` executive snapshot of the
 * book. Nav now lives in `LayoutSubBanner` (Task 7), so the landing surface
 * is dedicated to headline scalars whose trust tiers advertise provenance:
 *   - Book TIV / Policies   → SYNTHETIC_SCAFFOLD (seeded synthetic book)
 *   - Cession spend YTD     → MODEL_OUTPUT       (treaty object lands Phase 2)
 *   - Open advisories       → LIVE_FEED          (NHC cron wires in Task 25)
 *
 * `force-dynamic` is preserved so Vercel does not ISR-cache stale book stats.
 */
import { ExecCard } from '@/components/grammar/ExecCard';
import { computeBookTotals } from '@/lib/db/book_totals';

export const dynamic = 'force-dynamic';

export default async function Landing() {
  const t = await computeBookTotals();
  return (
    <div className="p-6 grid grid-cols-2 md:grid-cols-4 gap-3">
      <ExecCard label="Book TIV" value={`$${(t.tiv / 1e9).toFixed(2)}B`} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard label="Policies" value={t.policies.toLocaleString()} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard label="Cession spend YTD" value={`$${(t.cessionSpendYtd / 1e6).toFixed(1)}M`} tier="MODEL_OUTPUT" />
      <ExecCard label="Open advisories" value={`${t.openAdvisories}`} tier="LIVE_FEED" />
    </div>
  );
}
