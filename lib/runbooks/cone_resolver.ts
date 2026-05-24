/**
 * Task AUDIT.5 — Cone → ZIP3 resolver.
 *
 * Pure-function resolver: given an NHC forecast cone (GeoJSON
 * Polygon / MultiPolygon / Feature) and a per-ZIP3 centroid map, return
 * the sorted list of ZIP3 prefixes whose centroid sits inside the cone.
 *
 * Why this exists
 * ---------------
 * The original `DEFAULT_CONE_ZIP3S` in `lib/runbooks/index.ts` was a
 * hand-coded 49-entry stand-in for a real resolver: it carried the FL
 * panhandle + GA + AL footprint by ZIP3 prefix, picked to cover the most
 * common landfall geography for the demo book. That's a "demo data
 * masquerading as live" anti-pattern — the runbook claimed to query
 * book exposure "in the cone" but the list was static regardless of the
 * actual storm.
 *
 * AUDIT.5 ships the real resolver:
 *   - `lib/db/zip3_centroids.ts::zip3Centroids` already derives
 *     per-ZIP3 centroids from the live policy book (means of
 *     policies.lat/lon grouped by zip3).
 *   - `lib/geo/point_in_polygon.ts::pointInPolygon` is the GeoJSON-
 *     compatible PNPOLY implementation we already use for the cone
 *     overlay on the portfolio map.
 *
 * Combined they give a real centroid-in-cone classifier. This file is
 * the composition layer + a tests + a `resolve_cone_to_zip3s` agent
 * tool wrapper at `app/api/agent/tools/resolve_cone_to_zip3s.ts`.
 *
 * Scope limit (intentional, documented honest deferral)
 * -----------------------------------------------------
 * The pure resolver SHIPS here. Wiring it into the procedure-mode
 * runbook executor needs the executor to thread one step's result into
 * the next step's args — today the executor only resolves args from
 * `RunbookContext` (storm_id, states, user_message), not from prior
 * tool results. That executor upgrade is product work for a later PR;
 * meanwhile the resolver is callable as the `resolve_cone_to_zip3s`
 * tool in *free* mode (the LLM can compose it with `fetch_nhc_cone`
 * and `query_book_exposure` itself).
 *
 * The hardcoded `DEFAULT_CONE_ZIP3S` in `lib/runbooks/index.ts` is
 * now demoted to a labeled FALLBACK list — the runbook docstring
 * cross-links to this module so a future executor upgrade lands
 * cleanly.
 */
import { pointInPolygon, type PolygonLike } from '@/lib/geo/point_in_polygon';
import type { Zip3Centroid } from '@/lib/db/zip3_centroids';

/**
 * Iterate every ZIP3 centroid, apply `pointInPolygon` against the cone,
 * collect matches, and return them sorted lexically (string compare).
 *
 * Returns an empty array when the cone is malformed / null — the
 * pointInPolygon helper returns false defensively in that case, so the
 * loop produces zero matches without throwing.
 */
export function resolveConeToZip3s(
  cone: PolygonLike | null | undefined,
  centroids: Record<string, Zip3Centroid>,
): string[] {
  if (!cone) return [];
  const matched: string[] = [];
  for (const [zip3, lonLat] of Object.entries(centroids)) {
    if (pointInPolygon(lonLat, cone)) {
      matched.push(zip3);
    }
  }
  // Sort lexically so the output is deterministic across runs — the
  // map iteration order is insertion order, which can vary by source
  // (libSQL vs in-memory mock).
  matched.sort();
  return matched;
}

/**
 * Bundle the centroid lookup + the cone classification into a single
 * call site. Returns `{zip3_list, count}` plus the input metadata so a
 * caller can inspect what was matched.
 *
 * The centroid loader is async (it hits the DB); pure-function callers
 * should prefer `resolveConeToZip3s` directly.
 */
export async function resolveConeToZip3sFromBook(
  cone: PolygonLike | null | undefined,
  centroidsLoader: () => Promise<Record<string, Zip3Centroid>>,
): Promise<{
  zip3_list: string[];
  count: number;
  centroids_count: number;
}> {
  const centroids = await centroidsLoader();
  const zip3_list = resolveConeToZip3s(cone, centroids);
  return {
    zip3_list,
    count: zip3_list.length,
    centroids_count: Object.keys(centroids).length,
  };
}
