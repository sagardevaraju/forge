/**
 * Task 21 — Event Console route.
 * Task 23 — Delta-since-last-advisory wired into ThreatBanner.
 * Task P2.23 — Cone uncertainty band: page calls generate_scenarios in
 * parallel with the NHC cone fetch and merges the resulting
 * `cone_envelope` onto the cone payload so EventConsole renders the
 * GEFS-perturbation band UNDER the official NHC cone. Both tools are
 * best-effort — either one failing leaves the page renderable.
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
import {
  fetchActiveStorms,
  pickRelevantStorm,
} from '@/app/api/agent/tools/fetch_active_storms';
import { fetchFirmsFires } from '@/app/api/agent/tools/fetch_firms_fires';
import { fetchNwsAlerts } from '@/app/api/agent/tools/fetch_nws_alerts';
import { generateScenarios } from '@/app/api/agent/tools/generate_scenarios';
import { aggregateCohorts } from '@/lib/db/cohorts';
import { getBookStates } from '@/lib/db/book_totals';
import { zip3Centroids } from '@/lib/db/zip3_centroids';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import type { FireDetection } from '@/app/api/agent/tools/fetch_firms_fires';
import type { GenerateScenariosResult } from '@/app/api/agent/tools/generate_scenarios';
import type { ActiveStorm } from '@/app/api/agent/tools/fetch_active_storms';
import type { FetchNwsAlertsResult } from '@/app/api/agent/tools/fetch_nws_alerts';
import type { ConeExposureCohort } from '@/components/ConeExposureBars';

export const dynamic = 'force-dynamic';

/**
 * Fallback storm id used when NHC reports zero active named storms. The
 * historical demo (Hurricane Helene, AL092024) keeps the page populated
 * with a recognisable scenario between hurricane seasons; the banner
 * annotates it with a "demo" chip so the operator can tell at a glance
 * that this is a frozen reference rather than a live event.
 */
const FALLBACK_STORM_ID = 'AL092024';
const FALLBACK_STORM_NAME = 'HELENE';
/** Florida-spanning bbox: [west, south, east, north]. */
const FL_BBOX: [number, number, number, number] = [-88, 24, -76, 32];

export default async function EventsPage() {
  // Task — auto-discovery. We poll NHC's CurrentStorms.json first; the
  // resulting list is the source of truth for which storm we should be
  // looking at. When the Atlantic basin is quiet we fall back to the demo
  // storm so the page keeps rendering, but flag it so the UI surfaces the
  // distinction. The tool's own mock fallback already returns the demo
  // storm when the upstream feed is unreachable — so a network blip
  // doesn't drop the operator into a "demo" view; only an *actually
  // empty live response* does.
  // Resolve auto-discovery + book footprint inline before kicking off the
  // parallel fetches. `bookStates` decides which states get NWS alert
  // coverage — hardcoding FL would miss tornadoes/floods on policies
  // elsewhere in the book.
  const [bookStates, active] = await Promise.all([
    getBookStates().catch(() => [] as string[]),
    fetchActiveStorms
      .handler({ basin: 'AL' })
      .catch(() => ({ storms: [] as ActiveStorm[], source: 'mock' as const, fetched_at: '' })),
  ]);
  const picked = pickRelevantStorm(active.storms);
  const liveActiveStormFound = picked !== null && active.source === 'live';
  const stormId = picked?.id ?? FALLBACK_STORM_ID;
  const stormName = picked?.name ?? (liveActiveStormFound ? null : FALLBACK_STORM_NAME);
  const isDemo = !liveActiveStormFound;

  const [cone, fires, cohortsRaw, scenarios, alertsRes, zip3CentroidMap]: [
    FetchNhcConeResult | null,
    FireDetection[],
    Awaited<ReturnType<typeof aggregateCohorts>>,
    GenerateScenariosResult | null,
    FetchNwsAlertsResult | null,
    Awaited<ReturnType<typeof zip3Centroids>>,
  ] = await Promise.all([
    fetchNhcCone.handler({ storm_id: stormId }).catch(() => null),
    fetchFirmsFires.handler({ bbox: FL_BBOX, hours: 24 }).catch(() => []),
    // Task P2.21: cohort-level exposure for the cone-vs-outside mini-map.
    // The book is small (~500 cohorts) and the page is already
    // `force-dynamic`, so we can afford the DB hit on each render. Failure
    // (e.g. fresh clone without `npm run migrate`) degrades gracefully via
    // the mini-map's "no book loaded" placeholder.
    aggregateCohorts().catch(() => []),
    // Task P2.23: GEFS-perturbation cone-uncertainty envelope. The tool
    // has a deterministic mock fallback baked in, but we still catch here
    // so a thrown error (bad storm_id, network) degrades to "no envelope"
    // rather than failing the whole page render.
    generateScenarios.handler({ storm_id: stormId, n: 100 }).catch(() => null),
    // Live NWS active alerts (tornado / flood / severe thunderstorm /
    // tropical / storm surge) — scoped to the book's full state
    // footprint, not hardcoded FL. The tool has its own mock fallback
    // for offline / network-failure cases; we still null-coalesce here
    // so a thrown error doesn't take down the page render.
    fetchNwsAlerts
      .handler({ state: bookStates.length > 0 ? bookStates : undefined })
      .catch(() => null),
    // Per-ZIP3 centroids from the live policy book — the cone-exposure
    // mini-map classifies cohorts inside/outside the cone against these.
    // Degrades to an empty map (cohorts then count as unmapped) on failure.
    zip3Centroids().catch((): Awaited<ReturnType<typeof zip3Centroids>> => ({})),
  ]);
  const cohorts: ConeExposureCohort[] = cohortsRaw.map((c) => ({
    id: c.id,
    zip3: c.zip3,
    total_tiv: c.total_tiv,
    policy_count: c.policy_count,
  }));

  // Task P2.23: merge the GEFS envelope onto the cone payload. EventConsole
  // accepts the envelope as a peer field on `cone`; if either tool failed,
  // we omit the envelope entirely (rather than passing `cone_envelope:
  // null`) so the layer stack falls back cleanly.
  const coneWithEnvelope = cone
    ? { ...cone, cone_envelope: scenarios?.cone_envelope ?? null }
    : null;

  // Delta is suppressed when either reading is null — the banner just hides
  // the chip rather than rendering a misleading "+NaN mph vs prior".
  const deltaPeakWind =
    cone?.peak_wind != null && cone?.prior_peak_wind != null
      ? cone.peak_wind - cone.prior_peak_wind
      : undefined;
  const coneRefreshedAt = cone ? new Date() : undefined;

  const alerts = alertsRes?.alerts ?? [];
  const alertCounts = alertsRes?.counts;

  return (
    <>
      {cone && (
        <ThreatBanner
          stormId={stormId}
          stormName={stormName}
          isDemo={isDemo}
          advisoryNumber={cone.advisory_number || undefined}
          peakWind={cone.peak_wind ?? undefined}
          deltaPeakWind={deltaPeakWind}
          coneRefreshedAt={coneRefreshedAt}
          alertCounts={alertCounts}
        />
      )}
      {/*
        Task P2.18 — Persona toggle + quick-links band above the console.
        Lens state is URL-backed (`?persona=<id>`) so a shared link with
        `?persona=reinsurance` lands a treaty lead on this view with the
        /treaty drill-in already one click away.
      */}
      <EventsPersonaScope />
      <EventConsole
        cone={coneWithEnvelope}
        fires={fires}
        cohorts={cohorts}
        alerts={alerts}
        zip3Centroids={zip3CentroidMap}
      />
    </>
  );
}
