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
 *
 * Task P2.13 (Phase 2) — three optional `*Delta` props let the what-if
 * shell render a `+$3.3M vs baseline`-style sub-line under the headline
 * scalars after the user re-solves the MIP with perturbed budgets. The
 * shell is responsible for computing the deltas; this component stays
 * formatting-only.
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
  /**
   * Task 24 — treaty-year horizon (ISO ``YYYY-MM-DD``). Rendered as a
   * caption above the ExecCard strip so the viewer knows the recommendation
   * is dated to a treaty cycle, not an open-ended forecast. Both must be
   * provided to render the line; either missing → caption is suppressed.
   */
  horizonStart?: string;
  horizonEnd?: string;
  /**
   * Task P2.13 — optional delta strings rendered under the headline scalar.
   * Provided by the what-if shell when the user has re-solved the MIP with a
   * different budget triple; undefined when we're on the original solve, so
   * the strip looks identical to its Phase 1 baseline.
   */
  objectiveDelta?: string;
  capitalUsedDelta?: string;
  nonrenewUsedDelta?: string;
}

const $M = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const $B = (n: number) => `$${(n / 1e9).toFixed(2)}B`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format an ISO ``YYYY-MM-DD`` (or ``YYYY-MM``) string as ``"Mon YYYY"``.
 * Returns ``null`` if the input doesn't match — defensive against stale
 * artifacts that pre-date Task 24.
 */
function formatHorizonLabel(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = m[1];
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${MONTHS[monthIdx]} ${year}`;
}

export function PortfolioHeader(p: Props) {
  const startLabel = p.horizonStart ? formatHorizonLabel(p.horizonStart) : null;
  const endLabel = p.horizonEnd ? formatHorizonLabel(p.horizonEnd) : null;
  const treatyYear = startLabel && endLabel ? `${startLabel} – ${endLabel}` : null;
  return (
    <div className="mb-4">
      {treatyYear && (
        <p
          className="text-xs uppercase tracking-wider text-neutral-500 mb-2"
          aria-label="Treaty horizon"
        >
          Treaty year: {treatyYear}
        </p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <ExecCard label="Total TIV" value={$B(p.totalTiv)} tier="SYNTHETIC_SCAFFOLD" />
        <ExecCard
          label="Expected margin"
          value={$M(p.objective)}
          delta={p.objectiveDelta}
          tier="RECOMMENDATION"
        />
        <ExecCard
          label="Capital used / budget"
          value={`${$M(p.capitalUsed)} / ${$M(p.capitalBudget)}`}
          delta={p.capitalUsedDelta}
          tier="MODEL_OUTPUT"
        />
        <ExecCard
          label="Non-renew used / cap"
          value={`${$M(p.nonrenewUsedTiv)} / ${$M(p.nonrenewCapTiv)}`}
          delta={p.nonrenewUsedDelta}
          tier="RECOMMENDATION"
        />
        <ExecCard
          label="Cession spend / budget"
          value={`${$M(p.cessionSpend)} / ${$M(p.cessionBudget)}`}
          tier="MODEL_OUTPUT"
        />
      </div>
    </div>
  );
}
