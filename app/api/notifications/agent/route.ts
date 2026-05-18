/**
 * Task P2.34 — Agent-channel notification route.
 *
 * POST /api/notifications/agent — accepts an ``AgentNotification[]`` body.
 *
 * Phase 2 behavior: validate the body shape and ``console.log`` one
 * structured JSON line per notification. Return ``200 { logged: N }``.
 * Phase 3 will swap the ``console.log`` for a real channel (Slack / Teams
 * / email / etc.). A separate Phase 2 task (P2.36) adds a DB audit log on
 * top.
 *
 * Validation is hand-rolled (no Zod dependency in this repo): the body
 * must be a JSON array, and each element must carry the required
 * ``AgentNotification`` keys with the right primitive types and a
 * recognized ``action`` label.
 */
import type { AgentNotification, StampedAction } from '@/lib/reconciler';

export const runtime = 'nodejs';

const VALID_ACTIONS: ReadonlySet<AgentNotification['action']> = new Set<
  AgentNotification['action']
>(['non_renew', 'non_renew_next_renewal', 'non_renew_capped']);

function validateOne(
  raw: unknown,
  index: number,
): { ok: true; value: AgentNotification } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `entry ${index}: must be a JSON object` };
  }
  const r = raw as Record<string, unknown>;
  if (r.type !== 'non_renew_decision') {
    return {
      ok: false,
      error: `entry ${index}: type must be "non_renew_decision"`,
    };
  }
  if (typeof r.cohort_id !== 'string' || r.cohort_id.length === 0) {
    return { ok: false, error: `entry ${index}: cohort_id must be a non-empty string` };
  }
  if (typeof r.action !== 'string' || !VALID_ACTIONS.has(r.action as AgentNotification['action'])) {
    return {
      ok: false,
      error:
        `entry ${index}: action must be one of ` +
        Array.from(VALID_ACTIONS).join(', '),
    };
  }
  if (typeof r.policy_count !== 'number' || !Number.isFinite(r.policy_count)) {
    return { ok: false, error: `entry ${index}: policy_count must be a finite number` };
  }
  if (typeof r.total_tiv !== 'number' || !Number.isFinite(r.total_tiv)) {
    return { ok: false, error: `entry ${index}: total_tiv must be a finite number` };
  }
  if (typeof r.rationale !== 'string') {
    return { ok: false, error: `entry ${index}: rationale must be a string` };
  }
  if (typeof r.ts !== 'string') {
    return { ok: false, error: `entry ${index}: ts must be a string` };
  }
  if (!Array.isArray(r.stamps)) {
    return { ok: false, error: `entry ${index}: stamps must be an array` };
  }
  return {
    ok: true,
    value: {
      type: 'non_renew_decision',
      cohort_id: r.cohort_id,
      action: r.action as AgentNotification['action'],
      policy_count: r.policy_count,
      total_tiv: r.total_tiv,
      rationale: r.rationale,
      ts: r.ts,
      stamps: r.stamps as StampedAction[],
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

  if (!Array.isArray(body)) {
    return Response.json(
      { error: 'body must be a JSON array of AgentNotification entries' },
      { status: 400 },
    );
  }

  const validated: AgentNotification[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const v = validateOne(body[i], i);
    if (!v.ok) {
      return Response.json({ error: v.error }, { status: 400 });
    }
    validated.push(v.value);
  }

  // Phase 2: just log. Phase 3 will swap this for a real channel.
  for (const n of validated) {
    // One structured JSON line per notification — easy to grep / pipe into
    // a log shipper. We avoid ``console.info`` so the line stays on the
    // default stdout stream Vercel forwards to the dashboard.
    console.log(JSON.stringify(n));
  }

  return Response.json({ logged: validated.length });
}
