# Vercel Live Monte Carlo Simulation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy FORGE to Vercel (Hobby tier) so a visitor can draw a peril footprint and see the live K=1000 Monte Carlo loss distribution, computed in a Vercel Python function, while the portfolio optimization stays precomputed.

**Architecture:** `api_py/sim_loss.py` already runs the K=1000 MC and is HTTP-ready. We add a shared `run_request()` that returns a distribution **summary** (histogram + tail stats) and skips the parquet disk-write on Vercel's read-only FS. The promote route is env-gated: it `spawn`s Python in dev (unchanged) and `fetch`es the deployed function in prod. A new `LossDistribution` component renders the histogram. Then we split `requirements.txt`, narrow `vercel.json`, and provision/deploy.

**Tech Stack:** Next.js 16 (Node runtime), Vercel Python 3.12 functions, numpy + shapely, Turso (libSQL), Vitest + Pytest, terra-draw + MapLibre (unchanged).

**Spec:** `docs/superpowers/specs/2026-06-04-vercel-live-sim-design.md`

**Branch:** `feat/vercel-live-sim` (already created).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `api_py/sim_loss.py` | Add `_summarize()` + `run_request()`; conditional parquet write; handler delegates to `run_request` | Modify |
| `api_py/_solve_stdin.py` | Dev shim's `_handle_sim_loss` delegates to `run_request` | Modify |
| `app/api/sim/[id]/promote/route.ts` | Env-gated invocation (dev spawn / prod HTTP); pass distribution through | Modify |
| `lib/sim/format.ts` | Shared `fmtUSD` currency formatter | Create |
| `components/sim/LossDistribution.tsx` | SVG histogram + mean/P99/TVaR-99 stats | Create |
| `components/sim/ImpactPanel.tsx` | Use shared `fmtUSD` | Modify |
| `components/sim/PromoteButton.tsx` | Widen `onPromoted` to carry the distribution | Modify |
| `components/sim/SimWorkspace.tsx` | Hold distribution state; render `LossDistribution` | Modify |
| `requirements.txt` | Slim to Vercel-runtime deps (numpy + shapely) | Rewrite |
| `requirements-precompute.txt` | Offline solve/train/precompute/test deps | Create |
| `vercel.json` | Narrow Python glob to `sim_loss.py`; daily cron | Modify |
| `CLAUDE.md` | Update build cheatsheet for the requirements split | Modify |
| `tests/api/test_sim_loss.py` | Tests for `_summarize` + `run_request` | Modify |
| `tests/api/sim/promote.test.ts` | Prod-path (HTTP) test | Modify |
| `tests/components/sim/LossDistribution.test.tsx` | Component render test | Create |

---

## Task 1: `_summarize()` distribution reducer

**Files:**
- Modify: `api_py/sim_loss.py` (add `import os`; add `_summarize`)
- Test: `tests/api/test_sim_loss.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_sim_loss.py`:

```python
def test_summarize_builds_histogram_and_tail_stats():
    from api_py.sim_loss import _summarize
    # 4 cohorts × K=200; per-scenario totals = column sums.
    rng = np.random.default_rng(0)
    losses = rng.lognormal(mean=12.0, sigma=0.5, size=(4, 200))
    result = {"K": 200, "cohort_keys": ["a", "b", "c", "d"], "losses": losses,
              "meta": {"sim_id": "x", "peril": "hail", "intensity": "severe"}}
    out = _summarize(result, bins=20)
    assert set(out["summary"]) == {"mean", "p50", "p90", "p99", "tvar99", "min", "max"}
    assert len(out["histogram"]["counts"]) == 20
    assert len(out["histogram"]["bin_edges"]) == 21
    assert sum(out["histogram"]["counts"]) == 200            # every scenario binned
    totals = losses.sum(axis=0)
    assert out["summary"]["tvar99"] >= out["summary"]["p99"]  # tail mean ≥ quantile
    assert out["summary"]["max"] == float(totals.max())


def test_summarize_handles_all_zero_losses():
    from api_py.sim_loss import _summarize
    result = {"K": 10, "cohort_keys": [], "losses": np.zeros((0, 10)),
              "meta": {"sim_id": "x", "peril": "hail", "intensity": "severe"}}
    out = _summarize(result, bins=5)
    assert out["summary"]["mean"] == 0.0
    assert out["summary"]["tvar99"] == 0.0
    assert sum(out["histogram"]["counts"]) == 10
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/api/test_sim_loss.py::test_summarize_builds_histogram_and_tail_stats -v`
Expected: FAIL with `ImportError: cannot import name '_summarize'`

- [ ] **Step 3: Write minimal implementation**

In `api_py/sim_loss.py`, add `import os` to the stdlib import block (after `import math`). Then add this function immediately **before** the `write_artifact` definition:

```python
def _summarize(result: dict[str, Any], bins: int = 30) -> dict[str, Any]:
    """Reduce the (n_cohorts, K) loss matrix to a client-renderable
    distribution: a histogram of the K portfolio-level scenario totals plus
    tail summary stats. Computed here (numpy) so the client never re-derives
    the tail. TVaR-99 is the mean of the worst 1% of scenario totals."""
    losses = result["losses"]
    K = int(result["K"])
    totals = losses.sum(axis=0) if getattr(losses, "size", 0) else np.zeros(K)
    counts, edges = np.histogram(totals, bins=bins)
    q99 = float(np.quantile(totals, 0.99)) if totals.size else 0.0
    tail = totals[totals >= q99]
    return {
        "histogram": {
            "bin_edges": [float(x) for x in edges],
            "counts": [int(c) for c in counts],
        },
        "summary": {
            "mean": float(totals.mean()) if totals.size else 0.0,
            "p50": float(np.quantile(totals, 0.50)) if totals.size else 0.0,
            "p90": float(np.quantile(totals, 0.90)) if totals.size else 0.0,
            "p99": q99,
            "tvar99": float(tail.mean()) if tail.size else 0.0,
            "min": float(totals.min()) if totals.size else 0.0,
            "max": float(totals.max()) if totals.size else 0.0,
        },
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/api/test_sim_loss.py -k summarize -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add api_py/sim_loss.py tests/api/test_sim_loss.py
git commit -m "feat(sim): add _summarize() loss-distribution reducer"
```

---

## Task 2: `run_request()` — shared entry with conditional persist + summary

**Files:**
- Modify: `api_py/sim_loss.py` (add `run_request`; simplify `handler.do_POST`)
- Test: `tests/api/test_sim_loss.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_sim_loss.py`:

```python
def test_run_request_skips_persist_when_disabled(monkeypatch):
    from api_py import sim_loss
    monkeypatch.setenv("FORGE_SIM_PERSIST", "0")
    calls = []
    monkeypatch.setattr(sim_loss, "write_artifact",
                        lambda *a, **k: calls.append("write") or (Path("x"), Path("y")))
    resp = sim_loss.run_request({
        "sim_id": "1234567890123_abcdef00", "footprint": _footprint(),
        "policies": SAMPLE_POLICIES, "K": 50,
    })
    assert calls == []                       # persist skipped
    assert resp["artifact_path"] is None
    assert resp["K"] == 50
    assert "histogram" in resp and "summary" in resp
    assert resp["n_cohorts"] >= 0


def test_run_request_persists_when_enabled(monkeypatch):
    from api_py import sim_loss
    monkeypatch.setenv("FORGE_SIM_PERSIST", "1")
    calls = []
    monkeypatch.setattr(sim_loss, "write_artifact",
                        lambda sim_id, result, **k: (calls.append(sim_id),
                                                     (Path(f"/tmp/{sim_id}.parquet"), Path("m")))[1])
    resp = sim_loss.run_request({
        "sim_id": "1234567890123_abcdef00", "footprint": _footprint(),
        "policies": SAMPLE_POLICIES, "K": 50,
    })
    assert calls == ["1234567890123_abcdef00"]
    assert resp["artifact_path"] == "/tmp/1234567890123_abcdef00.parquet"


def test_run_request_rejects_missing_fields():
    from api_py import sim_loss
    with pytest.raises(ValueError):
        sim_loss.run_request({"policies": SAMPLE_POLICIES})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/api/test_sim_loss.py::test_run_request_rejects_missing_fields -v`
Expected: FAIL with `AttributeError: module 'api_py.sim_loss' has no attribute 'run_request'`

- [ ] **Step 3: Write minimal implementation**

In `api_py/sim_loss.py`, add `run_request` immediately **after** `write_artifact` and **before** `class handler`:

```python
def run_request(payload: dict[str, Any]) -> dict[str, Any]:
    """Shared entry for the Vercel HTTP handler and the _solve_stdin dev shim.

    Validates the payload, runs generate_sim_losses with the canonical
    quintile-aware cohort keyer (so keys match the MIP cohort store),
    conditionally persists the parquet cache (skipped on a read-only FS or
    when FORGE_SIM_PERSIST=0 — both true on Vercel), and returns the
    client-facing response dict including the loss-distribution summary.

    Raises ValueError when sim_id or footprint is missing.
    """
    sim_id = payload.get("sim_id")
    footprint = payload.get("footprint")
    if not sim_id or not footprint:
        raise ValueError("sim_id and footprint required")
    K = int(payload.get("K") or 1000)
    policy_tuples = [tuple(p) for p in (payload.get("policies") or [])]

    from api_py.cohort_keys import cohort_key as _cohort_key, policy_quintile_lookup
    quintile_by_id = policy_quintile_lookup(policy_tuples)
    result = generate_sim_losses(
        sim_id=sim_id,
        footprint=footprint,
        policies=policy_tuples,
        cohort_keyer=lambda p: _cohort_key(p, quintile_by_id[int(p[0])]),
        K=K,
    )

    artifact_path = None
    if os.environ.get("FORGE_SIM_PERSIST", "1") != "0":
        try:
            parquet_path, _ = write_artifact(sim_id, result)
            artifact_path = str(parquet_path)
        except OSError:
            artifact_path = None  # read-only FS (Vercel) — distribution still returned

    return {
        "sim_id": sim_id,
        "K": result["K"],
        "n_cohorts": len(result["cohort_keys"]),
        "artifact_path": artifact_path,
        **_summarize(result),
    }
```

Then replace the body of `handler.do_POST` (everything after the JSON-parse block that sets `payload`) with a delegation to `run_request`:

```python
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON body"})
            return
        try:
            resp = run_request(payload)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        self._send_json(200, resp)
```

(The old inline keyer/`generate_sim_losses`/`write_artifact` block in `do_POST` is removed — `run_request` owns it now.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/api/test_sim_loss.py -v`
Expected: PASS (all tests, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add api_py/sim_loss.py tests/api/test_sim_loss.py
git commit -m "feat(sim): run_request() shared entry — summary + conditional persist"
```

---

## Task 3: Dev shim delegates to `run_request`

**Files:**
- Modify: `api_py/_solve_stdin.py` (`_handle_sim_loss`)
- Test: `tests/api/test_sim_loss.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_sim_loss.py`:

```python
def test_solve_stdin_sim_loss_emits_distribution(monkeypatch, capsys):
    import api_py._solve_stdin as shim
    from api_py import sim_loss
    monkeypatch.setenv("FORGE_SIM_PERSIST", "0")               # no disk write in test
    monkeypatch.setattr(sim_loss, "write_artifact", lambda *a, **k: (Path("x"), Path("y")))
    rc = shim._handle_sim_loss({
        "sim_id": "1234567890123_abcdef00", "footprint": _footprint(),
        "policies": SAMPLE_POLICIES, "K": 50,
    })
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["K"] == 50
    assert "histogram" in out and "summary" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/api/test_sim_loss.py::test_solve_stdin_sim_loss_emits_distribution -v`
Expected: FAIL — current `_handle_sim_loss` prints only `{K, n_cohorts, artifact_path}` (no `histogram`/`summary` keys).

- [ ] **Step 3: Write minimal implementation**

Replace the entire `_handle_sim_loss` function in `api_py/_solve_stdin.py` with:

```python
def _handle_sim_loss(payload: dict) -> int:
    """Dispatch for the K=1000 cohort loss generator (Task SIM.11).

    Delegates to api_py.sim_loss.run_request so the dev (spawn) path and the
    Vercel HTTP function return an identical shape — including the loss
    distribution summary. run_request owns the canonical quintile-aware
    cohort keyer and the conditional parquet persist.
    """
    try:
        from api_py.sim_loss import run_request
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"import failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1
    try:
        resp = run_request(payload)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"sim_loss failed: {e}"}), flush=True)
        sys.stderr.write(traceback.format_exc())
        return 1
    print(json.dumps(resp))
    return 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/api/test_sim_loss.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api_py/_solve_stdin.py tests/api/test_sim_loss.py
git commit -m "refactor(sim): dev shim delegates to run_request (distribution parity)"
```

---

## Task 4: Env-gated promote route (dev spawn / prod HTTP)

**Files:**
- Modify: `app/api/sim/[id]/promote/route.ts`
- Test: `tests/api/sim/promote.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe('POST /api/sim/[id]/promote', …)` block in `tests/api/sim/promote.test.ts`:

```ts
  test('prod path: fetches the Python function and returns the distribution', async () => {
    const create = await CREATE(new Request('http://localhost/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Prod path test',
        footprint: {
          peril: 'hail', intensity: 'severe', severity: 45,
          geometry: { type: 'Polygon', coordinates: [[[-82.5,27.5],[-82,27.5],[-82,28],[-82.5,28],[-82.5,27.5]]] },
          effective_date: '2026-05-18',
          metadata: { drawn_by: 't', drawn_at: '2026-05-18T00:00:00Z' },
        },
      }),
    }));
    const { sim_id } = await create.json();

    const origVercel = process.env.VERCEL;
    const origUrl = process.env.VERCEL_URL;
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    process.env.VERCEL = '1';
    process.env.VERCEL_URL = 'forge-test.vercel.app';
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        sim_id, K: 1000, n_cohorts: 3, artifact_path: null,
        histogram: { bin_edges: [0, 1, 2], counts: [2, 1] },
        summary: { mean: 1, p50: 1, p90: 1, p99: 2, tvar99: 3, min: 0, max: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const res = await POST(
        new Request(`http://localhost/api/sim/${sim_id}/promote`, { method: 'POST' }),
        { params: Promise.resolve({ id: sim_id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.tvar99).toBe(3);
      expect(body.histogram.counts).toEqual([2, 1]);
      expect(calls[0]).toContain('forge-test.vercel.app/api_py/sim_loss');
    } finally {
      globalThis.fetch = realFetch;
      if (origVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = origVercel;
      if (origUrl === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = origUrl;
    }
  }, 30_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `FORGE_SKIP_REOPTIMIZE_INTEGRATION=1 npx vitest run tests/api/sim/promote.test.ts -t "prod path"`
Expected: FAIL — the current route always spawns Python (ignores `VERCEL`), so `calls` stays empty and the assertion on the fetched URL fails.

- [ ] **Step 3: Write minimal implementation**

In `app/api/sim/[id]/promote/route.ts`, keep the existing `runPython` function. Add a `runSimLoss` dispatcher directly below it:

```ts
function runSimLoss(payload: unknown): Promise<{
  sim_id: string; K: number; n_cohorts: number; artifact_path: string | null;
  histogram: { bin_edges: number[]; counts: number[] };
  summary: Record<string, number>;
}> {
  // Prod (Vercel): no Python binary in the Node function — call the deployed
  // sim_loss Python function over HTTP. Dev: spawn the local interpreter.
  if (process.env.VERCEL) {
    const base = `https://${process.env.VERCEL_URL}`;
    return fetch(`${base}/api_py/sim_loss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`sim_loss function ${r.status}: ${await r.text()}`);
      return r.json();
    });
  }
  return runPython(payload) as ReturnType<typeof runSimLoss>;
}
```

Then in the `POST` handler, change the invocation + response. Replace:

```ts
  let pyResult: { K: number; n_cohorts: number; artifact_path: string };
  try {
    pyResult = (await runPython({ sim_id: id, footprint, policies, K: 1000 })) as typeof pyResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `loss compute failed: ${msg}` }, { status: 500 });
  }
```

with:

```ts
  let pyResult: Awaited<ReturnType<typeof runSimLoss>>;
  try {
    pyResult = await runSimLoss({ sim_id: id, footprint, policies, K: 1000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `loss compute failed: ${msg}` }, { status: 500 });
  }
```

And replace the final `return NextResponse.json({…})` with:

```ts
  return NextResponse.json({
    sim_id: id,
    K: pyResult.K,
    n_cohorts: pyResult.n_cohorts,
    artifact_path: pyResult.artifact_path ?? null,
    histogram: pyResult.histogram,
    summary: pyResult.summary,
    compute_time_ms: 0,  // SIM.10: populate from real measurement in v1.1
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `FORGE_SKIP_REOPTIMIZE_INTEGRATION=1 npx vitest run tests/api/sim/promote.test.ts`
Expected: PASS — the existing dev-spawn tests (parquet written) AND the new prod-path test.

- [ ] **Step 5: Commit**

```bash
git add app/api/sim/[id]/promote/route.ts tests/api/sim/promote.test.ts
git commit -m "feat(sim): env-gate promote route (dev spawn / prod HTTP function)"
```

---

## Task 5: `LossDistribution` component + shared `fmtUSD`

**Files:**
- Create: `lib/sim/format.ts`
- Create: `components/sim/LossDistribution.tsx`
- Modify: `components/sim/ImpactPanel.tsx` (use shared `fmtUSD`)
- Test: `tests/components/sim/LossDistribution.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/sim/LossDistribution.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, test, expect } from 'vitest';
import { LossDistribution } from '@/components/sim/LossDistribution';

describe('LossDistribution', () => {
  test('renders one bar per histogram bin and the TVaR-99 stat', () => {
    const { container } = render(
      <LossDistribution
        histogram={{ bin_edges: [0, 1, 2, 3], counts: [2, 5, 3] }}
        summary={{ mean: 1_500_000, p50: 1_000_000, p90: 2_000_000,
                   p99: 2_800_000, tvar99: 3_100_000, min: 0, max: 3_500_000 }}
      />,
    );
    expect(container.querySelectorAll('rect').length).toBe(3);
    expect(screen.getByText('TVaR-99')).toBeInTheDocument();
    expect(screen.getByText('$3.1M')).toBeInTheDocument();   // tvar99 via fmtUSD
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/sim/LossDistribution.test.tsx`
Expected: FAIL — `Cannot find module '@/components/sim/LossDistribution'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/sim/format.ts`:

```ts
/** Compact USD formatter shared by the simulate-tab panels. */
export function fmtUSD(n: number): string {
  if (n === 0) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}
```

Create `components/sim/LossDistribution.tsx`:

```tsx
'use client';
import { fmtUSD } from '@/lib/sim/format';

export interface LossHistogram {
  bin_edges: number[];
  counts: number[];
}
export interface LossSummary {
  mean: number; p50: number; p90: number; p99: number;
  tvar99: number; min: number; max: number;
}
export interface LossDistributionProps {
  histogram: LossHistogram;
  summary: LossSummary;
}

export function LossDistribution({ histogram, summary }: LossDistributionProps) {
  const counts = histogram.counts;
  const maxCount = Math.max(...counts, 1);
  const W = 240, H = 64;
  const bw = counts.length > 0 ? W / counts.length : W;
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wider text-slate-400">
        Loss distribution (K=1000)
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
           aria-label="Loss distribution histogram"
           className="bg-slate-900/40 rounded">
        {counts.map((c, i) => {
          const h = (c / maxCount) * (H - 4);
          return <rect key={i} x={i * bw} y={H - h} width={Math.max(bw - 1, 1)}
                       height={h} className="fill-blue-500" />;
        })}
      </svg>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Mean" value={fmtUSD(summary.mean)} />
        <Stat label="P99" value={fmtUSD(summary.p99)} />
        <Stat label="TVaR-99" value={fmtUSD(summary.tvar99)} accent />
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className={`tabular-nums ${accent ? 'text-red-300 font-semibold' : 'text-slate-200'}`}>
        {value}
      </span>
    </div>
  );
}
```

Edit `components/sim/ImpactPanel.tsx`: delete the local `fmtUSD` function (the 7-line `function fmtUSD(n: number) {…}` block) and add the import below the existing `import type { PreviewImpact } …` line:

```tsx
import { fmtUSD } from '@/lib/sim/format';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/components/sim/LossDistribution.test.tsx tests/components`
Expected: PASS (new component test + pre-existing component tests still green)

- [ ] **Step 5: Commit**

```bash
git add lib/sim/format.ts components/sim/LossDistribution.tsx components/sim/ImpactPanel.tsx tests/components/sim/LossDistribution.test.tsx
git commit -m "feat(sim): LossDistribution component + shared fmtUSD"
```

---

## Task 6: Wire promote result → distribution display

**Files:**
- Modify: `components/sim/PromoteButton.tsx`
- Modify: `components/sim/SimWorkspace.tsx`
- Test: `tests/components/sim/PromoteButton.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/sim/PromoteButton.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { PromoteButton } from '@/components/sim/PromoteButton';

afterEach(() => { vi.restoreAllMocks(); });

describe('PromoteButton', () => {
  test('passes the returned distribution to onPromoted', async () => {
    const dist = {
      K: 1000, n_cohorts: 3,
      histogram: { bin_edges: [0, 1, 2], counts: [2, 1] },
      summary: { mean: 1, p50: 1, p90: 1, p99: 2, tvar99: 3, min: 0, max: 4 },
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(dist), { status: 200, headers: { 'content-type': 'application/json' } })));
    const onPromoted = vi.fn();
    render(<PromoteButton simId="1234567890123_abcdef00" promoted={false} onPromoted={onPromoted} />);
    await userEvent.click(screen.getByRole('button', { name: /promote to scenario/i }));
    await waitFor(() => expect(onPromoted).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.objectContaining({ tvar99: 3 }),
    })));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/sim/PromoteButton.test.tsx`
Expected: FAIL — `onPromoted`'s declared type is `{ K, n_cohorts }`, so TypeScript build/typecheck rejects the `summary`/`histogram` shape (and the assertion is unmet).

- [ ] **Step 3: Write minimal implementation**

In `components/sim/PromoteButton.tsx`, add the import below the `useState` import:

```tsx
import type { LossHistogram, LossSummary } from './LossDistribution';
```

Replace the `PromoteButtonProps` interface with:

```tsx
export interface PromoteResult {
  K: number;
  n_cohorts: number;
  histogram?: LossHistogram;
  summary?: LossSummary;
}

export interface PromoteButtonProps {
  simId: string | null;
  promoted: boolean;
  onPromoted: (result: PromoteResult) => void;
}
```

(The existing `onPromoted(await res.json())` call already forwards the full body — no change to `onClick`.)

In `components/sim/SimWorkspace.tsx`:

1. Add imports below the `PromoteButton` import:

```tsx
import { LossDistribution, type LossHistogram, type LossSummary } from './LossDistribution';
```

2. Add distribution state next to the other `useState` calls (after the `promoted` state):

```tsx
  const [distribution, setDistribution] = useState<{ histogram: LossHistogram; summary: LossSummary } | null>(null);
```

3. In `onFootprintChange`, reset the distribution when a new draft is created — add `setDistribution(null);` immediately after `setPromoted(false);`.

4. Replace the `<PromoteButton …/>` element with:

```tsx
        <PromoteButton
          simId={simId}
          promoted={promoted}
          onPromoted={(r) => {
            setPromoted(true);
            if (r.histogram && r.summary) setDistribution({ histogram: r.histogram, summary: r.summary });
          }}
        />
        {distribution && (
          <LossDistribution histogram={distribution.histogram} summary={distribution.summary} />
        )}
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `npx vitest run tests/components/sim/PromoteButton.test.tsx && npx tsc --noEmit`
Expected: PASS (test green; no type errors)

- [ ] **Step 5: Commit**

```bash
git add components/sim/PromoteButton.tsx components/sim/SimWorkspace.tsx tests/components/sim/PromoteButton.test.tsx
git commit -m "feat(sim): surface live loss distribution after promote"
```

---

## Task 7: Split `requirements.txt` (Vercel-runtime vs offline)

**Files:**
- Rewrite: `requirements.txt`
- Create: `requirements-precompute.txt`
- Modify: `CLAUDE.md` (build cheatsheet)

- [ ] **Step 1: Rewrite `requirements.txt`** to the deployed-function runtime deps only:

```
# Vercel-runtime Python deps — ONLY what the deployed api_py/sim_loss.py
# function imports at runtime (verified: numpy + shapely; pyarrow is a local
# import inside write_artifact, which the Vercel function never calls).
# Everything else (offline solve / training / precompute / tests) lives in
# requirements-precompute.txt and is NEVER bundled into a Vercel function.
numpy>=1.26
shapely>=2.0
```

- [ ] **Step 2: Create `requirements-precompute.txt`:**

```
# Offline-only Python deps: portfolio/VRP solve, ML training, scenario
# precompute, evaluation, real-mode CV fetch, and the test runner. Installed
# locally and in CI — NEVER bundled into a Vercel function (see requirements.txt).
numpy>=1.26
shapely>=2.0
scipy>=1.11          # saa.py continuous CRPS (PchipInterpolator + quad)
requests>=2.31
pytest>=8.0
pandas>=2.0
pyarrow>=14.0
xgboost>=2.0
optuna>=3.5
scikit-learn>=1.4
joblib>=1.3
pulp>=2.7
ortools>=9.10
matplotlib>=3.8
# Optional — real-mode Sentinel-2 fetches (FORGE_CV_MODE=real)
planetary-computer>=1.0
pystac-client>=0.7
rasterio>=1.3
rioxarray>=0.15
```

- [ ] **Step 3: Update the `CLAUDE.md` build cheatsheet.** Replace these two lines in the ```bash block under "Build / test cheatsheet":

```
pip install -r requirements.txt                        # Runtime Python deps (NOT requirements-train.txt for routes)
pip install -r requirements-train.txt                  # Offline-only: torch + timm for CV head inference
```

with:

```
pip install -r requirements.txt                        # Vercel-runtime deps ONLY (numpy + shapely) — what Vercel installs
pip install -r requirements-precompute.txt             # Offline: solve / precompute / eval / tests (pulp, ortools, pandas, scipy, pytest, …)
pip install -r requirements-train.txt                  # Offline-only: torch + timm for CV head inference
```

- [ ] **Step 4: Verify the runtime install is sufficient and the test deps still resolve**

Run:
```bash
python -m venv /tmp/forge-rt && /tmp/forge-rt/bin/pip install -q -r requirements.txt && \
  /tmp/forge-rt/bin/python -c "import api_py.sim_loss; print('sim_loss imports with runtime deps OK')"
pip install -q -r requirements-precompute.txt && pytest tests/api/test_sim_loss.py -q
```
Expected: the first prints "sim_loss imports with runtime deps OK" (numpy+shapely suffice); pytest passes.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt requirements-precompute.txt CLAUDE.md
git commit -m "chore(deploy): split requirements — slim Vercel runtime vs offline precompute"
```

---

## Task 8: Narrow `vercel.json` + daily cron

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Rewrite `vercel.json`:**

```json
{
  "functions": {
    "app/api/agent/chat/route.ts": { "runtime": "nodejs" },
    "api_py/sim_loss.py": { "runtime": "python3.12" }
  },
  "crons": [{ "path": "/api/cron/refresh", "schedule": "0 0 * * *" }]
}
```

(Only `sim_loss.py` deploys as a Python function — `optimize_portfolio.py` / `optimize_vrp.py` / `scenarios.py` are offline-only and would pull `pulp`/`ortools`. Cron drops to daily for Hobby.)

- [ ] **Step 2: Verify the build is still green**

Run: `npm run build`
Expected: "Compiled successfully" and the route table prints. (The 3 pre-existing NFT warnings on the spawn-Python routes remain until those routes are removed — out of scope here; they do not fail the build.)

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "chore(deploy): deploy only sim_loss.py as a Python function; daily cron (Hobby)"
```

---

## Task 9: Provision Turso + deploy (operational runbook)

This task is an operational checklist — exact commands, verified by observation rather than unit tests. Run it from the repo root on the `feat/vercel-live-sim` branch.

- [ ] **Step 1: Ensure the local DB is seeded and the portfolio artifact is fresh**

```bash
npm run migrate                                   # idempotent — creates tables in forge-local.db
python scripts/seed_policy_book.py                # 10k synthetic policies (skip if forge-local.db already seeded)
python -m scripts.precompute_portfolio_optimization
git add artifacts/portfolio_optimization.json artifacts/portfolio_optimization.meta.json
git commit -m "chore(deploy): refresh precomputed portfolio artifact for deploy"
```

- [ ] **Step 2: Provision Turso and capture credentials**

```bash
# Install the Turso CLI if needed: brew install tursodatabase/tap/turso ; turso auth login
turso db create forge-demo
turso db show forge-demo --url            # → TURSO_URL  (libsql://…)
turso db tokens create forge-demo         # → TURSO_AUTH_TOKEN
```

- [ ] **Step 3: Load the seeded book into Turso (seed-local → import)**

The seed script writes a local SQLite file only, so dump and replay it into Turso:

```bash
sqlite3 forge-local.db .dump > /tmp/forge-dump.sql
turso db shell forge-demo < /tmp/forge-dump.sql
turso db shell forge-demo "SELECT count(*) FROM policies;"   # expect 10000
```

- [ ] **Step 4: Link the Vercel project and set environment variables**

```bash
vercel link                                       # creates .vercel/ (gitignored)
vercel env add TURSO_URL production               # paste the libsql:// URL
vercel env add TURSO_AUTH_TOKEN production         # paste the token
vercel env add FORGE_SIM_PERSIST production        # value: 0  (skip parquet write on read-only FS)
vercel env add CRON_SECRET production              # any random string
# Optional (agent has mock fallbacks): OPENROUTER_API_KEY or GITHUB_MODELS_PAT
```

- [ ] **Step 5: Smoke-test the prod invocation path locally with `vercel dev`**

`vercel dev` serves the Python function over HTTP (unlike `next dev`), exercising the prod fetch path:

```bash
vercel env pull .env.vercel.local
vercel dev --listen 3002
```
Then in a browser: open `http://localhost:3002/simulate`, draw a polygon, click **Promote to scenario →**, and confirm the **Loss distribution (K=1000)** histogram + Mean/P99/TVaR-99 render. Stop with Ctrl-C.

- [ ] **Step 6: Deploy to production and smoke-test**

```bash
vercel --prod
```
On the returned URL: load `/simulate`, draw a footprint (preview impact appears), click Promote, and confirm the live distribution renders. Then load `/portfolio` and confirm the precomputed result shows. Capture the URL for the README/demo.

- [ ] **Step 7: Commit any deploy config left in the working tree** (e.g., a `.vercelignore` if added). `.vercel/` is gitignored — do not commit it.

```bash
git status --short
# git add <any intended config> && git commit -m "chore(deploy): vercel deploy config"
```

---

## Self-Review

**1. Spec coverage:**
- §3.1 handler returns distribution + conditional parquet → Tasks 1, 2 ✓
- §3.2 env-gated promote route → Task 4 ✓
- §3.3 LossDistribution component → Tasks 5, 6 ✓
- §3.4 requirements split → Task 7 ✓
- §3.5 vercel.json narrowing → Task 8 ✓
- §4 data flow (draw→preview already live; promote→distribution) → Tasks 4–6 ✓
- §5 provisioning (Turso seed-local→import, env incl. FORGE_SIM_PERSIST=0, daily cron, link/deploy/smoke) → Tasks 8, 9 ✓
- §6 error handling (function 5xx → route 502 message; all-zero → honest stats) → Task 4 route throws on `!r.ok` → existing 500 path; `_summarize` all-zero test (Task 1) ✓
- §7 testing (handler summary, persist skip, golden determinism via pre-existing `test_seed_is_deterministic`, route mocks, component) → Tasks 1–6 ✓
- Dev shim parity (§3.1 "shared `_summarize`/`run_request`") → Task 3 ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**3. Type consistency:** `LossHistogram`/`LossSummary` defined once in `LossDistribution.tsx` (Task 5), imported by `PromoteButton.tsx` (Task 6). `run_request` (Task 2) is the single Python entry used by both the handler (Task 2) and the dev shim (Task 3). The route's `runSimLoss` return type matches the Python response keys (`histogram`, `summary`, `artifact_path`). `fmtUSD` defined once in `lib/sim/format.ts` (Task 5), imported by `ImpactPanel` and `LossDistribution`. ✓

**Note (known v1 limitation):** re-opening a previously-promoted sim from the library does not re-render its distribution until Promote is clicked again (the distribution is computed on demand and held in session state, not persisted — consistent with spec §2 "no losses persisted online"). Recomputing on page load is a deliberate follow-up, not a gap in this plan.
