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
import { fetchFirmsFires } from '@/app/api/agent/tools/fetch_firms_fires';
import { generateScenarios } from '@/app/api/agent/tools/generate_scenarios';
import { aggregateCohorts } from '@/lib/db/cohorts';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import type { FireDetection } from '@/app/api/agent/tools/fetch_firms_fires';
import type { GenerateScenariosResult } from '@/app/api/agent/tools/generate_scenarios';
import type { ConeExposureCohort } from '@/components/ConeExposureBars';

export const dynamic = 'force-dynamic';

const DEMO_STORM_ID = 'AL092024';
/** Florida-spanning bbox: [west, south, east, north]. */
const FL_BBOX: [number, number, number, number] = [-88, 24, -76, 32];

export default async function EventsPage() {
  const [cone, fires, cohortsRaw, scenarios]: [
    FetchNhcConeResult | null,
    FireDetection[],
    Awaited<ReturnType<typeof aggregateCohorts>>,
    GenerateScenariosResult | null,
  ] = await Promise.all([
    fetchNhcCone.handler({ storm_id: DEMO_STORM_ID }).catch(() => null),
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
    generateScenarios.handler({ storm_id: DEMO_STORM_ID, n: 100 }).catch(() => null),
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
      <EventConsole cone={coneWithEnvelope} fires={fires} cohorts={cohorts} />
    </>
  );
}
