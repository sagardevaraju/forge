'use client';

/**
 * Task P2.13 (Redesign Phase 2) — What-if controls on the Portfolio page.
 *
 * Wraps the `PortfolioHeader` ExecCard strip with a right-rail of three
 * `WhatIfControl` sliders bound to the Portfolio MIP's three budgets
 * (capital, max non-renew %, cession spend). On `onCommit` from any of
 * them, POSTs the perturbed triple to `/api/optimize/portfolio`
 * (P2.12) and re-renders the ExecCards with the new objective, capital
 * usage, and non-renew TIV, plus a `+Δ vs baseline` sub-line on the
 * cards that move.
 *
 * State:
 *   - `initialOptimization` — the server-rendered baseline; never mutated.
 *     Used to compute deltas and as the target of "Reset to baseline".
 *   - `current` — the most recent solve (starts equal to the initial).
 *   - `proposedBudgets` — the latest committed budget triple.
 *   - `solving` — true between fetch start and response (success or error).
 *   - `error` / `warning` — surfaced to the rail. `warning` is set when the
 *     server returns `status === 'Infeasible_relaxed'`; `error` is set on
 *     HTTP failure or the explicit `Infeasible` status returned with
 *     `relaxation_factor` but no usable result.
 *
 * Why we deduplicate commits:
 *   `WhatIfControl.onCommit` already filters identical commits within one
 *   control, but if the user touches a different control first and then
 *   returns to the original budget triple, the shell could double-fetch.
 *   The `proposedBudgets` equality check below guards against that.
 *
 * Trust tier: the rail header carries a `MODEL_OUTPUT` badge — any solve we
 * surface (initial or re-solved) is the same PuLP/CBC pipeline.
 */

import { useMemo, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { PortfolioHeader } from '@/components/PortfolioHeader';
import { WhatIfControl } from '@/components/grammar/WhatIfControl';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import {
  type PortfolioOptimization,
  computeProjectedCessionSpend,
} from '@/lib/portfolio-actions';
import { type Persona, getPersonaConfig } from '@/lib/persona/config';

interface Budgets {
  capital_budget: number;
  max_nonrenew_pct: number;
  cession_budget: number;
}

interface ServerResponse extends PortfolioOptimization {
  error?: string;
  relaxation_factor?: number;
}

interface Props {
  initialOptimization: PortfolioOptimization;
  totalTiv: number;
  /**
   * Task P2.18 — persona lens. Selects which ExecCards are rendered (passed
   * through to `PortfolioHeader`) and whether the what-if rail is shown.
   * Only cat-ops surfaces the rail by default; other personas read the
   * baseline solve without re-perturbation. Defaults to `cat-ops` so
   * existing callers (server tests, the Phase 1 view) keep the rail.
   */
  persona?: Persona;
  /**
   * Task P2.18 — optional treaty layers for the Reinsurance persona's
   * RoL-by-layer + retained-tail cards. Passed straight through.
   */
  rolLayers?: { type: string; rol: number; attachment?: number }[];
  /** Task P2.18 — optional CRPS scalar for the Actuary persona. */
  crps?: number;
  /** Task P2.18 — optional SAA optimality gap for the Academic persona. */
  saaGap?: number;
  /** Task P2.18 — optional VRP demand scalar for the Field-ops persona. */
  vrpDemand?: number;
}

/** Format a signed delta in $M. Returns null when |delta| < epsilon. */
function formatDeltaM(delta: number, suffix = 'vs baseline'): string | null {
  if (!Number.isFinite(delta) || Math.abs(delta) < 5e4) return null; // <$0.05M = noise
  const sign = delta >= 0 ? '+' : '-';
  return `${sign}$${(Math.abs(delta) / 1e6).toFixed(1)}M ${suffix}`;
}

function budgetsEqual(a: Budgets, b: Budgets): boolean {
  return (
    a.capital_budget === b.capital_budget &&
    a.max_nonrenew_pct === b.max_nonrenew_pct &&
    a.cession_budget === b.cession_budget
  );
}

export function PortfolioWhatIfShell({
  initialOptimization,
  totalTiv,
  persona = 'cat-ops',
  rolLayers,
  crps,
  saaGap,
  vrpDemand,
}: Props) {
  const baseline = initialOptimization; // never mutated — keep as constant.
  const personaConfig = getPersonaConfig(persona);
  const baselineBudgets: Budgets = useMemo(
    () => ({ ...initialOptimization.budgets }),
    [initialOptimization.budgets],
  );

  const [current, setCurrent] = useState<PortfolioOptimization>(initialOptimization);
  const [proposedBudgets, setProposedBudgets] = useState<Budgets>(baselineBudgets);
  const [solving, setSolving] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track the in-flight request so out-of-order responses don't trample the
  // latest commit (rare with our deduplication but cheap insurance).
  const requestSeqRef = useRef(0);
  // Last triple we actually POSTed — used to dedupe identical commits across
  // different controls. The server has its own 5-min TTL cache too, but we'd
  // rather not even pay the round-trip.
  const lastFetchedRef = useRef<Budgets>(baselineBudgets);

  const resolve = useCallback(
    async (next: Budgets) => {
      if (budgetsEqual(next, lastFetchedRef.current)) {
        // Nothing changed at the budget level vs the last committed solve.
        return;
      }
      lastFetchedRef.current = next;
      const seq = ++requestSeqRef.current;
      setProposedBudgets(next);
      setSolving(true);
      setError(null);
      setWarning(null);
      try {
        const res = await fetch('/api/optimize/portfolio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        if (seq !== requestSeqRef.current) return; // a newer commit superseded us
        const json = (await res.json()) as ServerResponse;
        if (!res.ok) {
          setError(json.error ?? `re-solve failed (HTTP ${res.status})`);
          return;
        }
        if (json.status === 'Infeasible_relaxed' && typeof json.relaxation_factor === 'number') {
          setWarning(
            `Infeasible at the requested capital budget, relaxed by ${json.relaxation_factor}× and re-solved.`,
          );
          setCurrent(json);
          return;
        }
        if (json.status === 'Infeasible') {
          setError(
            json.error ?? 'no feasible solution under given + relaxed budgets',
          );
          return;
        }
        setCurrent(json);
      } catch (e) {
        if (seq !== requestSeqRef.current) return;
        setError(e instanceof Error ? e.message : 'network error during re-solve');
      } finally {
        if (seq === requestSeqRef.current) setSolving(false);
      }
    },
    [],
  );

  const onCapitalCommit = useCallback(
    (value: number) => {
      void resolve({ ...proposedBudgets, capital_budget: value });
    },
    [proposedBudgets, resolve],
  );
  const onNonrenewCommit = useCallback(
    (value: number) => {
      void resolve({ ...proposedBudgets, max_nonrenew_pct: value });
    },
    [proposedBudgets, resolve],
  );
  const onCessionCommit = useCallback(
    (value: number) => {
      void resolve({ ...proposedBudgets, cession_budget: value });
    },
    [proposedBudgets, resolve],
  );

  const onReset = useCallback(() => {
    requestSeqRef.current += 1; // invalidate any in-flight response
    lastFetchedRef.current = baselineBudgets;
    setCurrent(baseline);
    setProposedBudgets(baselineBudgets);
    setSolving(false);
    setError(null);
    setWarning(null);
  }, [baseline, baselineBudgets]);

  // Derive the ExecCard inputs from the latest solve. capital_used is the
  // gross VaR-99 carried on book_totals.loss_p99; the matching card label is
  // "Tail exposure / capital budget" (see PortfolioHeader::capital_used).
  // cessionSpend is summed scenario-by-scenario from the cohort × action
  // matrix using CESSION_COST_RATE — the previous hardcoded 0 contradicted
  // every solve that recommended cede_qs or cede_xs.
  const capitalUsed = current.book_totals.loss_p99;
  const cessionSpend = computeProjectedCessionSpend(current);
  const nonrenewUsedTiv = current.action_summary?.non_renew?.tiv ?? 0;
  const nonrenewCapTiv = totalTiv * current.budgets.max_nonrenew_pct;

  // Baseline reference values for delta computation.
  const baseObjective = baseline.objective;
  const baseCapitalUsed = baseline.book_totals.loss_p99;
  const baseNonrenewUsed = baseline.action_summary?.non_renew?.tiv ?? 0;

  const onBaseline = current === baseline;
  const objectiveDelta = onBaseline ? undefined : formatDeltaM(current.objective - baseObjective) ?? undefined;
  const capitalUsedDelta = onBaseline ? undefined : formatDeltaM(capitalUsed - baseCapitalUsed) ?? undefined;
  const nonrenewUsedDelta = onBaseline ? undefined : formatDeltaM(nonrenewUsedTiv - baseNonrenewUsed) ?? undefined;

  // Slider ranges. The cession budget can scale up to 2× the original
  // baseline (or 0.5% of total TIV — whichever is larger) so the operator
  // has headroom but not so much that the slider becomes uninformative.
  const cessionMax = Math.max(baselineBudgets.cession_budget * 2, totalTiv * 0.005);
  const capitalMax = Math.max(baselineBudgets.capital_budget * 2, totalTiv * 0.1);

  return (
    <div className="flex flex-col gap-4 mb-4">
      <div>
        <PortfolioHeader
          totalTiv={totalTiv}
          objective={current.objective}
          capitalUsed={capitalUsed}
          capitalBudget={current.budgets.capital_budget}
          nonrenewUsedTiv={nonrenewUsedTiv}
          nonrenewCapTiv={nonrenewCapTiv}
          cessionSpend={cessionSpend}
          cessionBudget={current.budgets.cession_budget}
          horizonStart={current.horizon_start}
          horizonEnd={current.horizon_end}
          objectiveDelta={objectiveDelta}
          capitalUsedDelta={capitalUsedDelta}
          nonrenewUsedDelta={nonrenewUsedDelta}
          persona={persona}
          rolLayers={rolLayers}
          crps={crps}
          saaGap={saaGap}
          vrpDemand={vrpDemand}
        />
        {personaConfig.quickLinks.length > 0 && (
          <div
            data-testid="persona-quick-links"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 -mt-2 mb-1 text-[11.5px]"
            aria-label="Persona quick-links"
          >
            <span className="text-[10px] uppercase tracking-[0.12em] font-medium text-zinc-500">
              Drill-in
            </span>
            {personaConfig.quickLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-emerald-800 hover:text-emerald-900 underline-offset-2 hover:underline decoration-emerald-300"
              >
                {link.label}
              </Link>
            ))}
          </div>
        )}
      </div>
      {personaConfig.whatIfRail && (
      <aside
        data-testid="whatif-rail"
        className="rounded-md bg-white ring-1 ring-zinc-200/70 shadow-[0_1px_0_rgba(24,24,27,0.03)] px-5 py-4"
        aria-label="What-if budget controls"
      >
        {/* Task P2.20 — relocated from a 300px side-rail to a full-width
            horizontal bar under the KPI strip. Header row + 3-column slider
            grid restore the strip's full width and put the controls right
            above the exposure map they re-solve against. */}
        <div className="flex items-center justify-between gap-4 pb-3 mb-3 border-b hairline">
          <div className="flex items-baseline gap-3 min-w-0">
            <h2 className="text-[13px] font-semibold text-zinc-900 tracking-[-0.005em]">
              What-if
            </h2>
            <p className="text-[10.5px] uppercase tracking-[0.08em] text-zinc-500">
              Re-solve the MIP
            </p>
            <p className="hidden md:block text-[10.5px] text-zinc-400 leading-snug truncate">
              · Server-side 5-min TTL cache deduplicates identical triples
            </p>
          </div>
          <div className="flex items-center gap-3 flex-none">
            {solving && (
              <span
                data-testid="whatif-spinner"
                role="status"
                aria-live="polite"
                aria-label="Re-solving Portfolio MIP"
                className="inline-block h-3 w-3 rounded-full border-2 border-emerald-600 border-t-transparent animate-spin"
              />
            )}
            <TrustTierBadge tier="MODEL_OUTPUT" />
            <button
              type="button"
              onClick={onReset}
              disabled={onBaseline}
              className="text-[11px] px-2.5 py-1 rounded-md ring-1 ring-zinc-300 text-zinc-700 enabled:hover:bg-zinc-100 enabled:hover:text-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-1 divide-y md:divide-y-0 md:divide-x hairline">
          <div className="md:pr-8 md:pl-0">
            <WhatIfControl
              label="Capital budget"
              baseline={baselineBudgets.capital_budget}
              current={proposedBudgets.capital_budget}
              min={0}
              max={capitalMax}
              step={Math.max(capitalMax / 100, 1e5)}
              format={(v) => `$${(v / 1e6).toFixed(1)}M`}
              ariaLabel="Capital budget ($M)"
              disabled={solving}
              onCommit={onCapitalCommit}
              inputScale={1e6}
              inputDecimals={1}
              inputSuffix="M"
            />
          </div>

          <div className="md:px-4">
            <WhatIfControl
              label="Max non-renew %"
              baseline={baselineBudgets.max_nonrenew_pct}
              current={proposedBudgets.max_nonrenew_pct}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${(v * 100).toFixed(0)}%`}
              ariaLabel="Max non-renew percent"
              disabled={solving}
              onCommit={onNonrenewCommit}
              inputScale={0.01}
              inputDecimals={0}
              inputSuffix="%"
            />
          </div>

          <div className="md:pl-8 md:pr-0">
            <WhatIfControl
              label="Cession budget"
              baseline={baselineBudgets.cession_budget}
              current={proposedBudgets.cession_budget}
              min={0}
              max={cessionMax}
              step={Math.max(cessionMax / 100, 1e4)}
              format={(v) => `$${(v / 1e6).toFixed(2)}M`}
              ariaLabel="Cession budget ($M)"
              disabled={solving}
              onCommit={onCessionCommit}
              inputScale={1e6}
              inputDecimals={2}
              inputSuffix="M"
            />
          </div>
        </div>

        {warning && (
          <div
            data-testid="whatif-warning"
            role="alert"
            className="mt-3 text-[11px] p-2.5 rounded-md ring-1 ring-amber-300 bg-amber-50 text-amber-900"
          >
            {warning}
          </div>
        )}

        {error && (
          <div
            data-testid="whatif-error"
            role="alert"
            className="mt-3 text-[11px] p-2.5 rounded-md ring-1 ring-rose-300 bg-rose-50 text-rose-900"
          >
            Re-solve failed: {error}
          </div>
        )}
      </aside>
      )}
    </div>
  );
}
