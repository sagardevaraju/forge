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

/**
 * Per-chip colour pair: `live` is the saturated red/amber/blue used when the
 * upstream NWS feed actually fired the alert; `demo` is a desaturated zinc
 * palette so a mock-source chip can never be mistaken for a live warning
 * count. Single source of truth — the renderer below switches on
 * ``alertsSource``.
 */
const ALERT_CHIP_LABELS: Array<{
  key: keyof LiveEventStripAlertCounts;
  label: string;
  live: string;
  demo: string;
}> = [
  {
    key: 'tornado',
    label: 'tornado',
    live: 'bg-red-50 text-red-800 ring-red-200',
    demo: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
  },
  {
    key: 'flood',
    label: 'flood',
    live: 'bg-blue-50 text-blue-800 ring-blue-200',
    demo: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
  },
  {
    key: 'severe_thunderstorm',
    label: 'severe t-storm',
    live: 'bg-amber-50 text-amber-800 ring-amber-200',
    demo: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
  },
  {
    key: 'hurricane',
    label: 'hurricane',
    live: 'bg-rose-50 text-rose-900 ring-rose-200',
    demo: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
  },
  {
    key: 'tropical',
    label: 'tropical',
    live: 'bg-red-50 text-red-800 ring-red-200',
    demo: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
  },
  {
    key: 'storm_surge',
    label: 'storm surge',
    live: 'bg-teal-50 text-teal-800 ring-teal-200',
    demo: 'bg-zinc-100 text-zinc-700 ring-zinc-300',
  },
];

function AlertChips({
  counts,
  source = 'live',
}: {
  counts: LiveEventStripAlertCounts | undefined;
  source?: 'live' | 'mock';
}) {
  if (!counts) return null;
  const chips = ALERT_CHIP_LABELS.filter(({ key }) => (counts[key] ?? 0) > 0);
  if (chips.length === 0) return null;
  const isMock = source === 'mock';
  return (
    <span
      data-testid="live-event-strip-alerts"
      data-source={source}
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map(({ key, label, live, demo }) => (
        <span
          key={key}
          data-testid={`live-event-strip-alert-${key}`}
          // Mock-source chips suffix the label with " (demo)" so the chip
          // itself — not just a corner badge — admits the synthetic source.
          aria-label={`${counts[key]} ${label}${isMock ? ' (demo)' : ''}`}
          className={[
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] uppercase tracking-[0.04em] ring-1',
            isMock ? demo : live,
          ].join(' ')}
        >
          <span className="tabular-nums font-semibold">{counts[key]}</span>
          <span>{label}</span>
          {isMock && (
            <span className="ml-0.5 text-[9.5px] tracking-[0.06em] text-zinc-500">
              demo
            </span>
          )}
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
   * route fell back to the deterministic offline cone. Drives BOTH the
   * suffix on the freshness chip AND the headline pill / colour treatment:
   * mock collapses the rose "Active threat" pill to an amber "Demo
   * scenario" pill so reviewers can never mistake synthetic data for a
   * live event. CLAUDE.md "no fictional data": a LIVE_FEED badge over
   * mock data is a bug. */
  source?: 'live' | 'mock';
  /**
   * Per-category active NWS alert counts (tornado / flood / severe
   * thunderstorm / etc.). Rendered as inline chips regardless of whether
   * a hurricane cone is also active — so a tornado outbreak with no named
   * storm doesn't read as "Atlantic basin quiet."
   */
  alertCounts?: LiveEventStripAlertCounts;
  /**
   * Source tier for the alert chips, separate from the cone source above —
   * in practice ``FORGE_TOOLS_MODE=mock`` flips both together, but the
   * NWS feed can be down independently. When ``'mock'`` the chips render
   * with the same amber demo styling as the cone strip so the chip count
   * (e.g. "8 SEVERE T-STORM") isn't mistaken for a live warning count.
   */
  alertsSource?: 'live' | 'mock';
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
  alertsSource,
  now,
}: LiveEventStripProps) {
  const hasAlerts = ALERT_CHIP_LABELS.some(
    ({ key }) => (alertCounts?.[key] ?? 0) > 0,
  );
  // When `alertsSource` isn't passed explicitly, the safe inference is that
  // the chips share a source with the cone (the route layer sets
  // FORGE_TOOLS_MODE for both together). Defaulting to the cone source means
  // a caller that only wires `source` still gets honest chip styling.
  const effectiveAlertsSource: 'live' | 'mock' =
    alertsSource ?? (source === 'mock' ? 'mock' : 'live');
  if (stormId === null) {
    // When the Atlantic is quiet but NWS warnings exist somewhere in the
    // book's footprint (tornado outbreak, flash flooding without a named
    // storm), upgrade the strip's tone and surface the chips so the page
    // never lies about the absence of an active event.
    if (hasAlerts) {
      const alertsAreMock = effectiveAlertsSource === 'mock';
      return (
        <div
          data-testid="live-event-strip"
          data-state="alerts-only"
          data-source={effectiveAlertsSource}
          className={[
            'flex flex-wrap items-center gap-2 px-3.5 py-2 rounded-md ring-1 text-[11.5px] text-zinc-800 shadow-[0_1px_0_rgba(24,24,27,0.03)]',
            alertsAreMock
              ? 'ring-zinc-200/70 bg-zinc-50/80'
              : 'ring-amber-200/70 bg-amber-50/70',
          ].join(' ')}
          aria-label={
            alertsAreMock
              ? 'Demo alert status — synthetic NWS counts'
              : 'Live event status, active alerts'
          }
        >
          <span
            aria-hidden="true"
            className={[
              'inline-block h-1.5 w-1.5 rounded-full',
              alertsAreMock ? 'bg-zinc-400' : 'bg-amber-500 animate-pulse',
            ].join(' ')}
          />
          <span className="font-medium text-zinc-800">No active named storms</span>
          <span className="text-zinc-500">·</span>
          <AlertChips counts={alertCounts} source={effectiveAlertsSource} />
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] text-zinc-500 tabular-nums">
            {alertsAreMock && (
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
              />
            )}
            {alertsAreMock ? 'Mock NWS' : 'NWS'} · {formatRefreshAge(refreshedAt, now)}
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
  // CLAUDE.md "no fictional data": a LIVE_FEED treatment over mock data is a
  // bug. When the cone fell back to the deterministic offline polygon the
  // entire strip downgrades to an amber demo-scenario treatment, the "Active
  // threat" pill becomes "Demo scenario", and the storm metadata is muted so
  // a reviewer scanning the page can never mistake a synthetic cone for a
  // live NHC advisory.
  const isMockCone = source === 'mock';

  return (
    <div
      data-testid="live-event-strip"
      data-state="active"
      data-source={source ?? 'live'}
      className={[
        'flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2 rounded-md ring-1 text-[11.5px] text-zinc-800 shadow-[0_1px_0_rgba(24,24,27,0.03)]',
        isMockCone ? 'ring-amber-200/70 bg-amber-50/70' : 'ring-rose-200/70 bg-rose-50/70',
      ].join(' ')}
      role="status"
      aria-live="polite"
      aria-label={
        isMockCone
          ? `Demo scenario ${stormId}, synthetic cone, advisory ${advisoryNumber ?? '—'}, peak wind ${peakWindMph ?? '—'} mph`
          : `Active storm ${stormId}, advisory ${advisoryNumber ?? '—'}, peak wind ${peakWindMph ?? '—'} mph`
      }
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={[
            'inline-block h-1.5 w-1.5 rounded-full',
            isMockCone ? 'bg-amber-500' : 'bg-rose-500 animate-pulse',
          ].join(' ')}
        />
        <span
          className={[
            'text-[10.5px] font-semibold uppercase tracking-[0.1em]',
            isMockCone ? 'text-amber-800' : 'text-rose-700',
          ].join(' ')}
        >
          {isMockCone ? 'Demo scenario' : 'Active threat'}
        </span>
      </span>
      <span
        className={[
          'font-semibold tabular-nums',
          isMockCone ? 'text-zinc-700' : 'text-zinc-900',
        ].join(' ')}
      >
        {stormId}
      </span>
      {advisoryNumber && (
        <span className="text-zinc-600">
          advisory{' '}
          <span
            className={[
              'font-medium',
              isMockCone ? 'text-zinc-700' : 'text-zinc-900',
            ].join(' ')}
          >
            {advisoryNumber}
          </span>
        </span>
      )}
      {peakWindMph !== undefined && (
        <span className="text-zinc-600">
          peak wind{' '}
          <span
            className={[
              'font-medium tabular-nums',
              isMockCone ? 'text-zinc-700' : 'text-zinc-900',
            ].join(' ')}
          >
            {peakWindMph} mph
          </span>
        </span>
      )}
      {hasExposure && (
        <span className="text-zinc-600">
          book under cone{' '}
          <span
            className={[
              'font-medium tabular-nums',
              isMockCone ? 'text-zinc-700' : 'text-zinc-900',
            ].join(' ')}
          >
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
      <AlertChips counts={alertCounts} source={effectiveAlertsSource} />
      <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] text-zinc-500 tabular-nums">
        <span
          aria-hidden="true"
          className={[
            'inline-block h-1.5 w-1.5 rounded-full',
            isMockCone ? 'bg-amber-500' : 'bg-emerald-500',
          ].join(' ')}
        />
        {isMockCone ? 'Mock' : 'Live'} · {ageLabel}
      </span>
    </div>
  );
}
