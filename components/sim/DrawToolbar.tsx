'use client';
import type { Peril } from '@/lib/sim/severity';

export interface DrawToolbarProps {
  peril: Peril;
  onUndo: () => void;
  onClear: () => void;
}

export function DrawToolbar({ peril, onUndo, onClear }: DrawToolbarProps) {
  const primaryLabel: Record<Peril, string> = {
    tornado: '▱ swath',
    flood: '▭ polygon',
    hail: '▭ polygon',
    wildfire: '▭ perimeter',
    earthquake: '⊙ epicenter',
    winter: '▭ area',
  };
  return (
    <div className="absolute top-2 left-2 bg-slate-900/95 border border-slate-700 rounded p-1 flex gap-1 text-xs">
      <span className="px-2 py-1 rounded bg-blue-600 text-white">{primaryLabel[peril]}</span>
      <button type="button" onClick={onUndo} className="px-2 py-1 text-slate-300 hover:text-white">↶ undo</button>
      <button type="button" onClick={onClear} className="px-2 py-1 text-slate-300 hover:text-white">⌫ clear</button>
    </div>
  );
}
