/**
 * Task SIM.21 — /simulate route.
 *
 * Server component: loads the sim list + (optionally) one selected sim by
 * `?id=`. Delegates all interactivity to <SimWorkspace>. force-dynamic
 * because the sim list is mutable per request.
 */
import { db } from '@/lib/db/client';
import { SimWorkspace } from '@/components/sim/SimWorkspace';
import { parseFootprint, type SimulationFootprint } from '@/lib/sim/footprint';
import { loadBookPolicies } from '@/lib/sim/book';
import { previewImpact, type PreviewImpact } from '@/lib/sim/preview';

export const dynamic = 'force-dynamic';

export default async function SimulatePage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const list = await db.execute(
    'SELECT id, name, peril, intensity, promoted, retired, drawn_at FROM simulations ORDER BY drawn_at DESC LIMIT 100',
  );
  const sims = list.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    peril: String(row.peril),
    intensity: String(row.intensity),
    promoted: Number(row.promoted) === 1,
    retired: Number(row.retired) === 1,
    drawn_at: String(row.drawn_at),
  }));

  // Load the selected sim's footprint and recompute its preview impact, so a
  // sim opened by ?id= shows numbers immediately instead of an empty panel
  // until the operator next touches the SeverityStrip.
  let initialFootprint: SimulationFootprint | null = null;
  let initialImpact: PreviewImpact | null = null;
  if (id) {
    const r = await db.execute({ sql: 'SELECT footprint FROM simulations WHERE id = ?', args: [id] });
    if (r.rows[0]) {
      initialFootprint = parseFootprint(JSON.parse(String(r.rows[0].footprint)));
      initialImpact = previewImpact(await loadBookPolicies(), initialFootprint);
    }
  }

  return (
    <SimWorkspace
      initialSims={sims}
      initialSimId={id ?? null}
      initialFootprint={initialFootprint}
      initialImpact={initialImpact}
    />
  );
}
