/**
 * Task P3.6 — Decision rollback endpoint.
 *
 * POST {id: string} → stamp `reversed_at` + `reversed_by` on the matching
 * decision row.
 *
 * Surface contract:
 *   - 200 with {rolled_back, decision, manual_reversal_required,
 *     already_reversed} on success
 *   - 404 when the id doesn't match a row
 *   - 400 on malformed body or non-hex id
 *
 * Operator identity (Phase 3′, auth deferred):
 *   `X-Forge-Operator` header → falls back to `'demo_operator'`. Drop-in
 *   replaceable with the Clerk session id when P3.1 lands. Same scheme as
 *   the P3.4 ledger writer in `app/api/optimize/portfolio/route.ts`.
 *
 * `manual_reversal_required`:
 *   When the decision's `notices_sent_at` is non-null, the rollback row is
 *   still written — but the response carries the warning flag so the UI
 *   can prompt the operator to issue customer-side rescissions. The actual
 *   customer-list payload comes from the live policy book (out of scope
 *   here; the flag is the audit-side hook).
 */
import { operatorFromHeaders, reverseDecision } from '@/lib/audit/decisions';

export const runtime = 'nodejs';
export const maxDuration = 30;

const ID_RE = /^[0-9a-f]{64}$/;

function validate(body: unknown): { ok: true; id: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object with an `id` field' };
  }
  const b = body as Record<string, unknown>;
  const id = b.id;
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'id must be a non-empty string' };
  }
  if (!ID_RE.test(id)) {
    return {
      ok: false,
      error: 'id must be a 64-char hex string (the content-addressed decision id)',
    };
  }
  return { ok: true, id };
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const v = validate(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  const reversed_by = operatorFromHeaders(req.headers);
  const result = await reverseDecision({ id: v.id, reversed_by });

  if (result.decision === null) {
    return Response.json(
      { error: `decision ${v.id} not found` },
      { status: 404 },
    );
  }

  return Response.json({
    rolled_back: true,
    decision: result.decision,
    manual_reversal_required: result.manual_reversal_required,
    already_reversed: result.already_reversed,
  });
}
