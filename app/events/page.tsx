/**
 * Task 21 — Event Console route.
 * Task 23 — Delta-since-last-advisory wired into ThreatBanner.
 *
 * Server component: pulls the demo storm's NHC cone and a recent FIRMS
 * snapshot directly via the agent tool handlers (no LLM round-trip for raw
 * map data). Both tools have built-in mock fallbacks, so the page renders
 * deterministically even on a fresh clone with no API keys.
 *
 * `force-dynamic` keeps the cone fresh — the upstream NHC JSON updates with
 * each advisory and we never want stale Vercel ISR data sitting in front of
 * an operational view.
 *
 * Banner wiring (Task 23): we render a storm-specific ThreatBanner inside
 * the events page so the active advisory's id / peak wind / delta-vs-prior
 * surface above the map. The global layout still renders its calm
 * `stormId={null}` strip — both can coexist for Phase 1; a follow-up will
 * hoist the storm context up to the layout so only one banner is shown.
 */
import { EventConsole } from '@/components/EventConsole';
import { EventsPersonaScope } from '@/components/EventsPersonaScope';
import { ThreatBanner } from '@/components/grammar/ThreatBanner';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';
import { fetchFirmsFires } from '@/app/api/agent/tools/fetch_firms_fires';
import { aggregateCohorts } from '@/lib/db/cohorts';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import type { FireDetection } from '@/app/api/agent/tools/fetch_firms_fires';
import type { ConeExposureCohort } from '@/components/ConeExposureBars';

export const dynamic = 'force-dynamic';

const DEMO_STORM_ID = 'AL092024';
/** Florida-spanning bbox: [west, south, east, north]. */
const FL_BBOX: [number, number, number, number] = [-88, 24, -76, 32];

export default async function EventsPage() {
  const [cone, fires, cohortsRaw]: [
    FetchNhcConeResult | null,
    FireDetection[],
    Awaited<ReturnType<typeof aggregateCohorts>>,
  ] = await Promise.all([
    fetchNhcCone.handler({ storm_id: DEMO_STORM_ID }).catch(() => null),
    fetchFirmsFires.handler({ bbox: FL_BBOX, hours: 24 }).catch(() => []),
    // Task P2.21: cohort-level exposure for the cone-vs-outside mini-map.
    // The book is small (~500 cohorts) and the page is already
    // `force-dynamic`, so we can afford the DB hit on each render. Failure
    // (e.g. fresh clone without `npm run migrate`) degrades gracefully via
    // the mini-map's "no book loaded" placeholder.
    aggregateCohorts().catch(() => []),
  ]);
  const cohorts: ConeExposureCohort[] = cohortsRaw.map((c) => ({
    id: c.id,
    zip3: c.zip3,
    total_tiv: c.total_tiv,
    policy_count: c.policy_count,
  }));

  // Delta is suppressed when either reading is null — the banner just hides
  // the chip rather than rendering a misleading "+NaN mph vs prior".
  const deltaPeakWind =
    cone?.peak_wind != null && cone?.prior_peak_wind != null
      ? cone.peak_wind - cone.prior_peak_wind
      : undefined;
  const coneRefreshedAt = cone ? new Date() : undefined;

  return (
    <>
      {cone && (
        <ThreatBanner
          stormId={DEMO_STORM_ID}
          advisoryNumber={cone.advisory_number || undefined}
          peakWind={cone.peak_wind ?? undefined}
          deltaPeakWind={deltaPeakWind}
          coneRefreshedAt={coneRefreshedAt}
        />
      )}
      {/*
        Task P2.18 — Persona toggle + quick-links band above the console.
        Lens state is URL-backed (`?persona=<id>`) so a shared link with
        `?persona=reinsurance` lands a treaty lead on this view with the
        /treaty drill-in already one click away.
      */}
      <EventsPersonaScope />
      <EventConsole cone={cone} fires={fires} cohorts={cohorts} />
    </>
  );
}
