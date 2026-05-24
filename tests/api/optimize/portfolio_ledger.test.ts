// @vitest-environment node
/**
 * Task P3.4 — Decision-ledger wire-up on /api/optimize/portfolio.
 *
 * The route's existing happy-path / cache / infeasible tests live in
 * portfolio.test.ts. This file focuses narrowly on the ledger side-effect:
 *
 *   1. A feasible solve writes exactly one decision row with the right
 *      operator + cohorts_hash + budgets and an outputs_json matching the
 *      response body.
 *   2. The `X-Forge-Operator` request header flows through to `operator`.
 *   3. Missing header falls back to `'demo_operator'`.
 *   4. An infeasible-stub solve still writes a ledger row (the operator
 *      proposed a budget triple — that's an audit-worthy event).
 *   5. A repeat solve is idempotent — same inputs + same outputs collapse
 *      into one ledger row.
 *
 * We share the spawn / loader mocks with portfolio.test.ts but keep the
 * setup local so any future change to either file's harness doesn't
 * cross-contaminate.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// ────────────────────────────────────────────────────────────────────────
// Fake spawn — copy of the harness in portfolio.test.ts. Kept local to this
// file so the two test files don't accidentally race on shared script
// queues during parallel runs.
// ────────────────────────────────────────────────────────────────────────
type SpawnScript = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: Error;
};

const spawnScripts: SpawnScript[] = [];

function fakeSpawn() {
  const script = spawnScripts.shift() ?? { stdout: '{}', exitCode: 0 };
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  const stdinChunks: Buffer[] = [];
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stdoutEmitter = new EventEmitter() as Readable;
  const stderrEmitter = new EventEmitter() as Readable;
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;

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
  spawn: vi.fn(() => fakeSpawn()),
}));

vi.mock('@/lib/db/portfolio_optimization', () => ({
  loadPortfolioOptimization: vi.fn(),
}));

import { POST, _resetCache } from '@/app/api/optimize/portfolio/route';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { db } from '@/lib/db/client';
import { listDecisions } from '@/lib/audit/decisions';

const loaderMock = loadPortfolioOptimization as unknown as ReturnType<typeof vi.fn>;

const SAMPLE_OPT = {
  schema_version: 3,
  status: 'Optimal',
  objective: 1000,
  horizon_start: '2026-07-01',
  horizon_end: '2027-06-30',
  budgets: { capital_budget: 1e7, max_nonrenew_pct: 0.1, cession_budget: 5e6 },
  book_totals: { tiv: 1e9, premium: 1e7, loss_p50: 5e6, loss_p99: 2e7 },
  action_summary: {
    retain: { count: 0, tiv: 0 },
    reprice_n20: { count: 0, tiv: 0 },
    reprice_n10: { count: 0, tiv: 0 },
    reprice_0: { count: 0, tiv: 0 },
    reprice_p5: { count: 0, tiv: 0 },
    reprice_p10: { count: 0, tiv: 0 },
    reprice_p15: { count: 0, tiv: 0 },
    reprice_p20: { count: 0, tiv: 0 },
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
      loss_scenarios: [1, 2, 3, 4, 5],
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
        reprice_n20: 0,
        reprice_n10: 0,
        reprice_0: 0,
        reprice_p5: 0,
        reprice_p10: 0,
        reprice_p15: 0,
        reprice_p20: 0,
        non_renew: 0,
        cede_qs: 0,
        cede_xs: 0,
      },
    ],
  });
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/optimize/portfolio', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Mirror the schema migration so the ledger write doesn't fail silently
  // (the route swallows write errors, so without the table the side-effect
  // assertions below would always pass on zero rows).
  await db.execute(
    'CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, solve_ts TEXT NOT NULL, operator TEXT NOT NULL, inputs_hash TEXT NOT NULL, inputs_json TEXT NOT NULL, outputs_hash TEXT NOT NULL, outputs_json TEXT NOT NULL, executed_at TEXT, reversed_at TEXT, reversed_by TEXT, notices_sent_at TEXT)',
  );
});

beforeEach(async () => {
  _resetCache();
  spawnScripts.length = 0;
  loaderMock.mockReset();
  loaderMock.mockResolvedValue(SAMPLE_OPT);
  await db.execute('DELETE FROM decisions');
});

afterEach(async () => {
  vi.clearAllMocks();
  await db.execute('DELETE FROM decisions');
});

describe('POST /api/optimize/portfolio — decision ledger wire-up (P3.4)', () => {
  test('feasible solve writes exactly one ledger row', async () => {
    spawnScripts.push({ stdout: makeSolverResult('Optimal'), exitCode: 0 });

    const r = await POST(
      req(
        { capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 },
        { 'x-forge-operator': 'alice' },
      ),
    );
    expect(r.status).toBe(200);
    const body = await r.json();

    const rows = await listDecisions();
    expect(rows.length).toBe(1);
    const decision = rows[0];

    expect(decision.operator).toBe('alice');
    expect(decision.executed_at).toBeNull();
    expect(decision.reversed_at).toBeNull();
    expect(decision.notices_sent_at).toBeNull();

    // inputs_json carries budgets + horizon + cohorts_hash.
    const inputs = JSON.parse(decision.inputs_json);
    expect(inputs.budgets).toEqual({
      capital_budget: 1e7,
      max_nonrenew_pct: 0.15,
      cession_budget: 5e6,
    });
    expect(inputs.horizon_start).toBe('2026-07-01');
    expect(inputs.horizon_end).toBe('2027-06-30');
    expect(inputs.cohorts_hash).toMatch(/^[0-9a-f]{64}$/);

    // outputs_json reproduces the response body the route returned.
    const outputs = JSON.parse(decision.outputs_json);
    expect(outputs.status).toBe(body.status);
    expect(outputs.objective).toBe(body.objective);
    expect(outputs.actions.length).toBe(body.actions.length);
  });

  test('missing X-Forge-Operator falls back to demo_operator', async () => {
    spawnScripts.push({ stdout: makeSolverResult('Optimal'), exitCode: 0 });
    const r = await POST(
      req({ capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 }),
    );
    expect(r.status).toBe(200);
    const rows = await listDecisions();
    expect(rows.length).toBe(1);
    expect(rows[0].operator).toBe('demo_operator');
  });

  test('infeasible-stub solve still writes a ledger row', async () => {
    // Both primary + relaxed return Infeasible → route emits the stub.
    spawnScripts.push({ stdout: makeSolverResult('Infeasible'), exitCode: 0 });
    spawnScripts.push({ stdout: makeSolverResult('Infeasible'), exitCode: 0 });

    const r = await POST(
      req(
        { capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 },
        { 'x-forge-operator': 'bob' },
      ),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('Infeasible');

    const rows = await listDecisions();
    expect(rows.length).toBe(1);
    expect(rows[0].operator).toBe('bob');
    const outputs = JSON.parse(rows[0].outputs_json);
    expect(outputs.status).toBe('Infeasible');
  });

  test('identical re-solve via a fresh cache write is idempotent (same id collapses)', async () => {
    // Two independent feasible solves with the same budgets + same cohorts +
    // same solver output → same content-addressed id → one row.
    spawnScripts.push({ stdout: makeSolverResult('Optimal'), exitCode: 0 });
    const body = { capital_budget: 1e7, max_nonrenew_pct: 0.15, cession_budget: 5e6 };
    await POST(req(body, { 'x-forge-operator': 'alice' }));

    // Reset the cache so the route re-spawns + re-writes.
    _resetCache();
    spawnScripts.push({ stdout: makeSolverResult('Optimal'), exitCode: 0 });
    await POST(req(body, { 'x-forge-operator': 'alice' }));

    const rows = await listDecisions();
    expect(rows.length).toBe(1);
  });
});
