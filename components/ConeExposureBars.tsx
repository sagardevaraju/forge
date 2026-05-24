'use client';
/**
 * Task P2.21 — Cone exposure mini-map (book inside vs outside).
 *
 * A compact left-rail visualization on the Event Console: per cohort, look
 * up its ZIP3 centroid, run point-in-polygon against the active NHC cone,
 * then sum cohort `total_tiv` into two buckets — "inside" and "outside".
 *
 * Two horizontal bars surface the ratio in dollars ($M) and as a percent of
 * total. Cohort *count* ratios are computed too (and exposed via test ids)
 * so we can assert the math in tests, but TIV is the headline because that's
 * the business-relevant exposure figure for an event-day reinsurance call.
 *
 * Trust tier is `MODEL_OUTPUT`: the bar values are not raw feed data — they
 * are computed via point-in-polygon against a feed-derived cone plus a ZIP3
 * centroid derived from the live policy book (mean lat/lon per ZIP3, via
 * `lib/db/zip3_centroids.ts`). Provenance footnote credits all sources.
 *
 * Edge cases:
 *   - `cone == null`         → "select a storm" placeholder.
 *   - `cohorts == []`        → "no book loaded" placeholder.
 *   - ZIP3 absent from the centroid map → cohort is dropped from BOTH sides
 *     of the ratio, not silently bucketed as outside. Reported in the
 *     classification breakdown (`unmapped_count`) so we don't fake totals.
 *   - boundary case          → ray-casting is deterministic, so any cohort
 *     centroid that lands exactly on the cone boundary lands consistently
 *     in the same bucket across runs.
 */
import { useMemo } from 'react';
import { pointInPolygon, type PolygonLike } from '@/lib/geo/point_in_polygon';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';

export interface ConeExposureCohort {
  id: string;
  zip3: string;
  total_tiv: number;
  policy_count: number;
}

interface Props {
  cone: PolygonLike | null | undefined;
  cohorts: ConeExposureCohort[];
  /**
   * Override the cone trust tier. Mock cones fall back to a non-live tier
   * upstream; the parent passes that through so the badge stays accurate.
   */
  coneSource?: 'live' | 'mock';
  /**
   * Per-ZIP3 `[lon, lat]` centroids — the mean of each ZIP3's policy
   * coordinates, computed from the live book by `lib/db/zip3_centroids.ts`.
   * A ZIP3 absent here is counted as `unmapped` rather than guessed.
   */
  zip3Centroids: Record<string, [number, number]>;
}

interface Classification {
  inside_tiv: number;
  outside_tiv: number;
  inside_count: number;
  outside_count: number;
  unmapped_count: number;
  total_tiv: number;
  total_count: number;
}

export function classifyCohorts(
  cone: PolygonLike | null | undefined,
  cohorts: ConeExposureCohort[],
  zip3Centroids: Record<string, [number, number]>,
): Classification {
  let inside_tiv = 0;
  let outside_tiv = 0;
  let inside_count = 0;
  let outside_count = 0;
  let unmapped_count = 0;
  let total_tiv = 0;
  let total_count = 0;

  for (const c of cohorts) {
    const centroid = zip3Centroids[c.zip3];
    if (!centroid) {
      unmapped_count += c.policy_count;
      continue;
    }
    total_tiv += c.total_tiv;
    total_count += c.policy_count;
    const inside = pointInPolygon(centroid, cone);
    if (inside) {
      inside_tiv += c.total_tiv;
      inside_count += c.policy_count;
    } else {
      outside_tiv += c.total_tiv;
      outside_count += c.policy_count;
    }
  }

  return {
    inside_tiv,
    outside_tiv,
    inside_count,
    outside_count,
    unmapped_count,
    total_tiv,
    total_count,
  };
}

function fmtMillions(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0M';
  const m = usd / 1_000_000;
  if (m >= 100) return `$${m.toFixed(0)}M`;
  if (m >= 10) return `$${m.toFixed(1)}M`;
  return `$${m.toFixed(2)}M`;
}

function fmtPct(part: number, total: number): string {
  if (total <= 0) return '0%';
  return `${((100 * part) / total).toFixed(0)}%`;
}

export function ConeExposureBars({
  cone,
  cohorts,
  coneSource,
  zip3Centroids,
}: Props) {
  const c = useMemo(
    () => classifyCohorts(cone, cohorts, zip3Centroids),
    [cone, cohorts, zip3Centroids],
  );

  // Empty-state branches surface a placeholder rather than a 0 / 0 = NaN bar.
  if (!cone) {
    return (
      <div
        data-testid="cone-exposure-empty-cone"
        className="border rounded p-3 text-xs text-zinc-500 bg-white"
      >
        Select a storm to see book exposure under the cone.
      </div>
    );
  }
  if (!cohorts || cohorts.length === 0) {
    return (
      <div
        data-testid="cone-exposure-empty-cohorts"
        className="border rounded p-3 text-xs text-zinc-500 bg-white"
      >
        No book loaded. Cone exposure unavailable.
      </div>
    );
  }

  const insidePct = c.total_tiv > 0 ? (100 * c.inside_tiv) / c.total_tiv : 0;
  const outsidePct = c.total_tiv > 0 ? (100 * c.outside_tiv) / c.total_tiv : 0;

  return (
    <div
      data-testid="cone-exposure-bars"
      className="border rounded p-3 bg-white text-xs space-y-2 max-w-[280px]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Book exposure under cone</div>
        {/*
          Trust-tier badge MUST honor the cone source. A MODEL_OUTPUT
          badge over a mock cone is the same CLAUDE.md "LIVE_FEED-over-
          mock-data" violation already fixed in LiveEventStrip — the
          number under cone is a real per-policy aggregation, but the
          *cone polygon* defining "under" is synthetic when source=mock.
        */}
        <TrustTierBadge
          tier={coneSource === 'mock' ? 'SYNTHETIC_SCAFFOLD' : 'MODEL_OUTPUT'}
        />
      </div>

      {/* Inside-cone bar (red, attention-grabbing). */}
      <div data-testid="cone-exposure-row-inside">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-zinc-600">Inside cone</span>
          <span
            className="font-medium tabular-nums"
            data-testid="cone-exposure-inside-label"
            data-inside-tiv={c.inside_tiv}
            data-inside-count={c.inside_count}
          >
            {fmtMillions(c.inside_tiv)} ({fmtPct(c.inside_tiv, c.total_tiv)})
          </span>
        </div>
        <div className="h-2 rounded bg-zinc-100 overflow-hidden">
          <div
            className="h-full bg-red-600"
            data-testid="cone-exposure-inside-fill"
            style={{ width: `${insidePct.toFixed(2)}%` }}
          />
        </div>
      </div>

      {/* Outside-cone bar (slate, neutral). */}
      <div data-testid="cone-exposure-row-outside">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-zinc-600">Outside cone</span>
          <span
            className="font-medium tabular-nums"
            data-testid="cone-exposure-outside-label"
            data-outside-tiv={c.outside_tiv}
            data-outside-count={c.outside_count}
          >
            {fmtMillions(c.outside_tiv)} ({fmtPct(c.outside_tiv, c.total_tiv)})
          </span>
        </div>
        <div className="h-2 rounded bg-zinc-100 overflow-hidden">
          <div
            className="h-full bg-zinc-500"
            data-testid="cone-exposure-outside-fill"
            style={{ width: `${outsidePct.toFixed(2)}%` }}
          />
        </div>
      </div>

      {c.unmapped_count > 0 && (
        <div
          className="text-[10px] text-zinc-500"
          data-testid="cone-exposure-unmapped"
        >
          {c.unmapped_count} policies excluded (ZIP3 centroid unavailable).
        </div>
      )}

      <ProvenanceFootnote
        source={`NHC cone (${coneSource ?? 'mock'}) · policy book · ZIP3 centroids (mean of policy lat/lon)`}
        method="point_in_polygon@v1 · ray-casting against cone outer ring"
      />
    </div>
  );
}
