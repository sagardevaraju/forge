/**
 * Task 19 — ZIP3 to county lookup for the Claims Pre-Brief.
 *
 * Static mapping for the 38 ZIP3s seeded by `scripts/seed_policy_book.py`
 * (FL/TX/LA/NC coastal). The Claims table groups its pre-flagged policies
 * by ZIP3 and uses this lookup to render a human-readable county label on
 * each group header. For ZIP3s outside the seed distribution we surface
 * `Unknown county` so the group still renders rather than crashing.
 *
 * County assignments are approximate — a single ZIP3 may span several
 * counties in reality. This is a demo lookup, not a regulatory geocoder;
 * the labels just need to be plausible at a glance.
 */
export const ZIP3_TO_COUNTY: Record<string, string> = {
  // Florida (13 ZIP3s in the seed distribution)
  '320': 'Duval, FL',
  '330': 'Miami-Dade, FL',
  '331': 'Miami-Dade, FL',
  '332': 'Miami-Dade, FL',
  '334': 'Polk, FL',
  '335': 'Hillsborough, FL',
  '337': 'Pinellas, FL',
  '338': 'Polk, FL',
  '339': 'Lee, FL',
  '341': 'Sarasota, FL',
  '342': 'Sarasota, FL',
  '346': 'Hernando, FL',
  '349': 'St. Lucie, FL',
  // Texas (8 ZIP3s)
  '770': 'Harris, TX',
  '774': 'Galveston, TX',
  '775': 'Galveston, TX',
  '776': 'Jefferson, TX',
  '777': 'Jefferson, TX',
  '778': 'Brazoria, TX',
  '783': 'Nueces, TX',
  '784': 'Nueces, TX',
  // Louisiana (7 ZIP3s)
  '703': 'Orleans, LA',
  '704': 'Jefferson, LA',
  '705': 'Tangipahoa, LA',
  '706': 'Calcasieu, LA',
  '707': 'Livingston, LA',
  '708': 'Ascension, LA',
  '714': 'Beauregard, LA',
  // North Carolina (10 ZIP3s)
  '275': 'Wake, NC',
  '280': 'Mecklenburg, NC',
  '281': 'Mecklenburg, NC',
  '282': 'Mecklenburg, NC',
  '283': 'Guilford, NC',
  '284': 'Cabarrus, NC',
  '285': 'Wilson, NC',
  '286': 'Wayne, NC',
  '287': 'Buncombe, NC',
  '289': 'New Hanover, NC',
};

/**
 * Resolve a ZIP3 to a county label, falling back to `Unknown county` for
 * ZIP3s outside the seeded book. Callers can still concatenate the raw
 * ZIP3 separately so the user always has *some* spatial anchor.
 */
export function zip3ToCounty(zip3: string): string {
  return ZIP3_TO_COUNTY[zip3] ?? 'Unknown county';
}
