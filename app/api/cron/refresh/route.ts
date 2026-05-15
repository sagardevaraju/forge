/**
 * Task 23 — Scheduled refresh of upstream feeds.
 *
 * Vercel hits this route every 15 minutes (see `crons` in vercel.json). We
 * re-pull the three live external feeds — NHC cone, FIRMS active fires,
 * OpenFEMA disaster declarations — by invoking their existing tool handlers.
 * Each handler has its own mock fallback, so this route is safe to schedule
 * even when upstream APIs are flaky or no keys are configured.
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

  return Response.json({
    ok: true,
    summary: results.map((r) =>
      r.status === 'fulfilled'
        ? 'ok'
        : `error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
    ),
  });
}
