/**
 * Task P2.33 — Operator pin route.
 *
 * POST   /api/pins                — upsert {policy_id, action, operator, rationale}.
 * GET    /api/pins                — list every pin.
 * GET    /api/pins?cohort_id=X    — list pins whose policy belongs to cohort X.
 * DELETE /api/pins?policy_id=N    — remove the pin for policy N.
 *
 * Auth: intentionally absent in Phase 2. The operator field accepts any
 * non-empty string. Real auth + a two-person rule land in Phase 3 (P3.5).
 *
 * Validation:
 *   * action must be one of the six MIP actions (the reconciler-side labels
 *     ``non_renew_next_renewal`` / ``non_renew_capped`` are NOT pinnable).
 *   * operator must be non-empty.
 *   * rationale must be at least 10 characters — pins are operational decisions
 *     and the audit trail needs a real string, not "x".
 */
import { deletePin, listPins, setPin } from '@/lib/db/pins';
import { loadPolicyToCohortMap } from '@/lib/db/policy_cohort_map';
import type { ActionName } from '@/lib/portfolio-actions';

export const runtime = 'nodejs';

const ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>([
  'retain',
  'reprice_up',
  'reprice_down',
  'non_renew',
  'cede_qs',
  'cede_xs',
]);

interface PinInput {
  policy_id: number;
  action: ActionName;
  operator: string;
  rationale: string;
}

function validatePinInput(body: unknown): { ok: true; value: PinInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const policyId = b.policy_id;
  const action = b.action;
  const operator = b.operator;
  const rationale = b.rationale;

  if (typeof policyId !== 'number' || !Number.isFinite(policyId) || !Number.isInteger(policyId)) {
    return { ok: false, error: 'policy_id must be a finite integer' };
  }
  if (typeof action !== 'string' || !ACTIONS.has(action as ActionName)) {
    return {
      ok: false,
      error: `action must be one of ${Array.from(ACTIONS).join(', ')}`,
    };
  }
  if (typeof operator !== 'string' || operator.trim().length === 0) {
    return { ok: false, error: 'operator must be a non-empty string' };
  }
  if (typeof rationale !== 'string' || rationale.trim().length < 10) {
    return { ok: false, error: 'rationale must be at least 10 characters' };
  }

  return {
    ok: true,
    value: {
      policy_id: policyId,
      action: action as ActionName,
      operator,
      rationale,
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const v = validatePinInput(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  try {
    const pin = await setPin(v.value);
    return Response.json(pin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cohortFilter = url.searchParams.get('cohort_id');

  try {
    const pins = await listPins();
    if (!cohortFilter) {
      return Response.json({ pins });
    }
    // Resolve cohort membership and filter. The map is derived from the live
    // policy book (single source of truth — same rule as ``aggregateCohorts``).
    const policyToCohort = await loadPolicyToCohortMap();
    const scoped = pins.filter((p) => policyToCohort[p.policy_id] === cohortFilter);
    return Response.json({ pins: scoped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const policyIdRaw = url.searchParams.get('policy_id');
  if (!policyIdRaw) {
    return Response.json({ error: 'policy_id query param is required' }, { status: 400 });
  }
  const policyId = Number(policyIdRaw);
  if (!Number.isFinite(policyId) || !Number.isInteger(policyId)) {
    return Response.json({ error: 'policy_id must be a finite integer' }, { status: 400 });
  }
  try {
    await deletePin(policyId);
    return Response.json({ ok: true, policy_id: policyId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
