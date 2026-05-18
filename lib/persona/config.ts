/**
 * Task P2.18 (Redesign Phase 2) — Persona configuration.
 *
 * Single source of truth for the five persona lenses surfaced by the
 * PersonaToggle. Pages read `getPersonaConfig(persona)` to discover which
 * ExecCards to render, which quick-links to surface, and what what-if rail
 * the view exposes. URL state (`?persona=<id>`) is the only place a chosen
 * persona is stored — see `components/grammar/PersonaToggle.tsx` and
 * `components/PortfolioPersonaScope.tsx` for the read/write seam.
 *
 * Personas are NOT route trees. We deliberately route through a single
 * `persona` prop so a single page component renders all five views — the
 * trade-off being a ~5× test surface for a tuned-per-archetype view rather
 * than a single compromise.
 *
 * Cards whose data isn't yet wired live (CRPS pending P2.16's artifact
 * surfacing, SAA gap pending P2.9's `gap` field, VRP demand pending the
 * operational LP integration) render with `SYNTHETIC_SCAFFOLD` and the
 * `synthetic: true` flag set here. Provenance disclosure is the discipline,
 * not faked numbers as MODEL_OUTPUT.
 */

export type Persona =
  | 'cat-ops'
  | 'actuary'
  | 'reinsurance'
  | 'field-ops'
  | 'academic';

export const PERSONA_VALUES: readonly Persona[] = [
  'cat-ops',
  'actuary',
  'reinsurance',
  'field-ops',
  'academic',
] as const;

export const DEFAULT_PERSONA: Persona = 'cat-ops';

export interface PersonaMeta {
  value: Persona;
  label: string;
  /** One-line description for tooltip / a11y. */
  blurb: string;
}

export const PERSONAS: readonly PersonaMeta[] = [
  {
    value: 'cat-ops',
    label: 'Cat-ops',
    blurb:
      'Operator default — 5-card scoreboard + the three what-if budgets bound to the Portfolio MIP.',
  },
  {
    value: 'actuary',
    label: 'Actuary',
    blurb:
      'Swap margin → TVaR-99, add the CRPS calibration card, and surface the /calibration quick-link.',
  },
  {
    value: 'reinsurance',
    label: 'Reinsurance',
    blurb:
      'Swap cession → RoL-by-layer, expose the /treaty quick-link, and add the retained-tail card.',
  },
  {
    value: 'field-ops',
    label: 'Field-ops',
    blurb:
      'Add the VRP demand-adjustments card and surface the adjuster-load rollup link.',
  },
  {
    value: 'academic',
    label: 'Academic',
    blurb:
      'Add the SAA optimality-gap card and surface methodology quick-links.',
  },
] as const;

/**
 * A persona-tuned card declaration. The page (or the PortfolioWhatIfShell)
 * inspects `kind` and renders the right ExecCard variant — values are not
 * resolved here because the data lives on the optimization artifact and on
 * the calibration / treaty / reconciler caches the page already loads.
 */
export type PersonaCardKind =
  | 'total_tiv'
  | 'expected_margin'
  | 'tvar_99'
  | 'crps'
  | 'capital_used'
  | 'nonrenew_used'
  | 'cession_spend'
  | 'rol_by_layer'
  | 'retained_tail'
  | 'vrp_demand'
  | 'saa_gap';

/** A quick-link surfaced on the persona's view. */
export interface PersonaQuickLink {
  href: string;
  label: string;
}

export interface PersonaConfig {
  /** Persona id (matches the URL query value). */
  persona: Persona;
  /**
   * Ordered list of ExecCard kinds the portfolio view should render. The
   * first 5 land in the headline strip; anything beyond is rendered as a
   * secondary row below. The persona's variation against the cat-ops
   * baseline is what diverges between archetypes.
   */
  cards: PersonaCardKind[];
  /** Quick-links surfaced alongside the persona's ExecCards. */
  quickLinks: PersonaQuickLink[];
  /**
   * Whether the what-if rail (3 sliders bound to the MIP budgets) is shown.
   * Only cat-ops gets it by default — the other personas read but don't
   * perturb. We can lift this in a follow-up if Actuary / Reinsurance ask
   * for re-solves under their lens; for now they read the baseline solve.
   */
  whatIfRail: boolean;
}

const CAT_OPS_CARDS: PersonaCardKind[] = [
  'total_tiv',
  'expected_margin',
  'capital_used',
  'nonrenew_used',
  'cession_spend',
];

const ACTUARY_CARDS: PersonaCardKind[] = [
  'total_tiv',
  'tvar_99', // replaces expected_margin
  'capital_used',
  'nonrenew_used',
  'cession_spend',
  'crps', // added
];

const REINSURANCE_CARDS: PersonaCardKind[] = [
  'total_tiv',
  'expected_margin',
  'capital_used',
  'nonrenew_used',
  'rol_by_layer', // replaces cession_spend
  'retained_tail', // added
];

const FIELD_OPS_CARDS: PersonaCardKind[] = [
  'total_tiv',
  'expected_margin',
  'capital_used',
  'nonrenew_used',
  'cession_spend',
  'vrp_demand', // added
];

const ACADEMIC_CARDS: PersonaCardKind[] = [
  'total_tiv',
  'expected_margin',
  'capital_used',
  'nonrenew_used',
  'cession_spend',
  'saa_gap', // added
];

const CONFIGS: Record<Persona, PersonaConfig> = {
  'cat-ops': {
    persona: 'cat-ops',
    cards: CAT_OPS_CARDS,
    quickLinks: [],
    whatIfRail: true,
  },
  actuary: {
    persona: 'actuary',
    cards: ACTUARY_CARDS,
    quickLinks: [{ href: '/calibration', label: 'Calibration' }],
    whatIfRail: false,
  },
  reinsurance: {
    persona: 'reinsurance',
    cards: REINSURANCE_CARDS,
    quickLinks: [{ href: '/treaty', label: 'Treaty layers' }],
    whatIfRail: false,
  },
  'field-ops': {
    persona: 'field-ops',
    cards: FIELD_OPS_CARDS,
    quickLinks: [{ href: '/claims', label: 'Adjuster-load' }],
    whatIfRail: false,
  },
  academic: {
    persona: 'academic',
    cards: ACADEMIC_CARDS,
    quickLinks: [
      { href: '/methodology', label: 'Methodology' },
      { href: '/calibration', label: 'Calibration' },
    ],
    whatIfRail: false,
  },
};

export function getPersonaConfig(persona: Persona): PersonaConfig {
  return CONFIGS[persona];
}

/**
 * Parse a raw `?persona=` query value into a `Persona`. Unknown / missing
 * values fall back to `cat-ops` so a stray link never blank-renders the
 * page. Accepts `null`/`undefined` for the caller's convenience.
 */
export function parsePersona(raw: string | null | undefined): Persona {
  if (!raw) return DEFAULT_PERSONA;
  return (PERSONA_VALUES as readonly string[]).includes(raw)
    ? (raw as Persona)
    : DEFAULT_PERSONA;
}
