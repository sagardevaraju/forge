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
 */
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import type { TrustTier } from '@/lib/grammar/trust-tiers';

interface ExecCardProps {
  label: string;
  value: string;
  delta?: string;
  band?: string;
  tier: TrustTier;
  className?: string;
}

export function ExecCard({ label, value, delta, band, tier, className }: ExecCardProps) {
  const classes = ['border rounded p-3 bg-white flex flex-col gap-1', className]
    .filter(Boolean)
    .join(' ');
  return (
    <div data-testid="exec-card" className={classes}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-600 uppercase tracking-wide">{label}</span>
        <TrustTierBadge tier={tier} />
      </div>
      <div className="text-2xl font-semibold text-zinc-900">{value}</div>
      {delta !== undefined && <div className="text-xs text-zinc-700">{delta}</div>}
      {band !== undefined && <div className="text-[10px] text-zinc-500">{band}</div>}
    </div>
  );
}
