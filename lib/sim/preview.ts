/**
 * Client-side single-draw preview impact for the ImpactPanel.
 *
 * Deterministic, fast, no Python round-trip. Uses turf point-in-polygon
 * on every policy + the HAZUS matrix to estimate a single gross loss
 * number. The promote path computes the *stochastic* K=1000 version
 * server-side; this module is purely for the right-pane preview.
 *
 * Cohort key matches lib/db/cohorts.ts: `{zip3}_{build_type}_q{0..4}`.
 * The preview joins on (zip3, build_type) only — quintile is not known
 * client-side without aggregating the full book. The cohort_id surfaced
 * here is the (zip3, build_type) prefix; a downstream "open cohort"
 * action upgrades to the full quintile key.
 *
 * Task 5: Client-side preview (point-in-polygon)
 */
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { damageRatio } from './severity';
import type { SimulationFootprint } from './footprint';

export interface Policy {
  id: number;
  lat: number;
  lon: number;
  tiv: number;
  build_type: string;
  zip3: string;
}

export interface CohortImpact {
  cohort_id: string;
  loss: number;
  tiv: number;
  policies: number;
}

export interface PreviewImpact {
  policies_in_footprint: number;
  tiv_in_footprint: number;
  gross_loss_estimate: number;
  mean_damage_ratio: number;
  cohorts_affected: number;
  top_cohorts: CohortImpact[];
}

export function previewImpact(
  policies: Policy[],
  footprint: SimulationFootprint,
): PreviewImpact {
  const cohorts = new Map<string, CohortImpact>();
  let policiesIn = 0;
  let tivIn = 0;
  let lossSum = 0;

  const geomFeature: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: 'Feature',
    geometry: footprint.geometry,
    properties: {},
  };

  for (const p of policies) {
    if (!booleanPointInPolygon(point([p.lon, p.lat]), geomFeature)) {
      continue;
    }
    const dr = damageRatio(footprint.peril, p.build_type, footprint.severity ?? footprint.intensity);
    const loss = p.tiv * dr;
    policiesIn += 1;
    tivIn += p.tiv;
    lossSum += loss;

    const cohortId = `${p.zip3}_${p.build_type}`;
    const existing = cohorts.get(cohortId);
    if (existing) {
      existing.loss += loss;
      existing.tiv += p.tiv;
      existing.policies += 1;
    } else {
      cohorts.set(cohortId, { cohort_id: cohortId, loss, tiv: p.tiv, policies: 1 });
    }
  }

  const top = [...cohorts.values()].sort((a, b) => b.loss - a.loss).slice(0, 5);
  return {
    policies_in_footprint: policiesIn,
    tiv_in_footprint: tivIn,
    gross_loss_estimate: lossSum,
    mean_damage_ratio: tivIn > 0 ? lossSum / tivIn : 0,
    cohorts_affected: cohorts.size,
    top_cohorts: top,
  };
}
