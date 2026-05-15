/**
 * Task 21 — Event Console route.
 *
 * Server component: pulls the demo storm's NHC cone and a recent FIRMS
 * snapshot directly via the agent tool handlers (no LLM round-trip for raw
 * map data). Both tools have built-in mock fallbacks, so the page renders
 * deterministically even on a fresh clone with no API keys.
 *
 * `force-dynamic` keeps the cone fresh — the upstream NHC JSON updates with
 * each advisory and we never want stale Vercel ISR data sitting in front of
 * an operational view.
 */
import { EventConsole } from '@/components/EventConsole';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';
import { fetchFirmsFires } from '@/app/api/agent/tools/fetch_firms_fires';
import type { FetchNhcConeResult } from '@/app/api/agent/tools/fetch_nhc_cone';
import type { FireDetection } from '@/app/api/agent/tools/fetch_firms_fires';

export const dynamic = 'force-dynamic';

const DEMO_STORM_ID = 'AL092024';
/** Florida-spanning bbox: [west, south, east, north]. */
const FL_BBOX: [number, number, number, number] = [-88, 24, -76, 32];

export default async function EventsPage() {
  const [cone, fires]: [FetchNhcConeResult | null, FireDetection[]] = await Promise.all([
    fetchNhcCone.handler({ storm_id: DEMO_STORM_ID }).catch(() => null),
    fetchFirmsFires.handler({ bbox: FL_BBOX, hours: 24 }).catch(() => []),
  ]);
  return <EventConsole cone={cone} fires={fires} />;
}
