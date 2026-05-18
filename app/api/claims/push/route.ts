/**
 * Task P2.26 — Claims push-mock endpoint.
 *
 * POST /api/claims/push — accepts ``{ policy_ids: number[] }`` and logs
 * the push event as a single structured JSON line. The body is the list
 * of policies a cat-ops user has committed from the Claims pre-brief
 * (the moment downstream claims systems would be notified in a real
 * deployment).
 *
 * Phase 2 behavior: validate input shape, log to stdout, return
 * ``200 { received: N, ids_preview: number[] }``. The preview is the
 * first five IDs — small enough to keep log lines grep-friendly without
 * dumping ten-thousand IDs into the Vercel dashboard.
 *
 * Phase 3 will swap the ``console.log`` for a write to a ``decisions``
 * table; the response shape stays the same.
 */
export const runtime = 'nodejs';

const PREVIEW_LIMIT = 5;

function validate(
  raw: unknown,
): { ok: true; ids: number[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object with a policy_ids array' };
  }
  const r = raw as Record<string, unknown>;
  if (!('policy_ids' in r)) {
    return { ok: false, error: 'policy_ids is required' };
  }
  if (!Array.isArray(r.policy_ids)) {
    return { ok: false, error: 'policy_ids must be an array of integers' };
  }
  if (r.policy_ids.length === 0) {
    return { ok: false, error: 'policy_ids must be a non-empty array' };
  }
  const ids: number[] = [];
  for (let i = 0; i < r.policy_ids.length; i += 1) {
    const v = r.policy_ids[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      return {
        ok: false,
        error: `policy_ids[${i}] must be a non-negative integer`,
      };
    }
    ids.push(v);
  }
  return { ok: true, ids };
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const v = validate(body);
  if (!v.ok) {
    return Response.json({ error: v.error }, { status: 400 });
  }

  const preview = v.ids.slice(0, PREVIEW_LIMIT);
  // One structured JSON line — grep-friendly, easy to pipe into a log
  // shipper. The ``type: 'claims_push'`` tag mirrors the
  // notifications/agent route convention.
  console.log(
    JSON.stringify({
      type: 'claims_push',
      received: v.ids.length,
      ids_preview: preview,
      ts: new Date().toISOString(),
    }),
  );

  return Response.json({ received: v.ids.length, ids_preview: preview });
}
