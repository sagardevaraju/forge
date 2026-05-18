/**
 * POST /api/book/upload-wizard — wizard-import path for /load.
 *
 * Task P2.39 — accepts a JSON body of already-mapped rows + per-row lineage
 * produced by lib/book/csv.ts::applyMapping(). Each row is run through the
 * same validatePolicies() pipeline as the legacy multipart upload, then
 * inserted into the policies table with the lineage JSON stamped on it. The
 * MIP precompute is kicked off in the background so /portfolio reflects the
 * new book.
 *
 * Request body shape:
 *   {
 *     srcFile: string,
 *     rows: { forgeRow: Record<string,string>, lineage: string }[],
 *     refusedColumns: string[]  // surfaced for the response only
 *   }
 *
 * Response shape:
 *   { accepted, rejected, errors:[{row,message}],
 *     refused_columns:[...], optimization:"refreshed"|"failed"|"skipped" }
 *
 * Demo guard: 200k rows. PII column filtering already happened client-side
 * via applyMapping(); we re-check here so a hand-crafted POST can't sneak
 * a deny-listed column through.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { db } from '@/lib/db/client';
import {
  validatePolicies,
  mockCvFeatures,
  isPII,
  type MappedRow,
} from '@/lib/book/csv';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_ROWS = 200_000;
const INSERT_BATCH = 200;
// Match the legacy /api/book/upload route — a hand-crafted POST with a
// massive lineage blob or a 250k-row payload would otherwise blow the
// function's memory before validation could reject it.
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_LINEAGE_LEN = 8192;

async function runMipPrecompute(): Promise<'refreshed' | 'failed'> {
  return new Promise((resolve) => {
    const proc = spawn(
      'python3',
      ['-m', 'scripts.precompute_portfolio_optimization'],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
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

interface WizardPayload {
  srcFile?: string;
  rows?: MappedRow[];
  refusedColumns?: string[];
}

export async function POST(req: Request) {
  // Enforce body-size cap before parsing JSON — protects against memory
  // spikes from oversized payloads (matches MAX_BYTES on the legacy route).
  const declaredLen = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
    return Response.json(
      { error: `payload too large (${declaredLen} > ${MAX_BYTES})` },
      { status: 413 },
    );
  }

  let body: WizardPayload;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BYTES) {
      return Response.json(
        { error: `payload too large (${raw.length} > ${MAX_BYTES})` },
        { status: 413 },
      );
    }
    body = JSON.parse(raw) as WizardPayload;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `bad json: ${msg}` }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return Response.json(
      {
        accepted: 0,
        rejected: 0,
        errors: [{ row: 0, message: 'no rows provided' }],
        refused_columns: body.refusedColumns ?? [],
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

  // Synthesize a CSV-style table for validatePolicies. The mapped rows are
  // already keyed by FORGE field id; we just rebuild a header + body view
  // so the existing validator does the heavy typing.
  const allKeys = new Set<string>();
  for (const r of rows) {
    if (!r.forgeRow) continue;
    for (const k of Object.keys(r.forgeRow)) {
      if (isPII(k)) continue; // defense in depth
      allKeys.add(k);
    }
  }
  const header = [...allKeys];
  const table: string[][] = [header];
  for (const r of rows) {
    const cells = header.map((k) => (r.forgeRow?.[k] ?? '').toString());
    table.push(cells);
  }

  const { rows: parsed, errors } = validatePolicies(table);
  if (parsed.length === 0) {
    return Response.json(
      {
        accepted: 0,
        rejected: errors.length,
        errors: errors.slice(0, 25),
        refused_columns: body.refusedColumns ?? [],
        optimization: 'skipped' as const,
      },
      { status: 422 },
    );
  }

  try {
    await db.execute('DELETE FROM policies');
    for (let i = 0; i < parsed.length; i += INSERT_BATCH) {
      const slice = parsed.slice(i, i + INSERT_BATCH);
      const stmts = slice.map((p) => {
        const cv =
          p.cv_features ?? JSON.stringify(mockCvFeatures(p.lat, p.lon));
        // p.srcDataIndex maps back to rows[] BEFORE validation dropped any
        // invalid rows — this is what keeps lineage pointing to the actual
        // source row even when intermediate rows fail. Without this we'd
        // misattribute lineage on every drop. Lineage is also type+length
        // validated so a hand-crafted POST can't slip a huge or non-string
        // blob into the DB.
        const rawLineage = rows[p.srcDataIndex]?.lineage;
        const lineage =
          typeof rawLineage === 'string' && rawLineage.length < MAX_LINEAGE_LEN
            ? rawLineage
            : null;
        return {
          sql:
            'INSERT INTO policies (id, state, zip3, county, lat, lon, tiv, build_year, ' +
            'build_type, flood_zone, elevation_m, premium_annual, cv_features, synthetic, lineage) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
            0, // CSV-uploaded rows are real, not synthetic
            lineage,
          ],
        };
      });
      await db.batch(stmts, 'write');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `db write failed: ${msg}` }, { status: 500 });
  }

  const optimization = await runMipPrecompute();

  return Response.json({
    accepted: parsed.length,
    rejected: errors.length,
    errors: errors.slice(0, 25),
    refused_columns: body.refusedColumns ?? [],
    optimization,
    artifact:
      optimization === 'refreshed'
        ? path.join('artifacts', 'portfolio_optimization.json')
        : null,
  });
}
