/**
 * resolve_cone_to_zip3s — AUDIT.5 (2026-05-24).
 *
 * Compose `fetch_nhc_cone` + `lib/runbooks/cone_resolver` + the live
 * book's per-ZIP3 centroids into a single tool. Given a storm_id,
 * return the ZIP3 prefixes whose centroid falls inside the forecast
 * cone — the "real" replacement for the hardcoded `DEFAULT_CONE_ZIP3S`
 * in `lib/runbooks/index.ts`.
 *
 * Available in free mode immediately. Procedure-mode runbooks can use
 * it once the runbook executor can thread one step's result into the
 * next step's args (deferred to a later product PR; the resolver is
 * the building block).
 *
 * Mock fallback: when the underlying `fetch_nhc_cone` returns a mock
 * cone (no upstream live NHC connection), this tool surfaces the mock
 * cone's resolved ZIP3 list with `source: 'mock'` so the UI's trust
 * badge stays honest.
 */
import { fetchNhcCone, type FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import { zip3Centroids } from '@/lib/db/zip3_centroids';
import { resolveConeToZip3s } from '@/lib/runbooks/cone_resolver';
import type { PolygonLike } from '@/lib/geo/point_in_polygon';

export interface ResolveConeToZip3sArgs {
  storm_id: string;
  /**
   * Optional explicit cone payload — for callers that already fetched
   * the cone via `fetch_nhc_cone` and want to avoid the second HTTP
   * round-trip. When omitted the tool calls `fetch_nhc_cone` itself.
   */
  cone?: PolygonLike;
}

export interface ResolveConeToZip3sResult {
  storm_id: string;
  zip3_list: string[];
  count: number;
  centroids_count: number;
  source: 'live' | 'mock';
}

export const resolveConeToZip3sTool = {
  name: 'resolve_cone_to_zip3s',
  description:
    "Return the ZIP3 prefixes whose centroid falls inside the NHC forecast cone for the given storm. Composes fetch_nhc_cone + per-ZIP3 book centroids + ray-casting. Use this before query_book_exposure when the operator wants exposure 'inside the cone' rather than across a fixed footprint.",
  parameters: {
    type: 'object' as const,
    properties: {
      storm_id: {
        type: 'string',
        description: 'NHC storm identifier, e.g. "AL092024".',
      },
    },
    required: ['storm_id'],
  },
  handler: async (
    args: ResolveConeToZip3sArgs,
  ): Promise<ResolveConeToZip3sResult> => {
    let cone: PolygonLike | null = args.cone ?? null;
    let source: 'live' | 'mock' = 'live';

    if (!cone) {
      const fetched: FetchNhcConeResult | null = await fetchNhcCone.handler({
        storm_id: args.storm_id,
      });
      if (!fetched) {
        return {
          storm_id: args.storm_id,
          zip3_list: [],
          count: 0,
          centroids_count: 0,
          source: 'mock',
        };
      }
      // `cone` lives at fetched.cone as an unknown — narrow it.
      cone = (fetched.cone as PolygonLike | null) ?? null;
      source = fetched.source ?? 'mock';
    }

    const centroids = await zip3Centroids();
    const zip3_list = resolveConeToZip3s(cone, centroids);
    return {
      storm_id: args.storm_id,
      zip3_list,
      count: zip3_list.length,
      centroids_count: Object.keys(centroids).length,
      source,
    };
  },
};
