'use client';
/**
 * InfoTooltip — the single tooltip primitive for explaining domain jargon
 * across the FORGE UI. See spec at
 * `docs/superpowers/specs/2026-05-25-tooltip-glossary-design.md`.
 *
 * Three exports compose the same internal popup:
 *   - <InfoIcon term="..." />       bare icon (most common)
 *   - <Term term="..." children?>   wraps a phrase + appends the icon
 *   - <InfoTooltip term="..." children>  custom-trigger advanced form
 *
 * No external popover / tooltip dependencies. Inline Lucide-style info-SVG
 * (variant D from the 2026-05-25 brainstorm). Hover and focus reveal the
 * popup; click pinning + Esc + outside-click dismiss land in Task 3.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { lookupTerm } from '@/lib/grammar/glossary';

// 'pinned' is wired in Plan Task 3 (click-to-pin); the guards in
// useTooltipState below already check for it so Task 3 only touches
// the click handler.
type PopupState = 'closed' | 'open' | 'pinned';

interface InfoTooltipProps {
  term: string;
  children?: ReactNode;
  /** Icon size; "sm" = 12 px (table headers), "md" = 14 px (default). */
  iconSize?: 'sm' | 'md';
  /** Optional override class on the wrapper span. */
  className?: string;
}

interface PopupRendererProps {
  term: string;
  state: PopupState;
  popupId: string;
}

function PopupRenderer({ term, state, popupId }: PopupRendererProps) {
  const entry = lookupTerm(term);
  if (!entry) return null;
  return (
    <div
      id={popupId}
      role="tooltip"
      data-state={state}
      className={[
        'absolute left-0 top-full mt-1.5 z-50 w-[280px]',
        'rounded-md border bg-white p-3 shadow-[0_6px_20px_rgba(24,24,27,0.12),0_1px_3px_rgba(24,24,27,0.08)]',
        'text-[12px] leading-[1.45] text-zinc-900 font-normal normal-case tracking-normal',
        'transition-opacity duration-100',
        state === 'closed'
          ? 'opacity-0 invisible pointer-events-none'
          : 'opacity-100 visible',
      ].join(' ')}
      style={{ borderColor: 'rgba(24, 24, 27, 0.14)' }}
    >
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-emerald-700">
        {entry.label}
      </div>
      <div className="text-zinc-900">{entry.definition}</div>
      {entry.example && (
        <div className="mt-2 border-t border-zinc-200/70 pt-1.5 text-[11px] italic text-zinc-500">
          {entry.example}
        </div>
      )}
      {entry.source && (
        <a
          href={`/methodology#${entry.source}`}
          className="mt-1.5 inline-block text-[10.5px] text-emerald-700 hover:underline"
        >
          → See methodology
        </a>
      )}
    </div>
  );
}

function InfoSvg({ size }: { size: 'sm' | 'md' }) {
  const px = size === 'sm' ? 12 : 14;
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

interface CoreProps extends InfoTooltipProps {
  /** When provided, the trigger renders these children INSIDE the button instead of just the icon. */
  triggerChildren?: ReactNode;
}

function useTooltipState() {
  const [state, setState] = useState<PopupState>('closed');
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLeaveTimer = () => {
    if (leaveTimer.current !== null) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const handlePointerEnter = useCallback(() => {
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? prev : 'open'));
  }, []);

  const handlePointerLeave = useCallback(() => {
    clearLeaveTimer();
    // 100 ms grace so the cursor can cross the gap to the popup.
    leaveTimer.current = setTimeout(() => {
      setState((prev) => (prev === 'pinned' ? prev : 'closed'));
    }, 100);
  }, []);

  const handleFocus = useCallback(() => {
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? prev : 'open'));
  }, []);

  const handleBlur = useCallback(
    (e: FocusEvent<HTMLSpanElement>) => {
      // If focus moved to another element inside the wrapper (e.g. the
      // methodology link inside the popup), keep it open. The bubbled
      // FocusEvent's `relatedTarget` is the element receiving focus.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      clearLeaveTimer();
      setState((prev) => (prev === 'pinned' ? prev : 'closed'));
    },
    [],
  );

  useEffect(() => () => clearLeaveTimer(), []);

  return {
    state,
    setState,
    handlers: {
      onPointerEnter: handlePointerEnter,
      onPointerLeave: handlePointerLeave,
      onFocus: handleFocus,
      onBlur: handleBlur,
    },
  };
}

function CoreTooltip({ term, iconSize = 'md', className, triggerChildren }: CoreProps) {
  const popupId = useId();
  const entry = lookupTerm(term);
  const { state, handlers } = useTooltipState();

  // If the entry doesn't exist, render a no-popup placeholder marked for the
  // glossary-coverage sweep test. The trigger is still a <button> so layout
  // (and the icon footprint) doesn't jump versus a real glossary hit; the
  // `data-testid="glossary-missing"` attribute is what the sweep test asserts
  // when scanning the rendered UI for missing keys.
  if (!entry) {
    return (
      <span
        className={['relative inline-flex items-center gap-1', className].filter(Boolean).join(' ')}
      >
        <button
          type="button"
          data-testid="glossary-missing"
          data-term={term}
          aria-label={`Missing glossary entry: ${term}`}
          className={[
            'inline-flex items-center gap-1 text-zinc-300',
            'outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 rounded',
          ].join(' ')}
        >
          {triggerChildren}
          <InfoSvg size={iconSize} />
        </button>
      </span>
    );
  }

  return (
    <span
      className={['relative inline-flex items-center gap-1', className].filter(Boolean).join(' ')}
      {...handlers}
    >
      <button
        type="button"
        aria-describedby={popupId}
        aria-label={`Definition of ${entry.label}`}
        className={[
          'inline-flex items-center gap-1 text-zinc-500 hover:text-emerald-700 focus:text-emerald-700',
          'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 rounded',
        ].join(' ')}
      >
        {triggerChildren}
        <InfoSvg size={iconSize} />
      </button>
      <PopupRenderer term={term} state={state} popupId={popupId} />
    </span>
  );
}

export function InfoIcon({ term, iconSize = 'md', className }: InfoTooltipProps) {
  return <CoreTooltip term={term} iconSize={iconSize} className={className} />;
}

export function Term({ term, children, iconSize = 'md', className }: InfoTooltipProps) {
  const entry = lookupTerm(term);
  const label = children ?? entry?.label ?? term;
  return (
    <CoreTooltip
      term={term}
      iconSize={iconSize}
      className={className}
      triggerChildren={<span className="mr-0.5">{label}</span>}
    />
  );
}

export function InfoTooltip({ term, children, iconSize, className }: InfoTooltipProps) {
  return (
    <CoreTooltip
      term={term}
      iconSize={iconSize}
      className={className}
      triggerChildren={children}
    />
  );
}
