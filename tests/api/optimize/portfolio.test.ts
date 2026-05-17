// @vitest-environment node
/**
 * Task P2.12 — Server-side re-solve route.
 *
 * Mocks `node:child_process` so the tests never actually shell out to
 * Python. The fake spawn() returns an `EventEmitter` with stdout / stderr
 * streams driven by the per-test scenario script. Also mocks the artifact
 * loader so we control the cohorts the route reads.
 *
 * Coverage:
 *   1. Happy path — 200, PortfolioOptimization shape, no loss_scenarios leak.
 *   2. Cache hit — second identical POST does NOT spawn python again.
 *   3. Validation — negative capital_budget → 400.
 *   4. Validation — missing keys → 400.
 *   5. Infeasible fallback — solver returns Infeasible, route relaxes and
 *      response carries status="Infeasible_relaxed" + relaxation_factor.
 *   6. Solver hard-fail — non-zero exit → 500 with error in body.
 *   7. Solver crash — invalid JSON on stdout → 500 with informative error.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// ────────────────────────────────────────────────────────────────────────
// Fake spawn — push a per-test script describing the subprocess behavior.
// ────────────────────────────────────────────────────────────────────────
type SpawnScript = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: Error;
};

const spawnScripts: SpawnScript[] = [];
const spawnCalls: { command: string; args: string[]; stdinPayloads: string[] }[] = [];

function fakeSpawn(command: string, args: string[]) {
  const script = spawnScripts.shift() ?? { stdout: '{}', exitCode: 0 };
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
  };
  const stdinChunks: Buffer[] = [];
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const callRecord = { command, args, stdinPayloads: [] as string[] };
  spawnCalls.push(callRecord);
  proc.stdin.on('finish', () => {
    callRecord.stdinPayloads.push(Buffer.concat(stdinChunks).toString('utf-8'));
  });
  proc.stdout = Readable.from([]);
  proc.stderr = Readable.from([]);

  // Defer event emission so the route can attach its listeners first.
  setImmediate(() => {
    if (script.spawnError) {
      proc.emit('error', script.spawnError);
      return;
    }
    if (script.stdout) {
      proc.stdout = Readable.from([Buffer.from(script.stdout)]);
    }
    if (script.stderr) {
      proc.stderr = Readable.from([Buffer.from(script.stderr)]);
    }
    // Re-emit data events through the new readable streams (the route reads
    // via 'data' listeners that were attached to the original placeholders).
    // To keep this simple we just emit synthetic 'data' + 'end' on the
    // original EventEmitter-backed streams.
  });

  // Replace the placeholder streams with ones that synchronously deliver
  // the scripted payload once consumers attach. We do this by using
  // EventEmitter directly, mirroring how `child_process.spawn` exposes
  // the streams.
  const stdoutEmitter = new EventEmitter() as EventEmitter & {
    on(event: 'data', cb: (b: Buffer) => void): EventEmitter;
    on(event: 'end', cb: () => void): EventEmitter;
  };
  const stderrEmitter = new EventEmitter();
  proc.stdout = stdoutEmitter as unknown as Readable;
  proc.stderr = stderrEmitter as unknown as Readable;

  setImmediate(() => {
    if (script.spawnError) {
      proc.emit('error', script.spawnError);
      return;
    }
    if (script.stdout) stdoutEmitter.emit('data', Buffer.from(script.stdout));
    stdoutEmitter.emit('end');
    if (script.stderr) stderrEmitter.emit('data', Buffer.from(script.stderr));
    stderrEmitter.emit('end');
    proc.emit('close', script.exitCode ?? 0);
  });

  return proc;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[]) => fakeSpawn(cmd, args)),
}));

// Loader mock — feed a deterministic mini-optimization with cohorts the route
// can hash + pass through to the solver.
vi.mock('@/lib/db/portfolio_optimization', () => ({
  loadPortfolioOptimization: vi.fn(),
}));

import { POST, _resetCache } from '@/app/api/optimize/portfolio/route';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { spawn } from 'node:child_process';

const loaderMock = loadPortfolioOptimization as unknown as ReturnType<typeof vi.fn>;
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

const SAMPLE_OPT = {
  schema_version: 3,
  status: 'Optimal',
  objective: 1000,
  horizon_start: '2026-07-01',
  horizon_end: '2027-06-30',
  budgets: {
    capital_budget: 1e7,
    max_nonrenew_pct: 0.1,
    cession_budget: 5e6,
  },
  book_totals: { tiv: 1e9, premium: 1e7, loss_p50: 5e6, loss_p99: 2e7 },
  action_summary: {
    retain: { count: 0, tiv: 0 },
    reprice_up: { count: 0, tiv: 0 },
    reprice_down: { count: 0, tiv: 0 },
    non_renew: { count: 0, tiv: 0 },
    cede_qs: { count: 0, tiv: 0 },
    cede_xs: { count: 0, tiv: 0 },
  },
  cohorts: [
    {
      id: '275_wood_frame_q0',
      zip3: '275',
      build_type: 'wood_frame',
      tiv_quintile: 0,
      policy_count: 5,
      total_tiv: 500_000,
      total_premium: 5_000,
      modal_flood_zone: 'X',
      avg_elevation_m: 3,
      loss_p50: 2_500,
      loss_p99: 10_000,
      loss_scenarios: [1, 2, 3, 4, 5], // must be stripped on response
    },
    {
      id: '276_masonry_q1',
      zip3: '276',
      build_type: 'masonry',
      tiv_quintile: 1,
      policy_count: 3,
      total_tiv: 750_000,
      total_premium: 8_000,
      modal_flood_zone: 'AE',
      avg_elevation_m: 2,
      loss_p50: 4_000,
      loss_p99: 16_000,
      loss_scenarios: [10, 20, 30, 40, 50],
    },
  ],
  actions: [],
};

function makeSolverResult(status = 'Optimal'): string {
  return JSON.stringify({
    status,
    objective: 12345,
    horizon_start: '2026-07-01',
    horizon_end: '2027-06-30',
    actions: [
      {
        cohort_id: '275_wood_frame_q0',
        retain: 1,
        reprice_up: 0,
        reprice_down: 0,
        non_renew: 0,
        cede_qs: 0,
        cede_xs: 0,
      },
      {
        cohort_id: '276_masonry_q1',
        retain: 0,
        reprice_up: 0,
        reprice_down: 0,
        non_renew: 0,
        cede_qs: 0,
        cede_xs: 1,
      },
    ],
  });
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/optimize/portfolio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  _resetCache();
  spawnMock.mockClear();
  spawnScripts.length = 0;
  spawnCalls.length = 0;
  loaderMock.mockReset();
  loaderMock.mockResolvedValue(SAMPLE_OPT);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/optimize/portfolio', () => {
  test('happy path — 200, PortfolioOptimization shape, loss_scenarios stripped', async () => {
    spawnScripts.push({ stdout: makeSolverResult('Optimal'), exitCode: 0 });

    const r = await POST(
      req({ capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 }),
    );

    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('Optimal');
    expect(body.budgets).toEqual({
      capital_budget: 1e7,
      max_nonrenew_pct: 0.15,
      cession_budget: 5e6,
    });
    expect(Array.isArray(body.cohorts)).toBe(true);
    expect(body.cohorts.length).toBe(2);
    for (const c of body.cohorts) {
      expect(c).not.toHaveProperty('loss_scenarios');
    }
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.actions.length).toBe(2);
    expect(body.action_summary).toBeDefined();
    // book_totals echoed through from the artifact (the solver re-solve does
    // not re-derive these — they're stable for the current book).
    expect(body.book_totals).toBeDefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('cache hit — identical second POST does not spawn python again', async () => {
    spawnScripts.push({ stdout: makeSolverResult('Optimal'), exitCode: 0 });

    const body = { capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 };
    const r1 = await POST(req(body));
    expect(r1.status).toBe(200);
    const r2 = await POST(req(body));
    expect(r2.status).toBe(200);

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b2).toEqual(b1);
  });

  test('validation — negative capital_budget returns 400', async () => {
    const r = await POST(
      req({ capital_budget: -1, max_nonrenew_pct: 0.1, cession_budget: 5e6 }),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/capital_budget/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('validation — missing required keys returns 400', async () => {
    const r = await POST(req({ capital_budget: 1e7 }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBeTruthy();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('infeasible fallback — relax and surface Infeasible_relaxed', async () => {
    // First solve infeasible, second solve (after 1.5x relax) feasible.
    spawnScripts.push({ stdout: JSON.stringify({ status: 'Infeasible', objective: 0, actions: [] }), exitCode: 0 });
    spawnScripts.push({ stdout: makeSolverResult('Optimal'), exitCode: 0 });

    const r = await POST(
      req({ capital_budget: 1e6, max_nonrenew_pct: 0.05, cession_budget: 1e5 }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('Infeasible_relaxed');
    expect(body.relaxation_factor).toBe(1.5);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // The relaxed capital_budget should be the original * 1.5.
    expect(body.budgets.capital_budget).toBeCloseTo(1.5e6, 6);
  });

  test('infeasible + relax both fail — surface status=Infeasible with error message', async () => {
    spawnScripts.push({ stdout: JSON.stringify({ status: 'Infeasible', objective: 0, actions: [] }), exitCode: 0 });
    spawnScripts.push({ stdout: JSON.stringify({ status: 'Infeasible', objective: 0, actions: [] }), exitCode: 0 });

    const r = await POST(
      req({ capital_budget: 1, max_nonrenew_pct: 0.01, cession_budget: 1 }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('Infeasible');
    expect(body.error).toMatch(/no feasible solution/i);
  });

  test('solver hard-fail — non-zero exit → 500 with stderr in body', async () => {
    spawnScripts.push({ stdout: '', stderr: 'CBC blew up', exitCode: 1 });

    const r = await POST(
      req({ capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 }),
    );
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toBeTruthy();
    expect(body.error).toMatch(/CBC blew up|solver|exit/i);
  });

  test('solver crash — invalid JSON on stdout → 500 with informative error', async () => {
    spawnScripts.push({ stdout: 'not json at all', exitCode: 0 });

    const r = await POST(
      req({ capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 }),
    );
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toMatch(/parse|json/i);
  });
});
