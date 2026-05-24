/**
 * Task P2.12 — Server-side Portfolio MIP re-solve for the what-if controls.
 *
 * POST {capital_budget, max_nonrenew_pct, cession_budget} → invoke the
 * Python solver (`api_py.optimize_portfolio.solve` via the `_solve_stdin`
 * shim) and return a PortfolioOptimization-shaped response.
 *
 * Why a child process?
 *   `app/api/...` routes live in the Node runtime, not Vercel's Python
 *   runtime, so we can't `import` the solver directly. The artifact pre-
 *   compute already shells out the same way (`app/api/book/upload/route.ts`)
 *   so this is the established pattern. Cohorts are read from the static
 *   `artifacts/portfolio_optimization.json` (they don't change with what-if
 *   inputs — only the budgets do).
 *
 * Caching:
 *   In-memory TTLCache keyed by `(capital, nonrenew, cession, cohort_hash)`.
 *   Cohort hash is the SHA-256 of canonical-JSON cohorts (sorted keys, no
 *   whitespace) so any artifact refresh invalidates cached entries. The
 *   cache is per-process; on Fluid Compute warm reuse this gives a real hit
 *   rate for repeat what-if presses without leaking across deploys.
 *
 * Infeasible fallback:
 *   If the solver returns `status: "Infeasible"`, we relax the capital
 *   budget by 1.5x and re-solve once. A relaxed-feasible result is returned
 *   with `status: "Infeasible_relaxed"` and `relaxation_factor: 1.5` so the
 *   UI can warn. If still infeasible, we return HTTP 200 with
 *   `status: "Infeasible"` + an explanatory error — the UI must display
 *   this, not crash on a 5xx.
 *
 * Response shape: same as the cached artifact's `PortfolioOptimization`
 * but `loss_scenarios` is stripped from every cohort (same pattern as
 * `app/portfolio/page.tsx` — ~4.5 MB array we refuse to push on the wire).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { TTLCache } from '@/lib/cache/lru';
import {
  ACTIONS,
  type ActionName,
  type OptimizedAction,
  type OptimizedCohort,
  type PortfolioOptimization,
} from '@/lib/portfolio-actions';
// Task P3.4 — every solve writes one row to the decision ledger. The write
// is best-effort: a ledger failure must not block the user-facing solve.
import { operatorFromHeaders, writeDecision } from '@/lib/audit/decisions';

export const runtime = 'nodejs';
export const maxDuration = 60;

// 5-minute TTL, 64 entries — plenty for a single demo session's what-if
// exploration (the slider yields a handful of unique budget triples).
const CACHE = new TTLCache<PortfolioOptimization>(64, 5 * 60 * 1000);

/** Test-only: clear the in-memory cache between test cases. */
export function _resetCache(): void {
  CACHE.clear();
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────
interface Budgets {
  capital_budget: number;
  max_nonrenew_pct: number;
  cession_budget: number;
}

function validate(body: unknown): { ok: true; value: Budgets } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const cap = b.capital_budget;
  const nr = b.max_nonrenew_pct;
  const ces = b.cession_budget;

  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    return { ok: false, error: 'capital_budget must be a positive finite number' };
  }
  if (typeof nr !== 'number' || !Number.isFinite(nr) || nr < 0 || nr > 1) {
    return { ok: false, error: 'max_nonrenew_pct must be a number in [0, 1]' };
  }
  if (typeof ces !== 'number' || !Number.isFinite(ces) || ces <= 0) {
    return { ok: false, error: 'cession_budget must be a positive finite number' };
  }
  return {
    ok: true,
    value: { capital_budget: cap, max_nonrenew_pct: nr, cession_budget: ces },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Cohort hash + cache key
// ────────────────────────────────────────────────────────────────────────
function canonicalJSON(value: unknown): string {
  // Deterministic JSON serializer with sorted object keys. Used so that
  // the same cohort list always hashes to the same digest regardless of
  // the input artifact's key ordering.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') +
    '}'
  );
}

function hashCohorts(cohorts: unknown[]): string {
  return createHash('sha256').update(canonicalJSON(cohorts)).digest('hex');
}

function cacheKey(b: Budgets, cohortHash: string): string {
  return `${b.capital_budget}-${b.max_nonrenew_pct}-${b.cession_budget}-${cohortHash.slice(0, 16)}`;
}

// ────────────────────────────────────────────────────────────────────────
// Spawn solver via the api_py._solve_stdin shim.
// ────────────────────────────────────────────────────────────────────────
interface SolverResponse {
  status: string;
  /**
   * Schema v5 (2026-05-23): `null` when the solver reports `Infeasible`.
   * The route forwards null to the client so the UI can render "—"
   * instead of a fake `$0.0M` margin under a RECOMMENDATION badge.
   */
  objective: number | null;
  /**
   * Realized retained TVaR-99 under the materialized action mix. Mirrors
   * api_py/optimize_portfolio.py::solve() return value.
   */
  retained_tvar_99?: number | null;
  /**
   * Each action row carries one continuous share per ``ActionName`` (the
   * 11-action set: ``retain`` + 7 ``reprice_*`` rate-grid buckets +
   * ``non_renew`` + ``cede_qs`` + ``cede_xs``). The shape mirrors the
   * Python solver's `_solve_stdin` output.
   */
  actions: Array<{ cohort_id: string } & Record<ActionName, number>>;
  horizon_start?: string;
  horizon_end?: string;
  error?: string;
}

function invokeSolver(payload: {
  cohorts: unknown[];
  capital_budget: number;
  max_nonrenew_pct: number;
  cession_budget: number;
  horizon_start?: string;
  horizon_end?: string;
}): Promise<SolverResponse> {
  return new Promise((resolve, reject) => {
    const pythonBin = process.env.FORGE_PYTHON ?? 'python3';
    // The shim dispatches by target name (added in Task SIM.11 when sim_loss
    // joined the optimize_portfolio handler). Without the target arg the
    // shim emits its usage message and exits 1 → "solver exited 1" on every
    // what-if commit. Pass `optimize_portfolio` explicitly.
    const proc = spawn(
      pythonBin,
      ['-m', 'api_py._solve_stdin', 'optimize_portfolio'],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer | string) => {
      stdout += typeof d === 'string' ? d : d.toString();
    });
    proc.stderr.on('data', (d: Buffer | string) => {
      stderr += typeof d === 'string' ? d : d.toString();
    });
    proc.on('error', (e) => {
      reject(new Error(`spawn failed: ${e.message}`));
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim() || stdout.trim() || `exit ${code}`;
        reject(new Error(`solver exited ${code}: ${tail.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as SolverResponse;
        resolve(parsed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reject(
          new Error(
            `failed to parse solver JSON output: ${msg}; stdout=${stdout.slice(0, 200)}`,
          ),
        );
      }
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// ────────────────────────────────────────────────────────────────────────
// Post-processing — assemble a PortfolioOptimization response from the
// cached artifact's cohorts/book_totals plus the fresh solver result.
// ────────────────────────────────────────────────────────────────────────
function dominantAction(row: SolverResponse['actions'][number]): {
  dominant_action: ActionName;
  dominant_share: number;
} {
  let best: ActionName = 'retain';
  let bestVal = -Infinity;
  for (const a of ACTIONS) {
    const v = row[a] ?? 0;
    if (v > bestVal) {
      bestVal = v;
      best = a;
    }
  }
  return { dominant_action: best, dominant_share: bestVal };
}

function summarizeActions(
  actions: OptimizedAction[],
  cohorts: OptimizedCohort[],
): PortfolioOptimization['action_summary'] {
  const tivById = new Map(cohorts.map((c) => [c.id, c.total_tiv]));
  const summary = ACTIONS.reduce(
    (acc, a) => {
      acc[a] = { count: 0, tiv: 0 };
      return acc;
    },
    {} as PortfolioOptimization['action_summary'],
  );
  for (const row of actions) {
    // Schema v5: dominant_action is null for cohorts under an Infeasible
    // solve — every share is 0, so there is no meaningful argmax to bucket.
    // Skip those rows; the caller will leave action_summary all-zero,
    // which is the correct representation for an infeasible state.
    if (row.dominant_action === null) continue;
    summary[row.dominant_action].count += 1;
    summary[row.dominant_action].tiv += tivById.get(row.cohort_id) ?? 0;
  }
  return summary;
}

function stripScenarios(cohorts: OptimizedCohort[]): OptimizedCohort[] {
  return cohorts.map((c) => {
    const { loss_scenarios: _drop, ...rest } = c;
    void _drop;
    return rest;
  });
}

function buildResponse(
  base: PortfolioOptimization,
  solver: SolverResponse,
  budgets: Budgets,
): PortfolioOptimization {
  const cohorts = stripScenarios(base.cohorts);
  const actions: OptimizedAction[] = solver.actions.map((row) => {
    // Build the action share map from the ACTIONS list — fills any missing
    // bucket with 0 so the OptimizedAction shape (Record<ActionName, number>)
    // is exhaustive even if the solver elided zeros.
    const shares = ACTIONS.reduce(
      (acc, a) => {
        acc[a] = row[a] ?? 0;
        return acc;
      },
      {} as Record<ActionName, number>,
    );
    return {
      cohort_id: row.cohort_id,
      ...shares,
      ...dominantAction(row),
    };
  });
  return {
    status: solver.status,
    objective: solver.objective,
    retained_tvar_99: solver.retained_tvar_99 ?? null,
    horizon_start: solver.horizon_start ?? base.horizon_start,
    horizon_end: solver.horizon_end ?? base.horizon_end,
    budgets,
    book_totals: base.book_totals,
    action_summary: summarizeActions(actions, cohorts),
    cohorts,
    actions,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Ledger write — best-effort. P3.4.
// ────────────────────────────────────────────────────────────────────────

/**
 * Persist one decision row per solve. Wraps `writeDecision` so any error
 * (DB down, migration not run, etc.) logs and continues — the user-facing
 * solve must never break because the audit trail couldn't be written.
 *
 * `outputs` is the same `PortfolioOptimization` body the caller is about
 * to return (already stripped of `loss_scenarios` — the route never lets
 * the scenario array onto the wire, so the ledger never sees it either).
 */
async function recordDecision(
  req: Request,
  budgets: Budgets,
  cohortHash: string,
  horizon_start: string | undefined,
  horizon_end: string | undefined,
  outputs: PortfolioOptimization & Record<string, unknown>,
): Promise<void> {
  try {
    await writeDecision({
      operator: operatorFromHeaders(req.headers),
      inputs: {
        budgets,
        cohorts_hash: cohortHash,
        horizon_start: horizon_start ?? null,
        horizon_end: horizon_end ?? null,
      },
      outputs,
    });
  } catch (e) {
    // Log but never propagate — see docstring.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[P3.4 decisions ledger] write failed:', msg);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Route handler.
// ────────────────────────────────────────────────────────────────────────
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const v = validate(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const budgets = v.value;

  const artifact = await loadPortfolioOptimization();
  if (!artifact) {
    return Response.json(
      {
        error:
          'portfolio optimization artifact missing; run `python -m scripts.precompute_portfolio_optimization`',
      },
      { status: 503 },
    );
  }

  const cohortHash = hashCohorts(artifact.cohorts);
  const key = cacheKey(budgets, cohortHash);
  const cached = CACHE.get(key);
  if (cached) {
    // P3.4: cache hit serves the same logical decision that was already
    // written on the original solve (the id is content-addressed, so the
    // write is idempotent anyway — but skipping here avoids redundant DB
    // round-trips on every what-if drag).
    return Response.json(cached);
  }

  // Pass cohorts straight through to the solver — the precomputed artifact
  // already carries every field `solve()` needs (id, total_tiv, total_premium,
  // loss_p50, loss_p99) plus the optional `loss_scenarios` field which
  // `solve()` happily ignores.
  let solver: SolverResponse;
  try {
    solver = await invokeSolver({
      cohorts: artifact.cohorts as unknown[],
      ...budgets,
      horizon_start: artifact.horizon_start,
      horizon_end: artifact.horizon_end,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }

  if (solver.error) {
    return Response.json({ error: solver.error }, { status: 500 });
  }

  // Infeasible fallback — relax capital by 1.5× and try once more.
  if (solver.status === 'Infeasible') {
    const RELAX = 1.5;
    const relaxedBudgets: Budgets = {
      capital_budget: budgets.capital_budget * RELAX,
      max_nonrenew_pct: budgets.max_nonrenew_pct,
      cession_budget: budgets.cession_budget,
    };
    let relaxed: SolverResponse;
    try {
      relaxed = await invokeSolver({
        cohorts: artifact.cohorts as unknown[],
        ...relaxedBudgets,
        horizon_start: artifact.horizon_start,
        horizon_end: artifact.horizon_end,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
    if (relaxed.status === 'Infeasible' || relaxed.error) {
      // Still infeasible after relaxation — surface to UI as HTTP 200 with
      // a status the client can render as a warning panel.
      const stub: PortfolioOptimization & {
        error?: string;
        relaxation_factor?: number;
      } = {
        status: 'Infeasible',
        // Schema v5: null over an infeasible solve, not 0 (a $0.0M margin
        // is a numeric value the UI would dress up as "$0.0M" under a
        // RECOMMENDATION badge — same false-confidence bug we're fixing
        // on the precompute path).
        objective: null,
        retained_tvar_99: null,
        horizon_start: artifact.horizon_start,
        horizon_end: artifact.horizon_end,
        budgets,
        book_totals: artifact.book_totals,
        action_summary: ACTIONS.reduce(
          (acc, a) => {
            acc[a] = { count: 0, tiv: 0 };
            return acc;
          },
          {} as PortfolioOptimization['action_summary'],
        ),
        cohorts: stripScenarios(artifact.cohorts),
        actions: [],
        relaxation_factor: RELAX,
        error: 'no feasible solution under given + relaxed budgets',
      };
      // P3.4: even the infeasible stub gets a ledger row — the operator
      // still made a decision (proposed an infeasible budget triple) and
      // that's worth auditing.
      await recordDecision(
        req,
        budgets,
        cohortHash,
        artifact.horizon_start,
        artifact.horizon_end,
        stub,
      );
      return Response.json(stub);
    }
    const response = buildResponse(artifact, relaxed, relaxedBudgets);
    const withFlag: PortfolioOptimization & { relaxation_factor: number } = {
      ...response,
      status: 'Infeasible_relaxed',
      relaxation_factor: RELAX,
    };
    CACHE.set(key, withFlag);
    await recordDecision(
      req,
      budgets,
      cohortHash,
      artifact.horizon_start,
      artifact.horizon_end,
      withFlag,
    );
    return Response.json(withFlag);
  }

  const response = buildResponse(artifact, solver, budgets);
  CACHE.set(key, response);
  await recordDecision(
    req,
    budgets,
    cohortHash,
    artifact.horizon_start,
    artifact.horizon_end,
    response,
  );
  return Response.json(response);
}
