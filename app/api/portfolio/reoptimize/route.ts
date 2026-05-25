/**
 * POST /api/portfolio/reoptimize — Task 13 (+ 2026-05-25: progress stream)
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
 *      cleanup) while sims remain marked promoted in the DB.
 *
 *   2. Spawns `python -m scripts.precompute_portfolio_optimization
 *      --include-sims all` which re-solves the Portfolio MIP with the now-
 *      complete sim set folded into joint TVaR-99 capital, then writes:
 *        artifacts/portfolio_optimization.json
 *        artifacts/portfolio_optimization.meta.json
 *
 * Response shape — content negotiated on `Accept`:
 *   - `Accept: application/x-ndjson` → NDJSON event stream (one event per
 *     line). Events: `{type:'phase',stage,idx?,total?,label?,sim_id?}`,
 *     `{type:'log',line}`, `{type:'done',solved_at,included_sims,
 *     regenerated,skipped}`, `{type:'error',message}`. The SimulationBanner
 *     consumes this so the operator gets per-sim progress + elapsed time on
 *     a job that can take ~10 minutes on a loaded dev DB.
 *   - Otherwise (default) → single-shot JSON
 *     `{solved_at,included_sims,regenerated,skipped}` — preserves the
 *     legacy contract pinned by tests/api/portfolio/reoptimize.test.ts.
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import {
  classifyPrecomputeLine,
  type ReoptimizeEvent,
} from '@/lib/reoptimize-stream';

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
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err || `python exited ${code}`)),
    );
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

interface MissingSim {
  id: string;
  footprint: unknown;
}

async function findMissingSims(): Promise<MissingSim[]> {
  const promoted = (
    await db.execute(
      'SELECT id, footprint FROM simulations WHERE promoted = 1 AND retired = 0',
    )
  ).rows;
  const missing: MissingSim[] = [];
  for (const row of promoted) {
    const simId = String(row.id);
    const parquet = join(SIMS_ROOT, `${simId}.parquet`);
    try {
      await fs.access(parquet);
    } catch {
      missing.push({ id: simId, footprint: JSON.parse(String(row.footprint)) });
    }
  }
  return missing;
}

async function loadPolicies(): Promise<PolicyTuple[]> {
  return (
    await db.execute(
      'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
    )
  ).rows.map((p) => [
    Number(p.id),
    Number(p.lat),
    Number(p.lon),
    Number(p.tiv),
    String(p.build_type ?? 'wood_frame'),
    String(p.zip3),
  ]);
}

/**
 * Run the precompute subprocess. Streams stdout lines to ``onLine`` as
 * they arrive (newline-delimited) so the caller can pattern-match into
 * progress phase events. Resolves on exit 0; rejects with stderr text
 * on non-zero exit.
 *
 * Uses ``PYTHONUNBUFFERED=1`` so the script's ``print()`` calls flush
 * immediately rather than buffering through to subprocess exit —
 * without this the stream would arrive in one giant burst at the end.
 */
function runPrecompute(onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python',
      ['-u', '-m', 'scripts.precompute_portfolio_optimization', '--include-sims', 'all'],
      { env: { ...process.env, PYTHONUNBUFFERED: '1' } },
    );
    let stdoutBuf = '';
    let stderrText = '';
    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        onLine(line);
        nl = stdoutBuf.indexOf('\n');
      }
    });
    proc.stderr.on('data', (d) => (stderrText += d.toString()));
    proc.on('close', (code) => {
      // Flush any tail without a terminating newline.
      if (stdoutBuf.length > 0) onLine(stdoutBuf);
      if (code === 0) resolve();
      else reject(new Error(stderrText || `precompute exited ${code}`));
    });
  });
}

/**
 * Sync stage executed inside the streaming context — emits per-sim
 * progress via ``emit`` and returns the regenerated / skipped lists
 * for the terminal ``done`` event.
 */
async function syncSimulationArtifactsStreaming(
  emit: (event: ReoptimizeEvent) => void,
): Promise<{ regenerated: string[]; skipped: string[] }> {
  const missing = await findMissingSims();
  emit({
    type: 'phase',
    stage: 'sync_start',
    total: missing.length,
    label:
      missing.length === 0
        ? 'All sim caches present — skipping sync'
        : `Regenerating ${missing.length} missing sim parquet${missing.length === 1 ? '' : 's'}`,
  });
  if (missing.length === 0) {
    emit({ type: 'phase', stage: 'sync_done' });
    return { regenerated: [], skipped: [] };
  }
  const policies = await loadPolicies();
  const regenerated: string[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < missing.length; i++) {
    const { id, footprint } = missing[i]!;
    try {
      await runSimLoss({ sim_id: id, footprint, policies, K: 1000 });
      regenerated.push(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[reoptimize] sim_loss regen failed for ${id}: ${msg}`);
      skipped.push(id);
    }
    emit({
      type: 'phase',
      stage: 'sync_tick',
      idx: i + 1,
      total: missing.length,
      sim_id: id,
    });
  }
  emit({ type: 'phase', stage: 'sync_done' });
  return { regenerated, skipped };
}

/**
 * Legacy single-shot sync path — same return shape as the streaming
 * version, no progress emit. Kept so callers without `Accept:
 * application/x-ndjson` still get a backward-compatible JSON response.
 */
async function syncSimulationArtifacts(): Promise<{
  regenerated: string[];
  skipped: string[];
}> {
  const missing = await findMissingSims();
  if (missing.length === 0) return { regenerated: [], skipped: [] };
  const policies = await loadPolicies();
  const regenerated: string[] = [];
  const skipped: string[] = [];
  for (const { id, footprint } of missing) {
    try {
      await runSimLoss({ sim_id: id, footprint, policies, K: 1000 });
      regenerated.push(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[reoptimize] sim_loss regen failed for ${id}: ${msg}`);
      skipped.push(id);
    }
  }
  return { regenerated, skipped };
}

function runPrecomputeQuiet(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', [
      '-m',
      'scripts.precompute_portfolio_optimization',
      '--include-sims',
      'all',
    ]);
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)),
    );
  });
}

async function readMeta(): Promise<{ solved_at: string; included_sims: string[] }> {
  const meta = JSON.parse(await fs.readFile(META_PATH, 'utf-8'));
  return {
    solved_at: meta.solved_at,
    included_sims: meta.included_sims ?? [],
  };
}

function wantsStream(req: Request): boolean {
  const accept = req.headers.get('accept') ?? '';
  return /application\/(x-)?ndjson/.test(accept);
}

export async function POST(req: Request): Promise<Response> {
  if (wantsStream(req)) {
    // ── Streaming branch (NDJSON) ────────────────────────────────────
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: ReoptimizeEvent) => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };
        try {
          const sync = await syncSimulationArtifactsStreaming(emit);
          emit({
            type: 'phase',
            stage: 'precompute_start',
            label: 'Running precompute_portfolio_optimization',
          });
          await runPrecompute((line) => {
            // Always stream the raw line for deep-debug spinners…
            emit({ type: 'log', line });
            // …and additionally emit a phase tick for the ones we
            // can map to a coarse human-readable label.
            const classified = classifyPrecomputeLine(line);
            if (classified) {
              emit({
                type: 'phase',
                stage: 'precompute_tick',
                label: classified.label,
              });
            }
          });
          const meta = await readMeta();
          emit({
            type: 'done',
            solved_at: meta.solved_at,
            included_sims: meta.included_sims,
            regenerated: sync.regenerated,
            skipped: sync.skipped,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          emit({ type: 'error', message });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        // Stream-friendly headers — same set the chat route uses.
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // ── Legacy single-shot JSON branch (test contract) ────────────────
  let sync: { regenerated: string[]; skipped: string[] };
  try {
    sync = await syncSimulationArtifacts();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `sim artifact sync failed: ${msg}` },
      { status: 500 },
    );
  }
  try {
    await runPrecomputeQuiet();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `reoptimize failed: ${msg}` }, { status: 500 });
  }
  const meta = await readMeta();
  return NextResponse.json({
    solved_at: meta.solved_at,
    included_sims: meta.included_sims,
    regenerated: sync.regenerated,
    skipped: sync.skipped,
  });
}
