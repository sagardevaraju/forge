/**
 * Glossary — the single source of truth for layman-friendly definitions of
 * every domain term that surfaces in the FORGE UI. Insurance, reinsurance,
 * catastrophe modeling and optimization are dense fields; a homeowner who has
 * never bought commercial coverage should be able to hover any chip, KPI label
 * or column header and read a plain-English explanation here.
 *
 * Adding a term: pick a stable kebab-case key, write a one-to-three-sentence
 * definition in everyday language, optionally add an `example` (the kind of
 * concrete number or scenario that anchors the concept) and a `source` link
 * into `/methodology` or `research.md` for the operator who wants to dig
 * further. Avoid jargon inside the definition itself — if the gloss needs
 * another acronym, link it via `[[other-key]]` inline so a future tooltip
 * renderer can deep-link.
 *
 * The lookup is keyed by string; `lookupTerm()` returns `undefined` rather
 * than throwing so a missing key never crashes a render. Callers ship
 * `term="…"` props with the canonical key and the renderer falls back to the
 * bare label if no entry exists.
 */

export interface GlossaryEntry {
  /** Short, human-readable display label (Title Case). */
  label: string;
  /** Plain-English definition — first sentence is the elevator pitch. */
  definition: string;
  /**
   * Optional anchor example or rule of thumb. Rendered as a separate paragraph
   * after the definition so the reader can pin the concept to a number.
   */
  example?: string;
  /**
   * Optional deep-link slug into `/methodology#{source}`. The methodology page
   * carries the full citation chain; tooltips just hint that more is available.
   * Slugs in use today: `mip`, `treaty`, `risk-measures`. Plan Task 17 wires
   * matching `id=` anchors into `app/methodology/page.tsx`; until then the
   * deep-links 404 the anchor (page still loads). Keep this list in sync.
   */
  source?: string;
}

const ENTRIES = {
  // ─── Insurance fundamentals ────────────────────────────────────────────
  tiv: {
    label: 'TIV',
    definition:
      'Total Insurable Value — the dollar amount of property the insurer would have to replace if everything covered by the policy were destroyed.',
    example: 'A $500K home with $200K of contents is $700K TIV.',
  },
  'book-tiv': {
    label: 'Book TIV',
    definition:
      'Sum of Total Insurable Value across every policy the company has in force — the insurer\'s aggregate dollar exposure.',
    example: 'A $4.5B book means total coverage of $4.5B across all policies.',
  },
  policy: {
    label: 'Policy',
    definition:
      'A single insurance contract between the insurer and one customer — one homeowner = one policy.',
  },
  policies: {
    label: 'Policies',
    definition:
      'Individual insurance contracts. A policy book of 10,000 policies represents 10,000 separately-insured properties.',
  },
  premium: {
    label: 'Premium',
    definition:
      'The price the customer pays the insurer for coverage, usually annual.',
  },
  cession: {
    label: 'Cession',
    definition:
      'Passing part of a policy\'s risk (and the matching premium) to a reinsurer. The insurer keeps less risk but also less profit.',
  },
  'projected-cession-spend': {
    label: 'Projected cession spend',
    definition:
      'How much the optimizer expects the company to pay reinsurers next year to take on the ceded slice of risk.',
    source: 'mip',
  },
  reinsurance: {
    label: 'Reinsurance',
    definition:
      'Insurance for insurers. A reinsurer agrees to cover part of the original insurer\'s losses in exchange for a share of the premium.',
  },
  treaty: {
    label: 'Treaty',
    definition:
      'The umbrella reinsurance contract. It defines which policies are covered, how losses are split, and what the reinsurer is paid.',
    source: 'treaty',
  },
  cedant: {
    label: 'Cedant',
    definition:
      'The original insurer in a reinsurance deal — the one ceding (handing off) part of the risk.',
  },
  retention: {
    label: 'Retention',
    definition:
      'The portion of risk the insurer keeps for itself after reinsurance. The opposite of cession.',
  },
  'quota-share': {
    label: 'Quota share (QS)',
    definition:
      'A reinsurance treaty where the reinsurer takes a fixed percentage of every policy — say 30 % of premiums and 30 % of losses.',
    example: 'In a 50% QS, every $1 loss is split 50/50 between insurer and reinsurer.',
    source: 'treaty',
  },
  'excess-of-loss': {
    label: 'Excess of loss (XS)',
    definition:
      'A reinsurance layer that only pays once losses cross a threshold. Below the threshold the insurer keeps everything; above it, the reinsurer pays up to a ceiling.',
    example: '$50M xs $20M means the reinsurer covers losses between $20M and $70M.',
    source: 'treaty',
  },
  attachment: {
    label: 'Attachment',
    definition:
      'The dollar threshold where an excess-of-loss layer starts paying. Losses below this are still the insurer\'s problem.',
    source: 'treaty',
  },
  exhaustion: {
    label: 'Exhaustion',
    definition:
      'The dollar ceiling where a reinsurance layer stops paying. Anything above goes back to the insurer or up to the next layer.',
    source: 'treaty',
  },
  'rate-on-line': {
    label: 'Rate-on-line (RoL)',
    definition:
      'The reinsurer\'s premium expressed as a percentage of the layer size. A $50M xs $20M layer at 10 % RoL costs $5M.',
    example: 'High RoL (e.g. 25%) signals a risky layer the reinsurer expects to pay often.',
    source: 'treaty',
  },
  reinstatement: {
    label: 'Reinstatement',
    definition:
      'A "refill" of a reinsurance layer after one loss exhausts it. Most treaties grant a fixed number of reinstatements per year; each one is paid for.',
    source: 'treaty',
  },
  fronting: {
    label: 'Fronting',
    definition:
      'A licensed insurer issues the policy on paper but immediately reinsures most of the risk back to a captive or other carrier — useful when the real risk-taker can\'t legally write the policy directly.',
  },
  'fronting-fee': {
    label: 'Fronting fee',
    definition:
      'Percentage of premium the fronting carrier keeps for lending its license and balance sheet — typically 3–6 %.',
  },
  captive: {
    label: 'Captive',
    definition:
      'A reinsurance company owned by the same parent as the original insurer. The group is effectively insuring itself.',
  },
  ils: {
    label: 'ILS / Cat Bond',
    definition:
      'Insurance-Linked Security. Capital-markets investors put money in a trust that pays the insurer if a disaster hits and pays the investors a coupon otherwise.',
  },
  upr: {
    label: 'UPR',
    definition:
      'Unearned Premium Reserve — premium the insurer has been paid but not yet "earned" because the coverage period hasn\'t finished. Sits on the balance sheet as a liability.',
  },
  'loss-ratio': {
    label: 'Loss ratio',
    definition:
      'Claims paid out divided by premium taken in. A 70 % loss ratio means $0.70 of every premium dollar went to claims.',
  },

  // ─── Catastrophe modeling ──────────────────────────────────────────────
  peril: {
    label: 'Peril',
    definition:
      'A specific kind of hazard — hurricane, wildfire, hail, winter storm, earthquake, flood, severe convective storm.',
  },
  hazard: {
    label: 'Hazard',
    definition:
      'The physical danger a property faces (wind speed, flood depth, ground shaking). Distinct from "exposure", which is what\'s in harm\'s way.',
  },
  exposure: {
    label: 'Exposure',
    definition:
      'The value at risk in a given area — usually summed TIV inside a footprint or geography.',
  },
  severity: {
    label: 'Severity',
    definition:
      'How bad the peril is at a given point. Higher severity → larger fraction of the property\'s value is destroyed.',
  },
  intensity: {
    label: 'Intensity',
    definition:
      'A numeric measure of severity — hail size in mm, earthquake magnitude, wind speed, dNBR burn ratio.',
  },
  footprint: {
    label: 'Footprint',
    definition:
      'The map area a disaster scenario affects — outside the footprint, damage is zero.',
  },
  scenario: {
    label: 'Scenario',
    definition:
      'A single simulated disaster event with a footprint and a severity at each point. Used to compute potential losses.',
  },
  'simulation-promoted': {
    label: 'Promoted simulation',
    definition:
      'A scenario the user marked "ready for decisions" — once promoted, it feeds the Portfolio MIP\'s joint TVaR calculation.',
  },
  'unresolved-simulation': {
    label: 'Unresolved simulation',
    definition:
      'A promoted scenario that hasn\'t yet been included in the latest portfolio optimization solve. Re-optimize to refresh.',
  },

  // ─── Risk measures ─────────────────────────────────────────────────────
  var: {
    label: 'VaR',
    definition:
      'Value at Risk. A loss threshold at a given probability — VaR-α is the loss level you only exceed (1 − α) of the time. VaR-99 = the loss you exceed 1 % of the time.',
    source: 'risk-measures',
  },
  'p99': {
    label: 'p99',
    definition:
      '99th percentile. The loss you exceed 1 in every 100 simulated years. Same as VaR-99.',
    source: 'risk-measures',
  },
  tvar: {
    label: 'TVaR',
    definition:
      'Tail Value at Risk. The average loss across the worst 1 % of scenarios — not just the threshold, but how bad it gets once you cross it.',
    example: 'p99 says "the worst 1% start at $100M". TVaR-99 says "across that worst 1%, you actually lose $180M on average".',
    source: 'risk-measures',
  },
  'tvar-99': {
    label: 'TVaR-99',
    definition:
      'Mean of losses in the worst 1 % of simulated outcomes. A coherent risk measure — splitting a portfolio in two never inflates its total TVaR.',
    source: 'risk-measures',
  },
  'tail-exposure': {
    label: 'Tail exposure',
    definition:
      'The size of the catastrophic tail (TVaR-99) the company keeps on its own balance sheet after reinsurance.',
    source: 'risk-measures',
  },
  'retained-tail': {
    label: 'Retained tail',
    definition:
      'The portion of tail losses the company keeps after ceding to reinsurance. The Portfolio MIP caps this with a capital budget.',
  },
  'expected-loss': {
    label: 'Expected loss',
    definition:
      'The mean predicted dollar loss for a policy or cohort across the loss distribution. Not the worst case, just the average.',
  },
  'expected-margin': {
    label: 'Expected margin',
    definition:
      'Projected profit — premium minus expected losses, expenses and cession spend.',
  },

  // ─── Optimization ──────────────────────────────────────────────────────
  cohort: {
    label: 'Cohort',
    definition:
      'A group of similar policies treated as one unit by the optimizer. Cohorts share a ZIP3, building type, and TIV size bucket.',
    example: 'Cohort "330_wood_frame_q3" = all wood-frame policies in ZIP3 330 in the 4th-largest TIV quintile.',
  },
  'mip': {
    label: 'MIP',
    definition:
      'Mixed-Integer Program — an optimization problem where some choices are 0/1 (which action per cohort) and others are continuous. Solved with branch-and-cut.',
  },
  'portfolio-mip': {
    label: 'Portfolio MIP',
    definition:
      'The big optimization that picks one underwriting action per cohort to maximize expected margin under capital, non-renew and cession budget constraints.',
    source: 'mip',
  },
  'mip-status': {
    label: 'MIP status',
    definition:
      'The solver\'s verdict. Optimal = a valid solution maximizing margin. Infeasible = no solution satisfies every constraint. Time-limit = best so far.',
  },
  objective: {
    label: 'Objective',
    definition:
      'The number the optimizer maximizes — here, expected margin in dollars.',
  },
  infeasible: {
    label: 'Infeasible',
    definition:
      'No combination of actions satisfies every constraint simultaneously. Usually means the capital budget is too tight or the non-renew cap too low.',
  },
  binding: {
    label: 'Binding constraint',
    definition:
      'A constraint sitting at its limit — relaxing it would improve the objective. The opposite is "slack" (room to spare).',
  },
  'capital-budget': {
    label: 'Capital budget',
    definition:
      'The maximum tail risk (TVaR-99) the company is willing to keep on its own balance sheet across all cohorts combined.',
  },
  'non-renew-cap': {
    label: 'Non-renew cap',
    definition:
      'The largest fraction of the book (by TIV) the company will let the optimizer drop at renewal. Acts as a brake against mass non-renewal.',
  },
  'cession-budget': {
    label: 'Cession budget',
    definition:
      'The largest dollar amount the company will spend on reinsurance premiums per year.',
  },
  retain: {
    label: 'Retain',
    definition:
      'Keep the policy at current terms. The default action — no rate change, no cession.',
  },
  'reprice': {
    label: 'Reprice',
    definition:
      'Adjust the policy\'s rate at renewal. FORGE uses a seven-bucket grid (−20 %, −10 %, 0 %, +5 %, +10 %, +15 %, +20 %).',
  },
  'non-renew': {
    label: 'Non-renew',
    definition:
      'Decline to renew the policy at expiration. Subject to a state-required notice period and a portfolio-wide cap.',
  },
  'cede-qs': {
    label: 'Cede to QS',
    definition:
      'Pass this cohort\'s premium and losses through the quota-share treaty — the reinsurer takes a fixed percentage of both.',
  },
  'cede-xs': {
    label: 'Cede to XS',
    definition:
      'Pass this cohort\'s tail losses through an excess-of-loss layer — the reinsurer only pays once losses exceed the attachment point.',
  },
  elasticity: {
    label: 'Price elasticity',
    definition:
      'How much customers walk away when prices rise. A 0.5 elasticity means a 10 % rate hike loses about 5 % of the customers.',
  },
  'pareto-frontier': {
    label: 'Efficient (Pareto) frontier',
    definition:
      'The set of budget combinations where no choice strictly dominates another — improving one outcome always costs you another.',
  },
  'pareto-sweep': {
    label: 'Pareto sweep',
    definition:
      'Re-solve the optimizer at a small grid of capital × cession budget multipliers (e.g. 0.7×, 1.0×, 1.5×) to chart the tradeoff curve.',
  },
  'infeasible-relaxed': {
    label: 'Infeasible (relaxed)',
    definition:
      'The exact constraints had no solution, but a small loosening (e.g. 20 % more capital) does. Shown so operators can see how close to feasibility a cell sits.',
  },

  // ─── Trust tiers ──────────────────────────────────────────────────────
  'live-feed': {
    label: 'Live',
    definition:
      'Fetched right now from an authoritative external source (NHC, NWS, FIRMS). Trust tier is highest.',
  },
  'model-output': {
    label: 'Model',
    definition:
      'Produced by an internal optimizer or ML model. Trust depends on calibration quality.',
  },
  'synthetic-scaffold': {
    label: 'Demo',
    definition:
      'Synthetic / demo data shown when no live source is available. Useful for shape but not for decisions.',
  },
  recommendation: {
    label: 'Recommendation',
    definition:
      'The system\'s suggested action — not yet acted on by a human operator.',
  },
  'manual-override': {
    label: 'Manual override',
    definition:
      'A human operator has overridden the model. The override sticks until manually cleared and is logged in the audit ledger.',
  },

  // ─── Geography ─────────────────────────────────────────────────────────
  zip3: {
    label: 'ZIP3',
    definition:
      'The first three digits of a US ZIP code — a coarse geographic bucket the company groups policies into for risk pricing.',
    example: 'ZIP3 330 covers parts of Miami-Dade, FL. About one million households per ZIP3.',
  },
  'flood-zone': {
    label: 'FEMA flood zone',
    definition:
      'FEMA\'s official flood-risk designations. A and AE = 1-in-100-year floodplain. V and VE = coastal velocity zone (waves). X = minimal risk.',
  },
  'flood-zone-ae': {
    label: 'AE zone',
    definition:
      'A 1-in-100-year (1 % annual chance) floodplain with established base flood elevation. Lenders require flood insurance here.',
  },
  'flood-zone-ve': {
    label: 'VE zone',
    definition:
      'Coastal velocity zone — 1 % annual chance of flooding plus wave action. The highest FEMA flood-risk tier.',
  },
  'tiv-quintile': {
    label: 'TIV quintile',
    definition:
      'Each policy in the book is ranked by TIV and binned into one of five equal-size groups: q0 (smallest) to q4 (largest).',
  },
  'build-type': {
    label: 'Build type',
    definition:
      'Structural classification — wood frame, masonry, concrete, manufactured. Drives baseline damage ratios in HAZUS.',
  },
  'wood-frame': {
    label: 'Wood frame',
    definition:
      'Stick-built with wood studs. Most common US residential construction. Higher wind / earthquake vulnerability than masonry.',
  },
  masonry: {
    label: 'Masonry',
    definition:
      'Brick or concrete-block exterior walls. More wind- and fire-resistant than wood frame, costlier to repair when damaged.',
  },
  manufactured: {
    label: 'Manufactured',
    definition:
      'Factory-built modular or mobile homes. High vulnerability to wind, flood, and tornado per HAZUS depth-damage curves.',
  },

  // ─── Hurricane operations ──────────────────────────────────────────────
  nhc: {
    label: 'NHC',
    definition:
      'National Hurricane Center — the NOAA office that issues authoritative tropical-storm forecasts.',
  },
  'nhc-cone': {
    label: 'NHC cone',
    definition:
      'The forecast cone of uncertainty — about two-thirds of historical storms stay inside the cone for the next 5 days.',
  },
  'cone-exposure': {
    label: 'Cone exposure',
    definition:
      'Total TIV inside the NHC forecast cone — the dollar value of policies in the storm\'s plausible path.',
  },
  'stochastic-exposure': {
    label: 'Stochastic exposure',
    definition:
      'Expected TIV across thousands of simulated storm tracks sampled around the official cone — captures track uncertainty more honestly than one polygon.',
  },
  advisory: {
    label: 'Advisory',
    definition:
      'An NHC update on a storm — issued every 3–6 hours. The "advisory number" tells you which update you\'re reading.',
  },
  'peak-wind': {
    label: 'Peak wind',
    definition:
      'The highest sustained wind speed forecast inside the cone. Drives damage estimates for wood-frame and masonry structures.',
  },
  'storm-surge': {
    label: 'Storm surge',
    definition:
      'Sea water pushed inland by a hurricane\'s winds — often the costliest peril of a landfalling storm.',
  },
  gefs: {
    label: 'GEFS ensemble',
    definition:
      'Global Ensemble Forecast System — 31 perturbed weather model runs whose spread quantifies forecast uncertainty.',
  },
  firms: {
    label: 'FIRMS',
    definition:
      'NASA\'s Fire Information for Resource Management System — near-real-time satellite detections of active wildfires.',
  },
  nws: {
    label: 'NWS',
    definition:
      'National Weather Service — issues real-time alerts for tornadoes, floods, severe thunderstorms.',
  },
  sitrep: {
    label: 'Situation report',
    definition:
      'A short operational memo on the current threat — drafted by the AI advisor and reviewable by the cat-ops desk.',
  },

  // ─── Peril intensity scales ────────────────────────────────────────────
  'ef-scale': {
    label: 'Enhanced Fujita scale',
    definition:
      'Tornado intensity 0–5 based on observed damage. EF3 = severe (165+ mph), EF5 = total devastation.',
  },
  'mw-magnitude': {
    label: 'Moment magnitude (Mw)',
    definition:
      'Modern earthquake magnitude scale. Mw 6 is strong, Mw 7 is severe, each whole step is ~32× the energy.',
  },
  mmi: {
    label: 'MMI',
    definition:
      'Modified Mercalli Intensity — how strongly shaking is felt at a location (I = imperceptible, X = total destruction).',
  },
  dnbr: {
    label: 'dNBR',
    definition:
      'differenced Normalized Burn Ratio — a satellite-derived measure of wildfire burn severity. High dNBR = canopy and ground both destroyed.',
  },
  wssi: {
    label: 'WSSI',
    definition:
      'Winter Storm Severity Index — the NWS\'s 0–4 ranking of blizzard / ice / flash-freeze impact (Minor → Extreme).',
  },
  hazus: {
    label: 'HAZUS',
    definition:
      'FEMA\'s engineering loss model. Provides baseline depth-damage and wind-damage curves by building type, which FORGE scales for severity.',
  },

  // ─── Claims operations ─────────────────────────────────────────────────
  'claims-pre-brief': {
    label: 'Claims pre-brief',
    definition:
      'A pre-flagged list of policies likely to file claims after a forecast event — gives the claims desk a head start on staffing and intake.',
  },
  'adjuster-load': {
    label: 'Adjuster load',
    definition:
      'Number of insurance adjusters needed to handle expected claims in a region. Used to plan deployments.',
  },
  'notice-days': {
    label: 'Notice days',
    definition:
      'The minimum days a state requires before non-renewing a policy. Florida is 180 days, California 60–75 days, etc.',
  },
  'expected-claims': {
    label: 'Expected claims',
    definition:
      'The number of policies forecast to file claims after the event — drives field and call-center staffing.',
  },

  // ─── Statistics ────────────────────────────────────────────────────────
  'k-1000': {
    label: 'K = 1000 scenarios',
    definition:
      'Each cohort\'s loss distribution is represented by 1000 lognormal draws. Risk measures (p99, TVaR-99) are taken over this empirical set.',
  },
  lognormal: {
    label: 'Lognormal',
    definition:
      'A right-skewed probability distribution — short on the left, long fat tail on the right. Standard for insurance losses.',
  },
  percentile: {
    label: 'Percentile',
    definition:
      'A ranking — the 99th percentile is the value you exceed only 1 % of the time in your sample.',
  },
  pit: {
    label: 'PIT histogram',
    definition:
      'Probability Integral Transform — if a probabilistic forecast is well-calibrated, the PIT values are uniformly distributed. Bumps reveal miscalibration.',
  },
  crps: {
    label: 'CRPS',
    definition:
      'Continuous Ranked Probability Score — measures how close a probabilistic forecast is to the actual outcome. Lower is better.',
  },
  'reliability-diagram': {
    label: 'Reliability diagram',
    definition:
      'A chart of predicted probability vs observed frequency. Points on the diagonal = perfectly calibrated; below = overconfident.',
  },
  'quantile-head': {
    label: 'Quantile head',
    definition:
      'A model trained to predict specific quantiles (e.g. p10, p50, p90) of the loss distribution rather than a single point estimate.',
  },

  // ─── Audit ─────────────────────────────────────────────────────────────
  'append-only': {
    label: 'Append-only',
    definition:
      'Records can be added but never edited or deleted. Reversals are recorded as new entries that reference the original.',
  },
  worm: {
    label: 'WORM',
    definition:
      'Write Once, Read Many — a database write mode where rows cannot be updated after insert. Underpins audit-grade evidence.',
  },
  'audit-ledger': {
    label: 'Audit ledger',
    definition:
      'The append-only record of every decision and AI conversation — the trail SOC 2 auditors and regulators inspect.',
  },

  // ─── Personas ──────────────────────────────────────────────────────────
  persona: {
    label: 'Persona',
    definition:
      'A pre-set view of the dashboard tuned to a role — Actuary, Cat-Ops, Reinsurance Buyer, Field Ops, Academic. Personas only change the lens, not the underlying data.',
  },
} as const;

export type GlossaryKey = keyof typeof ENTRIES;

/** Strongly-typed lookup. Returns undefined for unknown keys. */
export function lookupTerm(key: string): GlossaryEntry | undefined {
  return (ENTRIES as Record<string, GlossaryEntry>)[key];
}

/** Whole map (for tests and for the methodology page's glossary index). */
export const GLOSSARY: Record<GlossaryKey, GlossaryEntry> = ENTRIES;
