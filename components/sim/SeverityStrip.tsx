'use client';
/**
 * SeverityStrip — peril-aware severity + effective-date control overlaid on
 * the SimMap. Replaces the universal three-tier IntensityStrip.
 *
 * Rendered off PERIL_SCALES[peril]: continuous perils (earthquake, hail) get
 * a range slider with a live readout; discrete perils (tornado, flood,
 * wildfire, winter) get a segmented row of scale-level buttons. See
 * lib/sim/severity.ts and research.md for the per-peril scales.
 *
 * Visibility fix (spec S5): the card sits at bottom-8 / left-2 — lifted clear
 * of the ~24 px MapLibre attribution bar, content-fit width, left-anchored so
 * the date control is never occluded by the bottom-right attribution widget.
 */
import {
  PERIL_SCALES,
  severityLabel,
  type Peril,
  type SeverityValue,
} from '@/lib/sim/severity';
import { mmiRadiusKm } from '@/lib/sim/footprint';
import { InfoIcon } from '@/components/grammar/InfoTooltip';

export interface SeverityStripProps {
  peril: Peril;
  severity: SeverityValue;
  onSeverityChange: (s: SeverityValue) => void;
  effectiveDate: string;
  onDateChange: (d: string) => void;
}

/** Live readout for a continuous control — earthquake appends the MMI-VI radius. */
function readout(peril: Peril, severity: SeverityValue): string {
  const label = severityLabel(peril, severity);
  if (peril === 'earthquake' && typeof severity === 'number') {
    return `${label} - ~${Math.round(mmiRadiusKm(severity, 6))} km radius`;
  }
  return label;
}

export function SeverityStrip({
  peril,
  severity,
  onSeverityChange,
  effectiveDate,
  onDateChange,
}: SeverityStripProps) {
  const scale = PERIL_SCALES[peril];
  return (
    <div className="absolute bottom-8 left-2 bg-slate-900/95 border border-slate-700 rounded-lg p-3 flex items-center gap-4 text-xs shadow-lg">
      <div className="flex items-center gap-3">
        <span className="text-slate-400 uppercase tracking-wide inline-flex items-center gap-1">
          Severity <InfoIcon term="severity" iconSize="sm" />
        </span>
        {scale.kind === 'continuous' ? (
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={scale.min}
              max={scale.max}
              step={scale.step}
              value={typeof severity === 'number' ? severity : scale.default}
              onChange={(e) => onSeverityChange(Number(e.target.value))}
              className="w-40 accent-blue-500"
            />
            <span className="text-slate-200 tabular-nums whitespace-nowrap">
              {readout(peril, severity)}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {scale.levels.map((lvl) => (
              <button
                key={lvl.id}
                type="button"
                aria-pressed={severity === lvl.id}
                onClick={() => onSeverityChange(lvl.id)}
                className={`flex flex-col items-center px-2 py-1 rounded ${
                  severity === lvl.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <span className="font-medium">{lvl.label}</span>
                {lvl.sublabel && <span className="text-[10px] opacity-80">{lvl.sublabel}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-l border-slate-700 pl-4">
        <span className="text-slate-400">Effective</span>
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => onDateChange(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-slate-200"
        />
      </div>
    </div>
  );
}
