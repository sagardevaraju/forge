/**
 * POST /api/book/upload — replace the policy book from an uploaded CSV.
 *
 * Streams CSV into memory, validates rows via lib/book/csv.ts, deletes the
 * current policies table, batch-inserts the new rows, and kicks off the
 * Python MIP precompute as a child process so the cached
 * artifacts/portfolio_optimization.json reflects the new book by the time
 * the user reaches /portfolio.
 *
 * Returns:
 *   {accepted, rejected, errors:[{row, message}], optimization:"refreshed"|"failed"|"skipped"}
 *
 * Demo guard: file capped at 25 MB and 200k rows. Production would stream
 * through a worker and a real durable store rather than wiping the table.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { db } from '@/lib/db/client';
import { parseCsv, validatePolicies, mockCvFeatures } from '@/lib/book/csv';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 200_000;
const INSERT_BATCH = 200;

async function runMipPrecompute(): Promise<'refreshed' | 'failed'> {
  return new Promise((resolve) => {
    const proc = spawn(
      'python3',
      ['-m', 'scripts.precompute_portfolio_optimization'],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve('refreshed');
      else {
        console.error('MIP precompute failed:', stderr.slice(0, 500));
        resolve('failed');
      }
    });
    proc.on('error', (e) => {
      console.error('MIP precompute spawn error:', e);
      resolve('failed');
    });
  });
}

export async function POST(req: Request) {
  let csvText: string;
  try {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return Response.json({ error: 'no file field' }, { status: 400 });
      }
      if (file.size > MAX_BYTES) {
        return Response.json(
          { error: `file too large (${file.size} > ${MAX_BYTES})` },
          { status: 413 },
        );
      }
      csvText = await file.text();
    } else {
      const raw = await req.text();
      if (raw.length > MAX_BYTES) {
        return Response.json(
          { error: 'payload too large' },
          { status: 413 },
        );
      }
      csvText = raw;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `read failed: ${msg}` }, { status: 400 });
  }

  // Strip a leading BOM if present.
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);

  const parsed = parseCsv(csvText);
  const { rows, errors } = validatePolicies(parsed);

  if (rows.length === 0) {
    return Response.json(
      {
        accepted: 0,
        rejected: errors.length,
        errors: errors.slice(0, 25),
        optimization: 'skipped' as const,
      },
      { status: 422 },
    );
  }
  if (rows.length > MAX_ROWS) {
    return Response.json(
      { error: `too many rows: ${rows.length} > ${MAX_ROWS}` },
      { status: 413 },
    );
  }

  try {
    await db.execute('DELETE FROM policies');
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const slice = rows.slice(i, i + INSERT_BATCH);
      const stmts = slice.map((p) => {
        const cv =
          p.cv_features ?? JSON.stringify(mockCvFeatures(p.lat, p.lon));
        return {
          sql:
            'INSERT INTO policies (id, state, zip3, county, lat, lon, tiv, build_year, ' +
            'build_type, flood_zone, elevation_m, premium_annual, cv_features) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [
            p.id,
            p.state,
            p.zip3,
            p.county,
            p.lat,
            p.lon,
            p.tiv,
            p.build_year,
            p.build_type,
            p.flood_zone,
            p.elevation_m,
            p.premium_annual,
            cv,
          ],
        };
      });
      await db.batch(stmts, 'write');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json(
      { error: `db write failed: ${msg}` },
      { status: 500 },
    );
  }

  const optimization = await runMipPrecompute();

  return Response.json({
    accepted: rows.length,
    rejected: errors.length,
    errors: errors.slice(0, 25),
    optimization,
    artifact: optimization === 'refreshed'
      ? path.join('artifacts', 'portfolio_optimization.json')
      : null,
  });
}
