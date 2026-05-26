'use client';

/**
 * Task P2.11 (Redesign Phase 2) — WhatIfControl grammar primitive.
 *
 * Sidebar-rail slider that lets the operator propose a scalar override
 * (capital budget, target loss ratio, retention dollars …) and explicitly
 * commit it to a downstream solver. The control surfaces three states on a
 * single rail so the proposal is always read relative to where the book
 * currently sits and where it started:
 *
 *   ├──┬──●──◆────────────┤
 *      │  │  └ proposed  (colored marker — what the user is about to commit)
 *      │  └─── current   (solid neutral marker — where the book is now)
 *      └────── baseline  (gray tick — the unmodified starting value)
 *
 * The CRITICAL invariant is that `onCommit` fires only on explicit commit
 * gestures (slider release, numeric Enter / blur) — never on every drag
 * tick. Re-solving the Portfolio MIP costs ~30s, so scrubbing must not
 * hammer the route. P2.12 wires the commit to `/api/optimize/portfolio`.
 *
 * Pure primitive — no data-fetching, no page coupling. Composed by the
 * Phase 2 portfolio sidebar in P2.13.
 */

import { useEffect, useRef, useState } from 'react';
import { InfoIcon } from '@/components/grammar/InfoTooltip';

interface WhatIfControlProps {
  label: string;
  baseline: number; // gray tick on the rail
  current: number; // solid neutral marker
  min: number;
  max: number;
  step?: number; // defaults to (max-min)/100 or 1
  format?: (v: number) => string;
  unit?: string; // suffix appended after the raw number when no `format` is given
  ariaLabel?: string;
  disabled?: boolean;
  onCommit: (proposed: number) => void;
  /** Optional glossary term — when provided, renders an InfoIcon next to the label. */
  term?: string;
  /**
   * Display scale for the numeric input only. `display = raw / inputScale`
   * and the input commits `Number(text) * inputScale` as the raw value
   * passed to `onCommit`. Use 1e6 for millions, 0.01 for percentage points,
   * etc. Defaults to 1 (no rescaling — input shows raw values).
   */
  inputScale?: number;
  /** Decimal places shown in the numeric input. Defaults to 0 when `inputScale === 1`, else 2. */
  inputDecimals?: number;
  /** Optional unit suffix rendered next to the numeric input (e.g. "M", "%"). */
  inputSuffix?: string;
}

const clamp = (v: number, min: number, max: number) =>
  v < min ? min : v > max ? max : v;

const positionPercent = (v: number, min: number, max: number) =>
  max === min ? 0 : ((clamp(v, min, max) - min) / (max - min)) * 100;

const defaultFormatter = (unit?: string) => (v: number) =>
  unit ? `${v}${unit}` : `${v}`;

export function WhatIfControl({
  label,
  baseline,
  current,
  min,
  max,
  step,
  format,
  unit,
  ariaLabel,
  disabled,
  onCommit,
  inputScale = 1,
  inputDecimals,
  inputSuffix,
  term,
}: WhatIfControlProps) {
  const resolvedDecimals = inputDecimals ?? (inputScale === 1 ? 0 : 2);
  const formatForInput = (raw: number): string => {
    const display = raw / inputScale;
    if (resolvedDecimals === 0) return String(Math.round(display));
    // Strip trailing zeros so 31.40 → 31.4 (less digit noise) while keeping
    // precision for finer slider steps.
    return parseFloat(display.toFixed(resolvedDecimals)).toString();
  };

  const [proposed, setProposed] = useState<number>(current);
  const [draftText, setDraftText] = useState<string>(formatForInput(current));
  const lastCommittedRef = useRef<number>(current);

  // When the parent updates `current` (e.g. after a successful solve), the
  // control re-syncs so the user sees the new baseline as the starting point
  // for further what-ifs.
  useEffect(() => {
    setProposed(current);
    setDraftText(formatForInput(current));
    lastCommittedRef.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const fmt = format ?? defaultFormatter(unit);
  const resolvedStep = step ?? Math.max((max - min) / 100, 1);
  const resolvedAriaLabel = ariaLabel ?? label;
  const isDirty = proposed !== current;

  const commit = (value: number) => {
    if (disabled) return;
    const clamped = clamp(value, min, max);
    if (clamped === lastCommittedRef.current) return;
    lastCommittedRef.current = clamped;
    setProposed(clamped);
    setDraftText(formatForInput(clamped));
    onCommit(clamped);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    if (Number.isFinite(next)) {
      setProposed(next);
      setDraftText(formatForInput(next));
    }
  };

  const handleSliderRelease = () => {
    commit(proposed);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraftText(e.target.value);
    const parsed = Number(e.target.value);
    if (Number.isFinite(parsed) && e.target.value.trim() !== '') {
      setProposed(clamp(parsed * inputScale, min, max));
    }
  };

  const commitFromInput = () => {
    if (draftText.trim() === '') return;
    const parsed = Number(draftText);
    if (!Number.isFinite(parsed)) return;
    commit(parsed * inputScale);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitFromInput();
    }
  };

  const baselinePct = positionPercent(baseline, min, max);
  const currentPct = positionPercent(current, min, max);
  const proposedPct = positionPercent(proposed, min, max);

  return (
    <div
      data-testid="whatif-control"
      className={[
        'flex flex-col gap-2.5 py-3',
        disabled ? 'opacity-60' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={`whatif-${label}`}
          className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-zinc-500"
        >
          <span className="inline-flex items-center gap-1">
            {label}
            {term && <InfoIcon term={term} iconSize="sm" />}
          </span>
        </label>
        <div className="relative flex items-center">
          <input
            id={`whatif-${label}`}
            type="number"
            role="spinbutton"
            value={draftText}
            min={min / inputScale}
            max={max / inputScale}
            step={resolvedStep / inputScale}
            disabled={disabled}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onBlur={commitFromInput}
            aria-label={`${resolvedAriaLabel} numeric input`}
            className={[
              'w-20 text-[12px] tabular-nums ring-1 ring-zinc-200 rounded-md py-0.5 text-right text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/70 disabled:cursor-not-allowed',
              inputSuffix ? 'pl-2 pr-5' : 'px-2',
            ].join(' ')}
          />
          {inputSuffix && (
            <span
              aria-hidden="true"
              className="absolute right-2 text-[11px] text-zinc-500 pointer-events-none tabular-nums"
            >
              {inputSuffix}
            </span>
          )}
        </div>
      </div>

      <div className="relative h-8">
        {/* Rail */}
        <div className="absolute top-1/2 left-0 right-0 h-1 -translate-y-1/2 bg-zinc-200 rounded-full" />

        {/* Baseline tick (gray) */}
        <div
          data-testid="whatif-baseline"
          aria-hidden="true"
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-0.5 bg-zinc-400 rounded-sm"
          style={{ left: `${baselinePct}%` }}
          title={`baseline ${fmt(baseline)}`}
        />

        {/* Current marker (solid neutral) */}
        <div
          data-testid="whatif-current"
          aria-hidden="true"
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 bg-slate-700 border border-white rounded-full shadow-sm"
          style={{ left: `${currentPct}%` }}
          title={`current ${fmt(current)}`}
        />

        {/* Proposed marker (accent color) */}
        <div
          data-testid="whatif-proposed"
          aria-hidden="true"
          className={[
            'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-4 rounded-full border-2 border-white shadow ring-1 ring-emerald-600',
            isDirty ? 'bg-emerald-500' : 'bg-emerald-400',
          ].join(' ')}
          style={{ left: `${proposedPct}%` }}
          title={`proposed ${fmt(proposed)}`}
        />

        {/* The actual <input type="range"> sits on top, transparent so the
            three markers above show through. */}
        <input
          type="range"
          role="slider"
          min={min}
          max={max}
          step={resolvedStep}
          value={proposed}
          disabled={disabled}
          aria-label={resolvedAriaLabel}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={proposed}
          onChange={handleSliderChange}
          onMouseUp={handleSliderRelease}
          onTouchEnd={handleSliderRelease}
          onKeyUp={handleSliderRelease}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        />
      </div>

      <div className="flex justify-between text-[10px] text-zinc-500 tabular-nums">
        <span>
          <span className="inline-block h-1.5 w-1.5 rounded-sm bg-zinc-400 mr-1 align-middle" />
          baseline {fmt(baseline)}
        </span>
        <span>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-700 mr-1 align-middle" />
          current {fmt(current)}
        </span>
        <span className={isDirty ? 'text-emerald-700 font-medium' : ''}>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
          proposed {fmt(proposed)}
        </span>
      </div>
    </div>
  );
}
