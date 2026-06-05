'use client';
import type { PreviewImpact } from '@/lib/sim/preview';
import { fmtUSD } from '@/lib/sim/format';

export interface ImpactPanelProps {
  impact: PreviewImpact | null;
}

export function ImpactPanel({ impact }: ImpactPanelProps) {
  if (!impact) {
    return (
      <div className="text-sm text-slate-400 italic">
        Draw a footprint to see impact estimate.
      </div>
    );
  }
  const zero = impact.policies_in_footprint === 0;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="text-xs uppercase tracking-wider text-slate-400">Preview impact</div>
      <div className="flex justify-between items-center pb-2 border-b border-slate-800">
        <span className="text-slate-400">Est. gross loss</span>
        <span className="text-2xl font-semibold text-red-400 tabular-nums">{fmtUSD(impact.gross_loss_estimate)}</span>
      </div>
      <Row label="Policies in footprint" value={impact.policies_in_footprint.toLocaleString()} />
      <Row label="TIV in footprint" value={fmtUSD(impact.tiv_in_footprint)} />
      <Row label="Cohorts affected" value={impact.cohorts_affected.toString()} />
      <Row label="Mean damage ratio" value={`${(impact.mean_damage_ratio * 100).toFixed(1)}%`} />
      {zero && (
        <div className="text-xs text-amber-400 bg-amber-950/40 border border-amber-900 rounded px-2 py-1">
          0 policies in footprint — promote anyway?
        </div>
      )}
      {impact.top_cohorts.length > 0 && (
        <div className="mt-2">
          <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">Top cohorts</div>
          {impact.top_cohorts.map((c) => (
            <div key={c.cohort_id} className="flex justify-between text-xs py-0.5 text-slate-300">
              <span>{c.cohort_id}</span>
              <span className="text-red-300 tabular-nums">{fmtUSD(c.loss)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-slate-800">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-200 tabular-nums">{value}</span>
    </div>
  );
}
