'use client';
/**
 * SimWorkspace — 3-column layout composing the full simulate tab.
 *
 * Column 1 (200 px): PerilPicker + SimLibrary
 * Column 2 (flex):   SimMap (owns TerraDraw lifecycle)
 * Column 3 (280 px): ImpactPanel + PromoteButton
 *
 * State: activePeril, intensity, effectiveDate, currentFootprint, simId.
 * On every valid footprint, POSTs /api/sim → stores sim_id + preview impact.
 * v1 always creates a new draft on "Save" (no PATCH flow yet).
 *
 * Task 20: SimMap + SimWorkspace.
 */
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SimMap } from './SimMap';
import { PerilPicker } from './PerilPicker';
import { SimLibrary, type SimListItem } from './SimLibrary';
import { ImpactPanel } from './ImpactPanel';
import { PromoteButton } from './PromoteButton';
import type { SimulationFootprint } from '@/lib/sim/footprint';
import type { Peril, Intensity } from '@/lib/sim/severity';
import type { PreviewImpact } from '@/lib/sim/preview';

export interface SimWorkspaceProps {
  initialSims: SimListItem[];
  initialSimId: string | null;
  initialFootprint?: SimulationFootprint | null;
  initialImpact?: PreviewImpact | null;
}

export function SimWorkspace(props: SimWorkspaceProps) {
  const router = useRouter();
  const search = useSearchParams();

  const [peril, setPeril] = useState<Peril>(props.initialFootprint?.peril ?? 'hail');
  const [intensity, setIntensity] = useState<Intensity>(
    props.initialFootprint?.intensity ?? 'severe',
  );
  const [effectiveDate, setEffectiveDate] = useState(
    props.initialFootprint?.effective_date ?? new Date().toISOString().slice(0, 10),
  );
  const [simId, setSimId] = useState<string | null>(props.initialSimId);
  const [impact, setImpact] = useState<PreviewImpact | null>(props.initialImpact ?? null);
  const [sims, setSims] = useState(props.initialSims);
  const [currentFootprint, setCurrentFootprint] = useState<SimulationFootprint | null>(
    props.initialFootprint ?? null,
  );
  const [promoted, setPromoted] = useState(
    props.initialSimId
      ? !!(props.initialSims.find((s) => s.id === props.initialSimId)?.promoted)
      : false,
  );

  // Honour ?peril= query param (set by PerilPicker links in other pages).
  useEffect(() => {
    const p = search.get('peril') as Peril | null;
    if (p) setPeril(p);
  }, [search]);

  async function onFootprintChange(fp: SimulationFootprint) {
    setCurrentFootprint(fp);
    // v1: always POST — creates a new draft. PATCH path is out of scope.
    const res = await fetch('/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `${fp.peril}, ${fp.intensity} — ${new Date().toISOString().slice(0, 10)}`,
        footprint: fp,
      }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { sim_id: string; impact: PreviewImpact };
    setSimId(body.sim_id);
    setImpact(body.impact);
    setPromoted(false);

    // Refresh the sims library sidebar.
    const listRes = await fetch('/api/sim');
    if (listRes.ok) {
      const listBody = (await listRes.json()) as { sims: SimListItem[] };
      setSims(listBody.sims);
    }

    router.replace(`/simulate?id=${body.sim_id}`);
  }

  return (
    <div className="grid grid-cols-[200px_1fr_280px] gap-0 h-[calc(100vh-3rem)]">
      {/* Left column: peril picker + saved sims library */}
      <aside className="border-r border-slate-800 p-3 overflow-y-auto">
        <PerilPicker active={peril} onChange={setPeril} />
        <SimLibrary
          sims={sims}
          activeId={simId}
          onSelect={(id) => router.push(`/simulate?id=${id}`)}
        />
      </aside>

      {/* Centre column: map + drawing tools */}
      <main className="relative">
        <SimMap
          peril={peril}
          intensity={intensity}
          onIntensityChange={setIntensity}
          effectiveDate={effectiveDate}
          onEffectiveDateChange={setEffectiveDate}
          onFootprintChange={onFootprintChange}
          currentFootprint={currentFootprint}
        />
      </main>

      {/* Right column: preview impact + promote */}
      <aside className="border-l border-slate-800 p-4 overflow-y-auto">
        <ImpactPanel impact={impact} />
        <PromoteButton
          simId={simId}
          promoted={promoted}
          onPromoted={() => setPromoted(true)}
        />
      </aside>
    </div>
  );
}
