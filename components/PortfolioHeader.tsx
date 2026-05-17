/**
 * Task 9 (Redesign Phase 1) — Portfolio header ExecCard strip.
 *
 * Five-card headline strip mounted above the Portfolio Map. Surfaces the
 * book-level scalars the carrier scoreboard cares about — total exposure,
 * the MIP's expected margin, and the three budget constraints (capital,
 * non-renewal cap, cession spend) — each tagged with its trust tier so the
 * viewer can tell SYNTHETIC scaffolding (the book itself) apart from MIP
 * RECOMMENDATIONs and MODEL_OUTPUTs in one glance.
 *
 * Pure presentational: the page server-component computes the eight props
 * from `aggregateCohorts()` + `loadPortfolioOptimization()` and passes
 * fully-formed numbers in. Formatting is done here so the strip stays
 * consistent across callers.
 */
import { ExecCard } from '@/components/grammar/ExecCard';

interface Props {
  totalTiv: number;
  objective: number;
  capitalUsed: number;
  capitalBudget: number;
  nonrenewUsedTiv: number;
  nonrenewCapTiv: number;
  cessionSpend: number;
  cessionBudget: number;
}

const $M = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const $B = (n: number) => `$${(n / 1e9).toFixed(2)}B`;

export function PortfolioHeader(p: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
      <ExecCard label="Total TIV" value={$B(p.totalTiv)} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard label="Expected margin" value={$M(p.objective)} tier="RECOMMENDATION" />
      <ExecCard
        label="Capital used / budget"
        value={`${$M(p.capitalUsed)} / ${$M(p.capitalBudget)}`}
        tier="MODEL_OUTPUT"
      />
      <ExecCard
        label="Non-renew used / cap"
        value={`${$M(p.nonrenewUsedTiv)} / ${$M(p.nonrenewCapTiv)}`}
        tier="RECOMMENDATION"
      />
      <ExecCard
        label="Cession spend / budget"
        value={`${$M(p.cessionSpend)} / ${$M(p.cessionBudget)}`}
        tier="MODEL_OUTPUT"
      />
    </div>
  );
}
