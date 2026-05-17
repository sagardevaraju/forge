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
}: WhatIfControlProps) {
  const [proposed, setProposed] = useState<number>(current);
  const [draftText, setDraftText] = useState<string>(String(current));
  const lastCommittedRef = useRef<number>(current);

  // When the parent updates `current` (e.g. after a successful solve), the
  // control re-syncs so the user sees the new baseline as the starting point
  // for further what-ifs.
  useEffect(() => {
    setProposed(current);
    setDraftText(String(current));
    lastCommittedRef.current = current;
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
    setDraftText(String(clamped));
    onCommit(clamped);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    if (Number.isFinite(next)) {
      setProposed(next);
      setDraftText(String(next));
    }
  };

  const handleSliderRelease = () => {
    commit(proposed);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraftText(e.target.value);
    const next = Number(e.target.value);
    if (Number.isFinite(next) && e.target.value.trim() !== '') {
      setProposed(clamp(next, min, max));
    }
  };

  const commitFromInput = () => {
    if (draftText.trim() === '') return;
    const next = Number(draftText);
    if (!Number.isFinite(next)) return;
    commit(next);
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
        'flex flex-col gap-2 p-3 border rounded bg-white',
        disabled ? 'opacity-60' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={`whatif-${label}`}
          className="text-xs text-zinc-600 uppercase tracking-wide"
        >
          {label}
        </label>
        <input
          id={`whatif-${label}`}
          type="number"
          role="spinbutton"
          value={draftText}
          min={min}
          max={max}
          step={resolvedStep}
          disabled={disabled}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          onBlur={commitFromInput}
          aria-label={`${resolvedAriaLabel} numeric input`}
          className="w-24 text-xs border rounded px-1.5 py-1 text-right text-zinc-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:cursor-not-allowed"
        />
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
