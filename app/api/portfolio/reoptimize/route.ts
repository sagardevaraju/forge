/**
 * POST /api/portfolio/reoptimize — Task 13
 *
 * Spawns `python -m scripts.precompute_portfolio_optimization --include-sims all`
 * which re-solves the Portfolio MIP with all promoted + non-retired sims folded
 * into the joint TVaR-99 capital constraint, then writes:
 *   artifacts/portfolio_optimization.json
 *   artifacts/portfolio_optimization.meta.json
 *
 * Returns { solved_at, included_sims } from the meta sidecar on success.
 */
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const META_PATH = join(process.cwd(), 'artifacts', 'portfolio_optimization.meta.json');

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
  });
}
