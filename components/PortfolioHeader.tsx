/**
 * Task 9 (Redesign Phase 1) — Portfolio header ExecCard strip.
 * Task P2.18 (Phase 2) — persona-tuned cards.
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
 *
 * Task P2.18 (Phase 2) — `persona` prop selects which ExecCards render.
 * `lib/persona/config.ts::getPersonaConfig(persona).cards` is the
 * single-source-of-truth ordering. Cards that don't have wired data yet
 * (CRPS pending P2.16, SAA gap pending P2.9, VRP demand pending the
 * operational LP integration) render with `SYNTHETIC_SCAFFOLD`.
 */
import { ExecCard } from '@/components/grammar/ExecCard';
import {
  type Persona,
  type PersonaCardKind,
  getPersonaConfig,
} from '@/lib/persona/config';

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
  /**
   * Task P2.18 — persona lens. Selects which ExecCards render and in what
   * order via `getPersonaConfig(persona).cards`. Defaults to `cat-ops` so
   * existing callers that don't pass the prop keep the Phase 1 layout.
   */
  persona?: Persona;
  /**
   * Task P2.18 — optional treaty layers for the RoL-by-layer card surfaced
   * to the Reinsurance persona. When omitted, the card renders a
   * `SYNTHETIC_SCAFFOLD` placeholder. Caller is responsible for pulling
   * this from `artifacts/treaty.json`.
   */
  rolLayers?: { type: string; rol: number; attachment?: number }[];
  /**
   * Task P2.18 — optional CRPS scalar for the Actuary persona's CRPS card.
   * Absent until P2.16 surfaces a real CRPS in the calibration artifact; in
   * the meantime the card renders as `SYNTHETIC_SCAFFOLD`.
   */
  crps?: number;
  /**
   * Task P2.18 — optional SAA optimality gap (fraction, 0..1) for the
   * Academic persona's gap card. Absent until P2.9 writes `gap` into the
   * portfolio optimization artifact; until then the card renders as
   * `SYNTHETIC_SCAFFOLD`.
   */
  saaGap?: number;
  /**
   * Task P2.18 — optional VRP demand-adjustment scalar for Field-ops. Until
   * the operational LP exposes a real `demand_adjustments` field, the card
   * renders as `SYNTHETIC_SCAFFOLD`.
   */
  vrpDemand?: number;
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

/**
 * Format treaty layers as a compact RoL summary. Renders one chip per layer
 * — `QS 18% · XS 10% · XS 6%` — with the percent rounded to whole numbers
 * for the headline card. The Reinsurance treaty view is the place to drill
 * into per-layer detail; this is the at-a-glance scoreboard line.
 */
function formatRolLayers(layers: { type: string; rol: number; attachment?: number }[]): string {
  if (!layers || layers.length === 0) return '—';
  return layers
    .map((l) => `${l.type.toUpperCase()} ${(l.rol * 100).toFixed(0)}%`)
    .join(' · ');
}

function renderCard(kind: PersonaCardKind, p: Props) {
  switch (kind) {
    case 'total_tiv':
      return (
        <ExecCard
          key={kind}
          label="Total TIV"
          value={$B(p.totalTiv)}
          tier="SYNTHETIC_SCAFFOLD"
        />
      );
    case 'expected_margin':
      return (
        <ExecCard
          key={kind}
          label="Expected margin"
          value={$M(p.objective)}
          delta={p.objectiveDelta}
          tier="RECOMMENDATION"
        />
      );
    case 'tvar_99':
      // The portfolio artifact ships `book_totals.loss_p99` (VaR-99) rather
      // than a proper TVaR-99. Per the P2.18 spec we surface it under the
      // TVaR-99 label for the Actuary lens until P2.10 supplies the real
      // tail expectation — the trust tier stays MODEL_OUTPUT because the
      // number IS the model's output, just a different tail statistic.
      return (
        <ExecCard
          key={kind}
          label="TVaR-99"
          value={$M(p.capitalUsed)}
          tier="MODEL_OUTPUT"
        />
      );
    case 'crps':
      return (
        <ExecCard
          key={kind}
          label="CRPS"
          value={p.crps != null ? p.crps.toFixed(3) : '—'}
          tier="SYNTHETIC_SCAFFOLD"
        />
      );
    case 'capital_used':
      return (
        <ExecCard
          key={kind}
          label="Capital used / budget"
          value={`${$M(p.capitalUsed)} / ${$M(p.capitalBudget)}`}
          delta={p.capitalUsedDelta}
          tier="MODEL_OUTPUT"
        />
      );
    case 'nonrenew_used':
      return (
        <ExecCard
          key={kind}
          label="Non-renew used / cap"
          value={`${$M(p.nonrenewUsedTiv)} / ${$M(p.nonrenewCapTiv)}`}
          delta={p.nonrenewUsedDelta}
          tier="RECOMMENDATION"
        />
      );
    case 'cession_spend':
      return (
        <ExecCard
          key={kind}
          label="Cession spend / budget"
          value={`${$M(p.cessionSpend)} / ${$M(p.cessionBudget)}`}
          tier="MODEL_OUTPUT"
        />
      );
    case 'rol_by_layer':
      return (
        <ExecCard
          key={kind}
          label="RoL by layer"
          value={formatRolLayers(p.rolLayers ?? [])}
          tier={p.rolLayers && p.rolLayers.length > 0 ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD'}
        />
      );
    case 'retained_tail':
      // After XS reinsurance attaches, the carrier's retained tail above the
      // attachment point ≈ 0. We approximate with min(loss_p99, top XS
      // attachment) when layers are present; otherwise fall back to the
      // raw VaR-99 figure under SYNTHETIC_SCAFFOLD.
      {
        const attachments = (p.rolLayers ?? [])
          .map((l) => l.attachment)
          .filter((a): a is number => typeof a === 'number');
        const minAttach = attachments.length ? Math.min(...attachments) : null;
        const retained = minAttach != null ? Math.min(p.capitalUsed, minAttach) : p.capitalUsed;
        return (
          <ExecCard
            key={kind}
            label="Retained tail (post-XS)"
            value={$M(retained)}
            tier={minAttach != null ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD'}
          />
        );
      }
    case 'vrp_demand':
      return (
        <ExecCard
          key={kind}
          label="VRP demand adj."
          value={p.vrpDemand != null ? `${p.vrpDemand > 0 ? '+' : ''}${p.vrpDemand}` : '—'}
          tier="SYNTHETIC_SCAFFOLD"
        />
      );
    case 'saa_gap':
      return (
        <ExecCard
          key={kind}
          label="SAA optimality gap"
          value={p.saaGap != null ? `${(p.saaGap * 100).toFixed(2)}%` : '—'}
          tier="SYNTHETIC_SCAFFOLD"
        />
      );
  }
}

export function PortfolioHeader(p: Props) {
  const startLabel = p.horizonStart ? formatHorizonLabel(p.horizonStart) : null;
  const endLabel = p.horizonEnd ? formatHorizonLabel(p.horizonEnd) : null;
  const treatyYear = startLabel && endLabel ? `${startLabel} – ${endLabel}` : null;
  const persona = p.persona ?? 'cat-ops';
  const config = getPersonaConfig(persona);
  // The cat-ops baseline renders exactly 5 cards in a single row. Other
  // personas may surface 6 cards (one extra); the grid spans 5 columns on
  // wide screens so the overflow wraps cleanly onto a second row rather
  // than crushing the headline strip.
  return (
    <div className="mb-4" data-testid="portfolio-header" data-persona={persona}>
      {treatyYear && (
        <p
          className="text-xs uppercase tracking-wider text-neutral-500 mb-2"
          aria-label="Treaty horizon"
        >
          Treaty year: {treatyYear}
        </p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {config.cards.map((kind) => renderCard(kind, p))}
      </div>
    </div>
  );
}
