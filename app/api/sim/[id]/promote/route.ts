/**
 * POST /api/sim/[id]/promote — Task SIM.11
 *
 * Computes the K=1000 Monte-Carlo loss distribution IN-PROCESS via the
 * TypeScript model (`lib/sim/loss-model.ts`, a verified port of
 * `api_py/sim_loss.py`), then flips promoted=1 in the DB and returns the
 * histogram + tail summary. No Python spawn / HTTP round-trip — Vercel can't
 * deploy a standalone Python function inside this Next.js app, so the live
 * promote path is pure in-process TS and behaves identically in dev and prod.
 * `api_py/sim_loss.py` stays the offline source of truth for the portfolio
 * precompute/reoptimize; parity is held by tests/lib/sim/loss-model.test.ts.
 */
import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db/client';
import { isValidSimId } from '@/lib/sim/id';
import { simulateLossDistribution } from '@/lib/sim/loss-model';
import { previewImpact, type Policy } from '@/lib/sim/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read the common-factor β/σ from the tracked + deployed calibration artifact.
 * Mirrors the Python `_load_correlation`. When the artifact is missing or
 * unfitted (no numeric beta/sigma), returns {} and the loss-model falls back
 * to its 0.5 / 0.3 defaults — matching the Python path.
 */
function loadBetaSigma(): { beta?: number; sigma?: number } {
  try {
    const p = join(process.cwd(), 'artifacts', 'calibration.json');
    const cf = JSON.parse(readFileSync(p, 'utf8'))?.common_factor ?? {};
    const beta = typeof cf.beta === 'number' ? cf.beta : undefined;
    const sigma = typeof cf.sigma === 'number' ? cf.sigma : undefined;
    return { beta, sigma };
  } catch {
    return {}; // loss-model defaults to 0.5 / 0.3
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isValidSimId(id)) {
    return NextResponse.json({ error: 'invalid sim_id' }, { status: 400 });
  }
  const r = await db.execute({ sql: 'SELECT * FROM simulations WHERE id = ?', args: [id] });
  if (r.rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = r.rows[0];
  if (Number(row.retired) === 1) {
    return NextResponse.json({ error: 'cannot promote a retired sim' }, { status: 409 });
  }
  const footprint = JSON.parse(String(row.footprint));

  try {
    const policies: Policy[] = (await db.execute(
      'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
    )).rows.map((p) => ({
      id: Number(p.id),
      lat: Number(p.lat),
      lon: Number(p.lon),
      tiv: Number(p.tiv),
      build_type: String(p.build_type ?? 'wood_frame'),
      zip3: String(p.zip3),
    }));

    const { beta, sigma } = loadBetaSigma();
    const dist = simulateLossDistribution(footprint, policies, { seed: id, K: 1000, beta, sigma });
    const preview = previewImpact(policies, footprint);

    const now = new Date().toISOString();
    await db.execute({
      sql: 'UPDATE simulations SET promoted = 1, promoted_at = ? WHERE id = ?',
      args: [now, id],
    });

    return NextResponse.json({
      sim_id: id,
      K: 1000,
      n_cohorts: preview.cohorts_affected,
      histogram: dist.histogram,
      summary: dist.summary,
      compute_time_ms: 0, // SIM.10: populate from real measurement in v1.1
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `loss compute failed: ${msg}` }, { status: 500 });
  }
}
