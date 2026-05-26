/**
 * Task P3.8 — /audit view.
 *
 * Server component that loads the live audit tables and hands them to the
 * `<AuditLedger />` client component. `force-dynamic` so the page always
 * reflects the latest writes (the ledger is append-only by P3.7 WORM, but
 * Next.js still has to know not to ISR-cache).
 *
 * Trust tier: every row on this page traces to a real INSERT in either
 * `decisions` (P3.4) or `chat_audit` (P2.36), so the page carries a
 * `LIVE_FEED` badge. There's no model output here — only the audit trail
 * of past model outputs, which is itself a true reading.
 */
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { InfoIcon, Term } from '@/components/grammar/InfoTooltip';
import { AuditLedger } from '@/components/AuditLedger';
import { listDecisions } from '@/lib/audit/decisions';
import { listAuditRows } from '@/lib/audit/log';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  // Pull the full ledger. Page size is enforced by the client component,
  // not the query — the corpus is small enough at demo scale that a single
  // round-trip is fine, and we want the client to be able to filter
  // without round-tripping for each filter change.
  const [decisions, chatRows] = await Promise.all([
    listDecisions().catch(() => []),
    listAuditRows().catch(() => []),
  ]);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            <Term term="audit-ledger">Audit</Term>
          </h1>
          <p className="text-sm text-neutral-600">
            Every solve on /portfolio writes a content-addressed row to{' '}
            <code>decisions</code> (P3.4); every chat turn on /events writes
            to <code>chat_audit</code> (P2.36). Both tables are append-only
            <InfoIcon term="append-only" iconSize="sm" /> via the WORM
            <InfoIcon term="worm" iconSize="sm" /> guard in{' '}
            <code>lib/db/client.ts</code> (P3.7). Rollback writes{' '}
            <code>reversed_at</code> in place; the original row is never
            overwritten.
          </p>
        </div>
        <TrustTierBadge tier="LIVE_FEED" />
      </header>

      <AuditLedger decisions={decisions} chatRows={chatRows} />
    </main>
  );
}
