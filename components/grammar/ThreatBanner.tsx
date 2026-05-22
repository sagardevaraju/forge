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

/**
 * Per-category count of currently-active NWS alerts. Mirrors the
 * `NwsAlertCounts` shape from `fetch_nws_alerts` but kept structural so
 * the banner has no compile-time dependency on the tool. Any/all keys
 * may be zero; the banner only renders chips for non-zero entries.
 */
export interface ThreatBannerAlertCounts {
  tornado?: number;
  flood?: number;
  severe_thunderstorm?: number;
  hurricane?: number;
  tropical?: number;
  storm_surge?: number;
  other?: number;
}

interface ThreatBannerProps {
  stormId: string | null;
  /** Human-readable storm name surfaced alongside the id (e.g. "HELENE"). */
  stormName?: string | null;
  /**
   * When true, the banner annotates the storm with a "(demo)" chip — used by
   * `/events` when no live storms are active and the page is rendering the
   * historical demo storm as a fallback. Lets the operator instantly tell
   * "this is a frozen reference" from "this is a real ongoing event."
   */
  isDemo?: boolean;
  advisoryNumber?: string;
  peakWind?: number;
  deltaPeakWind?: number;
  coneRefreshedAt?: Date;
  exposureUnderConeTiv?: number;
  /**
   * Live NWS alert counts surfaced as inline chips ("3 tornado",
   * "1 flash flood"). Chips render in any banner state — even the calm
   * "no active storm" branch, so a tornado outbreak with no hurricane
   * still lights up the strip.
   */
  alertCounts?: ThreatBannerAlertCounts;
  now?: Date;
}

const ALERT_CHIP_LABELS: Array<{
  key: keyof ThreatBannerAlertCounts;
  label: string;
  bg: string;
  text: string;
}> = [
  { key: 'tornado', label: 'tornado', bg: 'bg-red-700/80', text: 'text-red-50' },
  { key: 'flood', label: 'flood', bg: 'bg-blue-700/80', text: 'text-blue-50' },
  {
    key: 'severe_thunderstorm',
    label: 'severe t-storm',
    bg: 'bg-amber-700/80',
    text: 'text-amber-50',
  },
  { key: 'hurricane', label: 'hurricane', bg: 'bg-red-900/80', text: 'text-red-50' },
  { key: 'tropical', label: 'tropical', bg: 'bg-red-600/80', text: 'text-red-50' },
  { key: 'storm_surge', label: 'storm surge', bg: 'bg-teal-700/80', text: 'text-teal-50' },
];

function AlertChips({ counts }: { counts: ThreatBannerAlertCounts | undefined }) {
  if (!counts) return null;
  const chips = ALERT_CHIP_LABELS.filter(({ key }) => (counts[key] ?? 0) > 0);
  if (chips.length === 0) return null;
  return (
    <span data-testid="threat-banner-alerts" className="flex flex-wrap gap-1.5 items-center">
      {chips.map(({ key, label, bg, text }) => (
        <span
          key={key}
          data-testid={`threat-banner-alert-${key}`}
          className={[
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] uppercase tracking-[0.04em]',
            bg,
            text,
          ].join(' ')}
        >
          <span className="tabular-nums font-semibold">{counts[key]}</span>
          <span>{label}</span>
        </span>
      ))}
    </span>
  );
}

export function ThreatBanner({
  stormId,
  stormName,
  isDemo,
  advisoryNumber,
  peakWind,
  deltaPeakWind,
  coneRefreshedAt,
  exposureUnderConeTiv,
  alertCounts,
  now,
}: ThreatBannerProps) {
  const hasAlerts = ALERT_CHIP_LABELS.some(
    ({ key }) => (alertCounts?.[key] ?? 0) > 0,
  );
  if (stormId === null) {
    // When no storm is active but live NWS warnings exist (tornado outbreak,
    // flash flooding without a named storm), upgrade the calm strip to a
    // visible alerts row so the operator never thinks the page is quiet.
    if (hasAlerts) {
      return (
        <div
          data-testid="threat-banner"
          className="bg-zinc-800 text-zinc-100 text-xs px-4 py-2 flex flex-wrap gap-3 items-center"
        >
          <span className="font-medium">No active named storm</span>
          <span className="text-zinc-400">·</span>
          <AlertChips counts={alertCounts} />
        </div>
      );
    }
    return (
      <div
        data-testid="threat-banner"
        className="bg-zinc-900 text-zinc-300 text-xs px-4 py-2"
      >
        No active named storm. Atlantic basin quiet.
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
      className={[
        'text-xs px-4 py-2 flex flex-wrap gap-4 items-center',
        isDemo ? 'bg-amber-900 text-amber-50' : 'bg-red-900 text-red-50',
      ].join(' ')}
    >
      <span className="font-semibold">{stormId}</span>
      {stormName && <span className="font-medium">{stormName}</span>}
      {isDemo && (
        <span
          data-testid="threat-banner-demo"
          className="text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded ring-1 ring-amber-300/60 text-amber-100"
        >
          demo · no active storms
        </span>
      )}
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
      <AlertChips counts={alertCounts} />
    </div>
  );
}
