/**
 * POST /api/sim/[id]/promote — Task SIM.11
 *
 * Spawns a Python child process (`python -m api_py._solve_stdin sim_loss`)
 * that reads {sim_id, footprint, policies, K} from stdin, runs
 * generate_sim_losses + write_artifact, prints a JSON summary, and exits.
 * The route then flips promoted=1 in the DB and returns K + cohort count.
 */
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { db } from '@/lib/db/client';
import { isValidSimId } from '@/lib/sim/id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function runPython(payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'api_py._solve_stdin', 'sim_loss'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `python exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
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

  const policies = (await db.execute(
    'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
  )).rows.map((p) => [Number(p.id), Number(p.lat), Number(p.lon), Number(p.tiv),
                       String(p.build_type ?? 'wood_frame'), String(p.zip3)]);

  let pyResult: { K: number; n_cohorts: number; artifact_path: string };
  try {
    pyResult = (await runPython({ sim_id: id, footprint, policies, K: 1000 })) as typeof pyResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `loss compute failed: ${msg}` }, { status: 500 });
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: 'UPDATE simulations SET promoted = 1, promoted_at = ? WHERE id = ?',
    args: [now, id],
  });

  return NextResponse.json({
    sim_id: id,
    K: pyResult.K,
    n_cohorts: pyResult.n_cohorts,
    artifact_path: pyResult.artifact_path,
    compute_time_ms: 0,  // SIM.10: populate from real measurement in v1.1
  });
}
