/**
 * Task P2.20+ — LiveEventStrip.
 *
 * Calm in-context ribbon rendered above the Portfolio Map. Surfaces the
 * single most operationally-relevant piece of "is something happening right
 * now" context — the active NHC cone, if any — so a reviewer staring at the
 * exposure map can tell at-a-glance whether a named storm is encroaching on
 * the book.
 *
 * Two states:
 *   - Active cone: storm id · advisory · peak wind · book TIV under cone +
 *     a "● Live · Ns ago" freshness chip. Subtle red accent on the leading
 *     dot, but the strip itself stays neutral so it doesn't compete with
 *     the map's color encoding.
 *   - No cone: "● Atlantic basin quiet — no active named storms" in a
 *     calmer zinc tone. Same height + position so the eye learns where to
 *     look, regardless of state. Honest about the absence of an event.
 *
 * Pure presentational — takes pre-computed scalars in. The caller owns the
 * cone fetch, the under-cone TIV calculation, and the timestamp.
 */
import { formatRefreshAge } from '@/lib/grammar/freshness';

/** Per-category active alert counts; only non-zero entries render chips. */
export interface LiveEventStripAlertCounts {
  tornado?: number;
  flood?: number;
  severe_thunderstorm?: number;
  hurricane?: number;
  tropical?: number;
  storm_surge?: number;
  other?: number;
}

const ALERT_CHIP_LABELS: Array<{
  key: keyof LiveEventStripAlertCounts;
  label: string;
  cls: string;
}> = [
  { key: 'tornado', label: 'tornado', cls: 'bg-red-50 text-red-800 ring-red-200' },
  { key: 'flood', label: 'flood', cls: 'bg-blue-50 text-blue-800 ring-blue-200' },
  {
    key: 'severe_thunderstorm',
    label: 'severe t-storm',
    cls: 'bg-amber-50 text-amber-800 ring-amber-200',
  },
  {
    key: 'hurricane',
    label: 'hurricane',
    cls: 'bg-rose-50 text-rose-900 ring-rose-200',
  },
  { key: 'tropical', label: 'tropical', cls: 'bg-red-50 text-red-800 ring-red-200' },
  {
    key: 'storm_surge',
    label: 'storm surge',
    cls: 'bg-teal-50 text-teal-800 ring-teal-200',
  },
];

function AlertChips({
  counts,
}: {
  counts: LiveEventStripAlertCounts | undefined;
}) {
  if (!counts) return null;
  const chips = ALERT_CHIP_LABELS.filter(({ key }) => (counts[key] ?? 0) > 0);
  if (chips.length === 0) return null;
  return (
    <span
      data-testid="live-event-strip-alerts"
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map(({ key, label, cls }) => (
        <span
          key={key}
          data-testid={`live-event-strip-alert-${key}`}
          className={[
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] uppercase tracking-[0.04em] ring-1',
            cls,
          ].join(' ')}
        >
          <span className="tabular-nums font-semibold">{counts[key]}</span>
          <span>{label}</span>
        </span>
      ))}
    </span>
  );
}

interface LiveEventStripProps {
  stormId: string | null;
  advisoryNumber?: string;
  peakWindMph?: number;
  exposureUnderConeTiv?: number;
  zip3sUnderCone?: number;
  refreshedAt: Date;
  /** Source tier — "live" when the upstream feed responded, "mock" when the
   * route fell back to the deterministic offline cone. Surfaced as a small
   * suffix on the freshness chip so reviewers don't mistake demo data for
   * live data. */
  source?: 'live' | 'mock';
  /**
   * Per-category active NWS alert counts (tornado / flood / severe
   * thunderstorm / etc.). Rendered as inline chips regardless of whether
   * a hurricane cone is also active — so a tornado outbreak with no named
   * storm doesn't read as "Atlantic basin quiet."
   */
  alertCounts?: LiveEventStripAlertCounts;
  /** Optional "now" override for deterministic testing. */
  now?: Date;
}

const $M = (n: number) => `$${(n / 1e6).toFixed(1)}M`;

export function LiveEventStrip({
  stormId,
  advisoryNumber,
  peakWindMph,
  exposureUnderConeTiv,
  zip3sUnderCone,
  refreshedAt,
  source,
  alertCounts,
  now,
}: LiveEventStripProps) {
  const hasAlerts = ALERT_CHIP_LABELS.some(
    ({ key }) => (alertCounts?.[key] ?? 0) > 0,
  );
  if (stormId === null) {
    // When the Atlantic is quiet but NWS warnings exist somewhere in the
    // book's footprint (tornado outbreak, flash flooding without a named
    // storm), upgrade the strip's tone and surface the chips so the page
    // never lies about the absence of an active event.
    if (hasAlerts) {
      return (
        <div
          data-testid="live-event-strip"
          data-state="alerts-only"
          className="flex flex-wrap items-center gap-2 px-3.5 py-2 rounded-md ring-1 ring-amber-200/70 bg-amber-50/70 text-[11.5px] text-zinc-800 shadow-[0_1px_0_rgba(24,24,27,0.03)]"
          aria-label="Live event status, active alerts"
        >
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse"
          />
          <span className="font-medium text-zinc-800">No active named storms</span>
          <span className="text-zinc-500">·</span>
          <AlertChips counts={alertCounts} />
          <span className="ml-auto text-[10.5px] text-zinc-500 tabular-nums">
            NWS · {formatRefreshAge(refreshedAt, now)}
          </span>
        </div>
      );
    }
    return (
      <div
        data-testid="live-event-strip"
        data-state="quiet"
        className="flex flex-wrap items-center gap-2 px-3.5 py-2 rounded-md ring-1 ring-zinc-200/70 bg-white text-[11.5px] text-zinc-600 shadow-[0_1px_0_rgba(24,24,27,0.03)]"
        aria-label="Live event status"
      >
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400"
        />
        <span className="font-medium text-zinc-700">No active named storms</span>
        <span className="text-zinc-400">·</span>
        <span>Atlantic basin quiet</span>
        <span className="ml-auto text-[10.5px] text-zinc-400 tabular-nums">
          checked {formatRefreshAge(refreshedAt, now)}
        </span>
      </div>
    );
  }

  const ageLabel = formatRefreshAge(refreshedAt, now);
  const hasExposure =
    exposureUnderConeTiv !== undefined && Number.isFinite(exposureUnderConeTiv);

  return (
    <div
      data-testid="live-event-strip"
      data-state="active"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2 rounded-md ring-1 ring-rose-200/70 bg-rose-50/70 text-[11.5px] text-zinc-800 shadow-[0_1px_0_rgba(24,24,27,0.03)]"
      role="status"
      aria-live="polite"
      aria-label={`Active storm ${stormId}, advisory ${advisoryNumber ?? '—'}, peak wind ${peakWindMph ?? '—'} mph`}
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse"
        />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-rose-700">
          Active threat
        </span>
      </span>
      <span className="font-semibold text-zinc-900 tabular-nums">{stormId}</span>
      {advisoryNumber && (
        <span className="text-zinc-600">
          advisory <span className="text-zinc-900 font-medium">{advisoryNumber}</span>
        </span>
      )}
      {peakWindMph !== undefined && (
        <span className="text-zinc-600">
          peak wind{' '}
          <span className="text-zinc-900 font-medium tabular-nums">
            {peakWindMph} mph
          </span>
        </span>
      )}
      {hasExposure && (
        <span className="text-zinc-600">
          book under cone{' '}
          <span className="text-zinc-900 font-medium tabular-nums">
            {$M(exposureUnderConeTiv!)}
          </span>
          {zip3sUnderCone !== undefined && zip3sUnderCone > 0 && (
            <span className="text-zinc-500">
              {' '}
              · {zip3sUnderCone} ZIP3{zip3sUnderCone === 1 ? '' : 's'}
            </span>
          )}
        </span>
      )}
      <AlertChips counts={alertCounts} />
      <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] text-zinc-500 tabular-nums">
        <span
          aria-hidden="true"
          className={[
            'inline-block h-1.5 w-1.5 rounded-full',
            source === 'mock' ? 'bg-amber-500' : 'bg-emerald-500',
          ].join(' ')}
        />
        {source === 'mock' ? 'Mock' : 'Live'} · {ageLabel}
      </span>
    </div>
  );
}
