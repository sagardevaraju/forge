/**
 * Task 1 (Redesign Phase 1) — TrustTierBadge grammar primitive.
 *
 * A pure, stateless pill that renders a trust-tier label with its tooltip and
 * Tailwind palette pulled from `lib/grammar/trust-tiers.ts`. Every later view
 * composes against this primitive instead of hand-rolling green/amber pills.
 */
import { TRUST_TIER_META, type TrustTier } from '@/lib/grammar/trust-tiers';

interface TrustTierBadgeProps {
  tier: TrustTier;
  className?: string;
}

export function TrustTierBadge({ tier, className }: TrustTierBadgeProps) {
  const meta = TRUST_TIER_META[tier];
  const classes = [
    'inline-flex items-center gap-1 px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.06em] rounded-sm',
    meta.className,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span data-testid="trust-tier-badge" title={meta.tooltip} className={classes}>
      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-current opacity-70" />
      {meta.label}
    </span>
  );
}
