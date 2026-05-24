/**
 * Task P3.10 — Real-time CV inference endpoint (de-Vercel'd).
 *
 * POST /api/cv/infer
 *
 * Spawns `python -m api_py._solve_stdin cv_inference` on every
 * request, pipes the JSON payload through stdin, parses the JSON
 * response on stdout. No Vercel-Python coupling: the route runs on
 * the regular Node runtime (`runtime = 'nodejs'`) and works on
 * `npm run dev`, in a Docker container, or any Node host with
 * Python 3.12 + numpy on PATH. CPU-only — the trained head is
 * bypassed by default (see ml/cv/inference.py docstring for why).
 *
 * Request body:
 *
 *   {
 *     "lat": number,                              // required, WGS-84
 *     "lon": number,                              // required, WGS-84
 *     "mode": "mock" | "cached" | "real",          // default "mock"
 *     "policy_id": number,                         // required when mode="cached"
 *     "bypass_head": boolean                       // default true
 *   }
 *
 * Response (200):
 *
 *   {
 *     "features": [number] * 8,
 *     "feature_names": [string] * 8,
 *     "mode_used": string,
 *     "bypass_head_used": boolean
 *   }
 *
 * Error response (400 / 500):
 *
 *   { "error": string }
 *
 * Mock fallback contract: when `FORGE_TOOLS_MODE=mock` is set on the
 * server environment, the route SHORTCUTS to a deterministic
 * mock-feature response WITHOUT spawning Python, so smoke-test
 * environments (CI, demo) can hit /api/cv/infer with no Python
 * runtime installed. The shortcut payload mirrors the shape of the
 * Python output for downstream client correctness.
 */

import { NextResponse } from 'next/server';
import { spawn } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InferRequest {
  lat?: number;
  lon?: number;
  mode?: 'mock' | 'cached' | 'real';
  policy_id?: number;
  bypass_head?: boolean;
}

interface InferResponse {
  features: number[];
  feature_names: string[];
  mode_used: string;
  bypass_head_used: boolean;
}

// Mirror of api_py.cv_inference._handle_cv_inference's feature-name
// vector so the mock-fallback shortcut produces a contract-equivalent
// response without spawning Python.
const FEATURE_NAMES = [
  'vegetation_density',
  'impervious_surface',
  'fuel_proximity',
  'roof_condition_proxy',
  'water_proximity',
  'elevation_bucket',
  'ndvi_seasonal_var',
  'structure_density',
];

/**
 * Deterministic 8-dim mock-feature response. Used by the mock-fallback
 * shortcut so smoke-test environments can exercise the route without
 * a Python runtime. Hashes (lat, lon) → uniform variation per call so
 * tests can distinguish two locations without depending on actual
 * Sentinel-2 chip content.
 */
function mockFeatures(lat: number, lon: number): InferResponse {
  // Deterministic hash on (lat, lon) so the same point produces the
  // same response (matches the Python mock path's contract).
  const seed = Math.abs(Math.floor(lat * 1000) ^ Math.floor(lon * 1000));
  const features = FEATURE_NAMES.map((_, i) => {
    const v = ((seed + i * 131) % 100) / 100;
    return Math.max(0, Math.min(1, v));
  });
  return {
    features,
    feature_names: FEATURE_NAMES,
    mode_used: 'mock',
    bypass_head_used: true,
  };
}

/**
 * Spawn the Python CV inference module and pipe the JSON payload
 * through stdin. Resolves with the parsed JSON response on stdout;
 * rejects with a structured Error containing the captured stderr.
 */
function runCvInference(payload: unknown): Promise<InferResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'api_py._solve_stdin', 'cv_inference'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`python exited ${code}: ${err || out || 'no output'}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as InferResponse | { error: string };
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
  let body: InferRequest;
  try {
    body = (await req.json()) as InferRequest;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.lat !== 'number' || typeof body.lon !== 'number') {
    return NextResponse.json(
      { error: 'lat and lon are required numeric fields' },
      { status: 400 },
    );
  }
  const mode = body.mode ?? 'mock';
  if (!['mock', 'cached', 'real'].includes(mode)) {
    return NextResponse.json(
      { error: `invalid mode '${mode}' — must be 'mock', 'cached', or 'real'` },
      { status: 400 },
    );
  }
  if (mode === 'cached' && typeof body.policy_id !== 'number') {
    return NextResponse.json(
      { error: 'mode=cached requires a numeric policy_id' },
      { status: 400 },
    );
  }

  // Mock-fallback shortcut for offline / no-Python environments.
  if (process.env.FORGE_TOOLS_MODE === 'mock') {
    return NextResponse.json(mockFeatures(body.lat, body.lon));
  }

  try {
    const out = await runCvInference({
      lat: body.lat,
      lon: body.lon,
      mode,
      policy_id: body.policy_id,
      bypass_head: body.bypass_head ?? true,
    });
    return NextResponse.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Last-resort fallback: if Python isn't available, return the mock
    // payload so the operator UI still gets a response shape it can
    // render. Operators see `mode_used = 'mock'` and can diagnose the
    // Python availability separately.
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      return NextResponse.json(mockFeatures(body.lat, body.lon));
    }
    return NextResponse.json({ error: `cv inference failed: ${msg}` }, { status: 500 });
  }
}
