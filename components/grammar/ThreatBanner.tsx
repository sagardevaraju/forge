/**
 * Task 5 (Redesign Phase 1) — ThreatBanner grammar primitive.
 *
 * The sticky global storm strip rendered at the top of every page (wired by
 * Task 7's layout shell). When a named storm is active the banner surfaces
 * the load-bearing facts a cat-ops desk needs at a glance: storm id, latest
 * advisory number, peak wind (with optional delta-since-prior), cone
 * freshness via `formatRefreshAge`, and the book TIV currently under the
 * cone. When no storm is active it degrades to a single calm "Atlantic
 * basin quiet" line so the strip's presence is constant — the eye learns
 * where to look.
 *
 * Pure stateless server component — no `'use client'`, no hooks. All
 * timestamps are computed by the caller so the banner is deterministic in
 * tests and snapshots.
 */
import { formatRefreshAge } from '@/lib/grammar/freshness';

interface ThreatBannerProps {
  stormId: string | null;
  advisoryNumber?: string;
  peakWind?: number;
  deltaPeakWind?: number;
  coneRefreshedAt?: Date;
  exposureUnderConeTiv?: number;
  now?: Date;
}

export function ThreatBanner({
  stormId,
  advisoryNumber,
  peakWind,
  deltaPeakWind,
  coneRefreshedAt,
  exposureUnderConeTiv,
  now,
}: ThreatBannerProps) {
  if (stormId === null) {
    return (
      <div
        data-testid="threat-banner"
        className="bg-zinc-900 text-zinc-300 text-xs px-4 py-2"
      >
        No active named storm — Atlantic basin quiet.
      </div>
    );
  }

  const deltaSuffix =
    deltaPeakWind !== undefined
      ? ` (${deltaPeakWind >= 0 ? '+' : ''}${deltaPeakWind} mph vs prior)`
      : '';

  return (
    <div
      data-testid="threat-banner"
      className="bg-red-900 text-red-50 text-xs px-4 py-2 flex flex-wrap gap-4 items-center"
    >
      <span className="font-semibold">{stormId}</span>
      {advisoryNumber !== undefined && <span>advisory {advisoryNumber}</span>}
      {peakWind !== undefined && (
        <span>
          peak wind {peakWind} mph{deltaSuffix}
        </span>
      )}
      {coneRefreshedAt !== undefined && (
        <span>cone {formatRefreshAge(coneRefreshedAt, now)}</span>
      )}
      {exposureUnderConeTiv !== undefined && (
        <span>book under cone: ${(exposureUnderConeTiv / 1e6).toFixed(1)}M</span>
      )}
    </div>
  );
}
