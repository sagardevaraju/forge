/**
 * Task 3 (Redesign Phase 1) — ExecCard grammar primitive.
 *
 * The standard headline-scalar card used across the landing page, Portfolio
 * header, and Event console. Composes `TrustTierBadge` so every numbered
 * surface advertises its provenance tier without hand-rolled markup.
 *
 * Layout:
 *   ┌────────────────────────────────────┐
 *   │ LABEL (uppercase)        [ Badge ] │
 *   │ $44.5M                             │  ← headline scalar
 *   │ +$3.2M vs current                  │  ← optional delta
 *   │ p10 $38.2M – p90 $49.1M            │  ← optional confidence band
 *   └────────────────────────────────────┘
 *
 * The optional `delta` and `band` rows are omitted entirely when undefined so
 * surfaces that don't measure a band don't fake one.
 *
 * The `variant` prop scales the type: `hero` is reserved for the lead metric
 * on a page; `default` for the rest of a header strip; `compact` for
 * sub-views and footer summaries.
 */
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { InfoIcon } from '@/components/grammar/InfoTooltip';
import type { TrustTier } from '@/lib/grammar/trust-tiers';

interface ExecCardProps {
  label: string;
  value: string;
  delta?: string;
  band?: string;
  /**
   * Task P2.20 — small secondary line under the headline value. Used to
   * surface "of $X budget" context on ratio cards so the budget half doesn't
   * have to share a line with the headline number (which would force a wrap
   * mid-figure on narrow grid cells). Renders zinc-500, tabular, 11px.
   */
  caption?: string;
  /**
   * Optional glossary key. When set, an InfoIcon renders next to the label
   * so a layman can hover/click to read the definition.
   */
  term?: string;
  tier: TrustTier;
  variant?: 'hero' | 'default' | 'compact';
  className?: string;
}

function isPositiveDelta(s: string | undefined): boolean | null {
  if (!s) return null;
  if (s.includes('+$') || s.startsWith('+')) return true;
  if (s.includes('-$') || s.startsWith('-')) return false;
  return null;
}

export function ExecCard({
  label,
  value,
  delta,
  band,
  caption,
  tier,
  term,
  variant = 'default',
  className,
}: ExecCardProps) {
  const padding =
    variant === 'hero' ? 'p-5' : variant === 'compact' ? 'p-3' : 'p-4';
  const valueClass =
    variant === 'hero'
      ? 'metric-hero text-[30px] leading-[1.05] font-semibold text-zinc-900 whitespace-nowrap'
      : variant === 'compact'
        ? 'metric text-xl font-semibold text-zinc-900 whitespace-nowrap'
        : 'metric text-[22px] leading-[1.15] font-semibold text-zinc-900 whitespace-nowrap';

  const deltaSign = isPositiveDelta(delta);
  const deltaClass =
    deltaSign === true
      ? 'text-emerald-700'
      : deltaSign === false
        ? 'text-rose-700'
        : 'text-zinc-700';

  const classes = [
    'bg-white rounded-md ring-1 ring-zinc-200/70 flex flex-col gap-1.5 shadow-[0_1px_0_rgba(24,24,27,0.03)] h-full',
    padding,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div data-testid="exec-card" className={classes}>
      <div className="flex items-start justify-between gap-2 min-h-[20px]">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-zinc-500 leading-tight line-clamp-1 inline-flex items-center gap-1">
          {label}
          {term && <InfoIcon term={term} iconSize="sm" />}
        </span>
        <TrustTierBadge tier={tier} />
      </div>
      <div className="mt-auto flex flex-col gap-0.5">
        <div className={valueClass}>{value}</div>
        {caption !== undefined && (
          <div className="text-[11px] text-zinc-500 tabular-nums whitespace-nowrap">
            {caption}
          </div>
        )}
        {delta !== undefined && (
          <div className={`text-[11px] font-medium tabular-nums ${deltaClass}`}>
            {delta}
          </div>
        )}
        {band !== undefined && (
          <div className="text-[10px] text-zinc-500 tabular-nums">{band}</div>
        )}
      </div>
    </div>
  );
}
