/**
 * Task 23 — Scheduled refresh of upstream feeds.
 * Task 25 — Advisory-delta tracking layered on top of Task 23.
 *
 * Vercel hits this route once a day (see `crons` in vercel.json — daily on
 * the Hobby tier, which caps cron frequency). We
 * re-pull the three live external feeds — NHC cone, FIRMS active fires,
 * OpenFEMA disaster declarations — by invoking their existing tool handlers.
 * Each handler has its own mock fallback, so this route is safe to schedule
 * even when upstream APIs are flaky or no keys are configured.
 *
 * Task 25: we keep the latest NHC advisory_number in module-level state and
 * surface a boolean `advisory_changed` flag so downstream consumers (the
 * advisory-delta UI surface) can react only when the cone actually bumps.
 * Module-level state is intentional — Vercel reuses warm instances within
 * a region, so the comparison spans calls on the same instance.
 *
 * Auth model: when CRON_SECRET is set in the environment we require a
 * `Bearer ${CRON_SECRET}` header (Vercel Cron sends this automatically).
 * When CRON_SECRET is unset the route is open — convenient for local dev
 * and CI; production deployments are expected to set the secret.
 */
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';
import { fetchFirmsFires } from '@/app/api/agent/tools/fetch_firms_fires';
import { fetchFemaDeclarations } from '@/app/api/agent/tools/fetch_fema_declarations';

export const runtime = 'nodejs';

// Task 25: persisted between invocations on the same warm Vercel instance.
let lastAdvisoryNumber: string | null = null;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const results = await Promise.allSettled([
    fetchNhcCone.handler({ storm_id: 'AL092024' }),
    fetchFirmsFires.handler({ bbox: [-88, 24, -76, 32], hours: 24 }),
    fetchFemaDeclarations.handler({ state: 'FL', since: '2024-01-01' }),
  ]);

  // Task 25: extract advisory_number from the NHC tool result and diff
  // against the previous call. Falls back to null when the NHC fetch
  // failed, the mock didn't include it, or the field is otherwise missing.
  const nhc = results[0];
  let advisoryNumber: string | null = null;
  if (nhc.status === 'fulfilled' && nhc.value && typeof nhc.value === 'object') {
    const candidate = (nhc.value as { advisory_number?: unknown }).advisory_number;
    if (typeof candidate === 'string' && candidate.length > 0) {
      advisoryNumber = candidate;
    }
  }
  const advisoryChanged = advisoryNumber !== null && advisoryNumber !== lastAdvisoryNumber;
  if (advisoryChanged) {
    lastAdvisoryNumber = advisoryNumber;
  }

  return Response.json({
    ok: true,
    summary: results.map((r) =>
      r.status === 'fulfilled'
        ? 'ok'
        : `error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
    ),
    advisory_changed: advisoryChanged,
    advisory_number: advisoryNumber,
  });
}
