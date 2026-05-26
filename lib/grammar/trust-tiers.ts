/**
 * Trust-tier vocabulary — the single contract every numbered surface in FORGE
 * reconciles against. Five tiers describe the provenance of any piece of data
 * the operator sees on screen:
 *
 *   LIVE_FEED          — pulled from a live external source (NHC, FIRMS, etc.)
 *   MODEL_OUTPUT       — produced by one of our optimizers / models
 *   SYNTHETIC_SCAFFOLD — demo / mock data when no live source is available
 *   RECOMMENDATION     — a suggested action the operator has not yet acted on
 *   MANUAL_OVERRIDE    — an operator has overridden a model output
 *
 * `TRUST_TIER_META` is the single source of truth for label vocabulary,
 * Tailwind palette, and tooltip gloss. UI components must look up here rather
 * than hand-rolling pills.
 */

export type TrustTier =
  | 'LIVE_FEED'
  | 'MODEL_OUTPUT'
  | 'SYNTHETIC_SCAFFOLD'
  | 'RECOMMENDATION'
  | 'MANUAL_OVERRIDE';

export interface TrustTierMeta {
  label: string;
  className: string;
  tooltip: string;
  /** Glossary key for the InfoTooltip popup (Plan Task 6). */
  glossaryKey: string;
}

export const TRUST_TIER_META: Record<TrustTier, TrustTierMeta> = {
  LIVE_FEED: {
    label: 'Live',
    className: 'bg-green-100 text-green-800 border-green-200',
    tooltip: 'Live feed — fetched from an authoritative external source.',
    glossaryKey: 'live-feed',
  },
  MODEL_OUTPUT: {
    label: 'Model',
    className: 'bg-blue-100 text-blue-800 border-blue-200',
    tooltip: 'Model output — produced by an internal optimizer or ML model.',
    glossaryKey: 'model-output',
  },
  SYNTHETIC_SCAFFOLD: {
    label: 'Demo',
    className: 'bg-amber-100 text-amber-800 border-amber-200',
    tooltip: 'Synthetic scaffold — demo data shown when no live source is available.',
    glossaryKey: 'synthetic-scaffold',
  },
  RECOMMENDATION: {
    label: 'Recommend',
    className: 'bg-violet-100 text-violet-800 border-violet-200',
    tooltip: 'Recommendation — a suggested action awaiting operator review.',
    glossaryKey: 'recommendation',
  },
  MANUAL_OVERRIDE: {
    label: 'Override',
    className: 'bg-red-100 text-red-800 border-red-300 border-dashed',
    tooltip: 'Manual override — an operator has overridden the model output.',
    glossaryKey: 'manual-override',
  },
};
