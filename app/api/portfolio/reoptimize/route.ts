/**
 * POST /api/portfolio/reoptimize — Task 13
 *
 * Two-stage re-solve so the SimulationBanner can actually drop to 0
 * unresolved sims after a click:
 *
 *   1. Self-heal — query the DB for promoted+non-retired sims, regenerate
 *      any missing `artifacts/simulations/<id>.parquet` via the same
 *      `_solve_stdin sim_loss` subprocess that `/api/sim/[id]/promote` runs.
 *      Per CLAUDE.md the DB is the source of truth and the parquet is a
 *      derived K=1000 cohort-loss cache; this step closes the gap when the
 *      cache has been pruned (gitignored directory, fresh clone, manual
 *      cleanup) while sims remain marked promoted in the DB. Without it the
 *      banner shows N unresolved sims, the user clicks, precompute only sees
 *      the parquets that happen to exist, `included_sims` stays short, and
 *      the banner re-appears with the same N count — exactly the deadlock
 *      we just fixed.
 *
 *   2. Spawns `python -m scripts.precompute_portfolio_optimization
 *      --include-sims all` which re-solves the Portfolio MIP with the now-
 *      complete sim set folded into joint TVaR-99 capital, then writes:
 *        artifacts/portfolio_optimization.json
 *        artifacts/portfolio_optimization.meta.json
 *
 * Returns { solved_at, included_sims, regenerated, skipped } so the UI can
 * surface what was healed and what was given up on.
 */
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARTIFACTS_ROOT = join(process.cwd(), 'artifacts');
const META_PATH = join(ARTIFACTS_ROOT, 'portfolio_optimization.meta.json');
const SIMS_ROOT = join(ARTIFACTS_ROOT, 'simulations');

type PolicyTuple = [number, number, number, number, string, string];

function runSimLoss(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'api_py._solve_stdin', 'sim_loss'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `python exited ${code}`))));
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

async function syncSimulationArtifacts(): Promise<{ regenerated: string[]; skipped: string[] }> {
  // Source of truth: DB. The parquet is a derived cache — regenerate any
  // that's gone missing for a still-promoted sim.
  const promoted = (await db.execute(
    'SELECT id, footprint FROM simulations WHERE promoted = 1 AND retired = 0',
  )).rows;

  const missing: Array<{ id: string; footprint: unknown }> = [];
  for (const row of promoted) {
    const simId = String(row.id);
    const parquet = join(SIMS_ROOT, `${simId}.parquet`);
    try {
      await fs.access(parquet);
    } catch {
      missing.push({ id: simId, footprint: JSON.parse(String(row.footprint)) });
    }
  }
  if (missing.length === 0) return { regenerated: [], skipped: [] };

  // Load policies once for the batch — same query the promote route uses.
  const policies: PolicyTuple[] = (await db.execute(
    'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
  )).rows.map((p) => [
    Number(p.id), Number(p.lat), Number(p.lon), Number(p.tiv),
    String(p.build_type ?? 'wood_frame'), String(p.zip3),
  ]);

  const regenerated: string[] = [];
  const skipped: string[] = [];
  for (const { id, footprint } of missing) {
    try {
      await runSimLoss({ sim_id: id, footprint, policies, K: 1000 });
      regenerated.push(id);
    } catch (e) {
      // One bad sim (corrupt footprint, etc.) shouldn't kill the whole
      // re-optimize — log it and keep going. The precompute will simply
      // skip its parquet in the next stage.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[reoptimize] sim_loss regen failed for ${id}: ${msg}`);
      skipped.push(id);
    }
  }
  return { regenerated, skipped };
}

function runPrecompute(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'scripts.precompute_portfolio_optimization',
                                  '--include-sims', 'all']);
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
  });
}

export async function POST(_req: Request): Promise<Response> {
  let sync: { regenerated: string[]; skipped: string[] };
  try {
    sync = await syncSimulationArtifacts();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `sim artifact sync failed: ${msg}` }, { status: 500 });
  }
  try {
    await runPrecompute();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `reoptimize failed: ${msg}` }, { status: 500 });
  }
  const meta = JSON.parse(await fs.readFile(META_PATH, 'utf-8'));
  return NextResponse.json({
    solved_at: meta.solved_at,
    included_sims: meta.included_sims ?? [],
    regenerated: sync.regenerated,
    skipped: sync.skipped,
  });
}
