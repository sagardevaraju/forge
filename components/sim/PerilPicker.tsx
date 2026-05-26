'use client';
import { PERILS, PERIL_LABELS, type Peril } from '@/lib/sim/severity';
import { InfoIcon } from '@/components/grammar/InfoTooltip';

const LABELS = PERIL_LABELS;

const COLORS: Record<Peril, string> = {
  tornado: '#ff5247',
  flood: '#3b82f6',
  hail: '#a78bfa',
  wildfire: '#f97316',
  earthquake: '#fbbf24',
  winter: '#60a5fa',
};

export interface PerilPickerProps {
  active: Peril;
  onChange: (peril: Peril) => void;
}

export function PerilPicker({ active, onChange }: PerilPickerProps) {
  return (
    <div className="flex flex-col gap-1" role="group" aria-label="Select peril">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">+ New simulation</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 inline-flex items-center gap-1">
        Peril <InfoIcon term="peril" iconSize="sm" />
      </div>
      {PERILS.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={active === p}
          onClick={() => onChange(p)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm ${
            active === p ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <span aria-hidden className="inline-block w-2 h-2 rounded-full" style={{ background: COLORS[p] }} />
          {LABELS[p]}
        </button>
      ))}
    </div>
  );
}
