/**
 * Task P2.36 — Module-scoped audit-sink used by route.ts.
 *
 * Lives outside route.ts so Next.js's route-export validator only sees HTTP
 * method handlers in route.ts itself, and so tests can swap in an in-memory
 * mock without touching the real libSQL writer. Mirrors the
 * ``_llm-factory.ts`` injection pattern.
 *
 * The real sink writes through ``appendAuditRow`` in ``lib/audit/log.ts``.
 * Tests typically inject a ``vi.fn()`` so route tests stay fast and don't
 * touch the database.
 */
import { appendAuditRow, type AuditInput, type AuditRow } from '@/lib/audit/log';

export type AuditSink = (input: AuditInput) => Promise<AuditRow>;

export function defaultAuditSink(): AuditSink {
  return appendAuditRow;
}

let auditSink: AuditSink = defaultAuditSink();

export function getAuditSink(): AuditSink {
  return auditSink;
}

export function __setChatRouteAuditSink(sink: AuditSink) {
  auditSink = sink;
}

export function __resetChatRouteAuditSink() {
  auditSink = defaultAuditSink();
}
