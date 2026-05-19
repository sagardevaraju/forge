'use client';
import { INTENSITIES, type Intensity } from '@/lib/sim/severity';

export interface IntensityStripProps {
  intensity: Intensity;
  onChange: (i: Intensity) => void;
  effectiveDate: string;
  onDateChange: (d: string) => void;
}

export function IntensityStrip({ intensity, onChange, effectiveDate, onDateChange }: IntensityStripProps) {
  return (
    <div className="absolute bottom-2 left-2 right-2 bg-slate-900/95 border border-slate-700 rounded p-2 flex items-center gap-3 text-xs">
      <span className="text-slate-400">Intensity</span>
      {INTENSITIES.map((i) => (
        <button
          key={i}
          type="button"
          aria-pressed={intensity === i}
          onClick={() => onChange(i)}
          className={`px-2 py-0.5 rounded ${intensity === i ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >{i}</button>
      ))}
      <span className="ml-auto text-slate-400">Effective</span>
      <input
        type="date"
        value={effectiveDate}
        onChange={(e) => onDateChange(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-slate-200"
      />
    </div>
  );
}
