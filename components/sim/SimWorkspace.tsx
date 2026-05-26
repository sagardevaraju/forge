'use client';
/**
 * SimWorkspace — 3-column layout composing the full simulate tab.
 *
 * Column 1 (200 px): PerilPicker + SimLibrary
 * Column 2 (flex):   SimMap (owns TerraDraw lifecycle)
 * Column 3 (280 px): ImpactPanel + PromoteButton
 *
 * State: activePeril, severity, effectiveDate, currentFootprint, simId.
 * On every valid footprint, POSTs /api/sim → stores sim_id + preview impact.
 * v1 always creates a new draft on "Save" (no PATCH flow yet).
 *
 * Task 20: SimMap + SimWorkspace.
 * Task 8 / peril-intensity-scales: per-peril severity state.
 */
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SimMap } from './SimMap';
import { PerilPicker } from './PerilPicker';
import { SimLibrary, type SimListItem } from './SimLibrary';
import { ImpactPanel } from './ImpactPanel';
import { PromoteButton } from './PromoteButton';
import { rebuildFootprint, type SimulationFootprint } from '@/lib/sim/footprint';
import { PERIL_SCALES, perilLabel, severityLabel, type Peril, type SeverityValue } from '@/lib/sim/severity';
import type { PreviewImpact } from '@/lib/sim/preview';
import { InfoIcon } from '@/components/grammar/InfoTooltip';

export interface SimWorkspaceProps {
  initialSims: SimListItem[];
  initialSimId: string | null;
  initialFootprint?: SimulationFootprint | null;
  initialImpact?: PreviewImpact | null;
}

export function SimWorkspace(props: SimWorkspaceProps) {
  const router = useRouter();
  const search = useSearchParams();

  const initialPeril: Peril = props.initialFootprint?.peril ?? 'hail';
  const [peril, setPeril] = useState<Peril>(initialPeril);
  const [severity, setSeverity] = useState<SeverityValue>(
    props.initialFootprint?.severity ?? PERIL_SCALES[initialPeril].default,
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

  // Switching peril resets severity to the new peril's scale default — a Mw
  // value is meaningless as a hail diameter, etc.
  function changePeril(p: Peril) {
    setPeril(p);
    setSeverity(PERIL_SCALES[p].default);
  }

  // Honour ?peril= query param (set by PerilPicker links in other pages).
  useEffect(() => {
    const p = search.get('peril') as Peril | null;
    if (p) changePeril(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function onFootprintChange(fp: SimulationFootprint) {
    setCurrentFootprint(fp);
    // v1: always POST — creates a new draft. PATCH path is out of scope.
    const res = await fetch('/api/sim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `${perilLabel(fp.peril)}, ${severityLabel(fp.peril, fp.severity)} - ${new Date().toISOString().slice(0, 10)}`,
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

  // Re-apply severity / effective-date changes to an existing footprint.
  // Without this the SeverityStrip silently does nothing once a footprint is
  // drawn — the impact panel and the stored sim stay frozen at draw-time
  // values. For earthquake this resizes the Mw-derived circle; for tornado it
  // re-buffers the swath to the new EF width.
  useEffect(() => {
    if (!currentFootprint) return;
    // A peril switch resets `severity` (changePeril), firing this effect while
    // `currentFootprint` is still the previous peril's footprint. Never rebuild
    // a footprint through a different peril's geometry path.
    if (currentFootprint.peril !== peril) return;
    if (
      currentFootprint.severity === severity &&
      currentFootprint.effective_date === effectiveDate
    ) {
      return;
    }
    onFootprintChange(rebuildFootprint(currentFootprint, severity, effectiveDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity, effectiveDate]);

  return (
    <div className="grid grid-cols-[200px_1fr_280px] gap-0 h-[calc(100vh-3rem)]">
      {/* Left column: peril picker + saved sims library */}
      <aside className="border-r border-slate-800 p-3 overflow-y-auto">
        <PerilPicker active={peril} onChange={changePeril} />
        <SimLibrary
          sims={sims}
          activeId={simId}
          onSelect={(id) => router.push(`/simulate?id=${id}`)}
        />
      </aside>

      {/* Centre column: map + drawing tools */}
      <main className="relative">
        <div className="absolute top-2 left-2 z-10 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-300 bg-slate-900/80 border border-slate-700 rounded px-2 py-1 shadow">
          Footprint <InfoIcon term="footprint" iconSize="sm" />
        </div>
        <SimMap
          peril={peril}
          severity={severity}
          onSeverityChange={setSeverity}
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
