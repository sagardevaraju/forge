/**
 * Task P3.28a — POST /api/book/check-pii.
 *
 * Synchronous name-only check via the lib/book/pii_classifier.ts
 * dictionary classifier, plus optional value-level scanning via
 * Microsoft Presidio when installed on the Python side.
 *
 * Request body:
 *
 *   {
 *     "name": string,                  // CSV column header
 *     "values": [string],              // optional sample values
 *     "mode": "name_only" | "auto"     // default "auto"
 *   }
 *
 *   - "name_only" — JS classifier only, no Python spawn
 *   - "auto" — JS classifier + spawn Python to attempt Presidio.
 *     When Presidio isn't installed the Python side falls back to a
 *     regex check; response `backend: "name_only"` signals that.
 *
 * Response shape:
 *
 *   {
 *     "name_is_pii": boolean,            // from the JS classifier
 *     "matched_token": string | null,    // which token tripped it
 *     "category": string | null,         // PII category
 *     "allowed_by": string | null,       // allow-list win (or null)
 *     "value_pii_detected": boolean,     // Presidio result (or false)
 *     "value_entities": [string],        // Presidio entity types
 *     "backend": "name_only" | "presidio",
 *     "sample_size": number
 *   }
 *
 * Performance: name-only mode is < 1ms (pure JS). Auto mode spawns
 * Python once per request — typical 200-300ms warm, ~ 2s cold start
 * when Presidio loads spaCy. Use name_only for high-throughput
 * column-mapping wizards; reserve auto for batch ingestion.
 */

import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { classifyPII } from '@/lib/book/pii_classifier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CheckPIIRequest {
  name?: string;
  values?: string[];
  mode?: 'name_only' | 'auto';
}

interface PythonResponse {
  name_is_pii: boolean;
  value_pii_detected: boolean;
  value_entities: string[];
  backend: 'name_only' | 'presidio';
  sample_size: number;
}

function runPii(payload: unknown): Promise<PythonResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'api_py._solve_stdin', 'pii_classify'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`python exited ${code}: ${err || out}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as PythonResponse | { error: string };
        if ('error' in parsed) {
          reject(new Error(parsed.error));
          return;
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`failed to parse python stdout: ${(e as Error).message}`));
      }
    });
    proc.on('error', (e) => reject(e));
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: CheckPIIRequest;
  try {
    body = (await req.json()) as CheckPIIRequest;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.name !== 'string') {
    return NextResponse.json(
      { error: 'name is a required string field' },
      { status: 400 },
    );
  }
  const mode = body.mode ?? 'auto';
  if (!['name_only', 'auto'].includes(mode)) {
    return NextResponse.json(
      { error: `invalid mode '${mode}'` },
      { status: 400 },
    );
  }

  // JS-side classification is always run — fast (< 1ms) and gives the
  // matched-token rationale.
  const js = classifyPII(body.name);

  // name_only mode (or FORGE_TOOLS_MODE=mock for offline / no-Python
  // CI) returns the JS result without spawning Python.
  if (mode === 'name_only' || process.env.FORGE_TOOLS_MODE === 'mock') {
    return NextResponse.json({
      name_is_pii: js.isPii,
      matched_token: js.matchedToken,
      category: js.category,
      allowed_by: js.allowedBy,
      value_pii_detected: false,
      value_entities: [] as string[],
      backend: 'name_only' as const,
      sample_size: 0,
    });
  }

  try {
    const py = await runPii({ name: body.name, values: body.values ?? [] });
    return NextResponse.json({
      // JS classification is the source of truth for the name decision
      // — its dictionary is broader than the Python-side regex.
      name_is_pii: js.isPii,
      matched_token: js.matchedToken,
      category: js.category,
      allowed_by: js.allowedBy,
      value_pii_detected: py.value_pii_detected,
      value_entities: py.value_entities,
      backend: py.backend,
      sample_size: py.sample_size,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Last-resort fallback: Python not on PATH — return the JS result
    // with backend marker so the operator UI can render.
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      return NextResponse.json({
        name_is_pii: js.isPii,
        matched_token: js.matchedToken,
        category: js.category,
        allowed_by: js.allowedBy,
        value_pii_detected: false,
        value_entities: [] as string[],
        backend: 'name_only' as const,
        sample_size: 0,
      });
    }
    return NextResponse.json({ error: `pii check failed: ${msg}` }, { status: 500 });
  }
}
