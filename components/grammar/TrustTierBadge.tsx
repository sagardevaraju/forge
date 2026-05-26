/**
 * TrustTierBadge — provenance pill rendered next to every numbered surface.
 *
 * Pre-2026-05: used the native `title=` attribute for hover help (the
 * browser default tooltip — no styling, no keyboard reveal). This file
 * now wraps the existing pill in <InfoTooltip term={meta.glossaryKey}>
 * so Live / Model / Demo / Recommend / Override chips get the same rich
 * popup pattern as every other jargon term across the UI.
 *
 * The look of the pill itself (label, dot, color) is unchanged — only the
 * hover affordance is upgraded. Trust-tier glossary entries live in
 * `lib/grammar/glossary.ts` (Plan Task 1).
 */
import { TRUST_TIER_META, type TrustTier } from '@/lib/grammar/trust-tiers';
import { InfoTooltip } from '@/components/grammar/InfoTooltip';

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
    <InfoTooltip term={meta.glossaryKey}>
      <span data-testid="trust-tier-badge" className={classes}>
        <span aria-hidden="true" className="h-1 w-1 rounded-full bg-current opacity-70" />
        {meta.label}
      </span>
    </InfoTooltip>
  );
}
