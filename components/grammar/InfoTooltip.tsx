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
 * popup; click pins it open with Esc + outside-click dismissal (Task 3).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { lookupTerm } from '@/lib/grammar/glossary';

// 'closed' = hidden; 'open' = hover/focus reveal (auto-dismisses);
// 'pinned' = click-to-pin (Task 3), persists until Esc, outside click,
// or a second click on the trigger.
type PopupState = 'closed' | 'open' | 'pinned';

// Popup placement (Task 4). 'bottom-start' = popup left-aligned with the
// trigger (default); 'bottom-end' = right-aligned, used when the trigger
// sits in the right 30 % of the viewport so the 280 px popup grows
// leftward instead of clipping. Top placements are out of scope.
type Placement = 'bottom-start' | 'bottom-end';

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
  placement: Placement;
}

function PopupRenderer({ term, state, popupId, placement }: PopupRendererProps) {
  const entry = lookupTerm(term);
  if (!entry) return null;
  const alignClass = placement === 'bottom-end' ? 'right-0' : 'left-0';
  return (
    <div
      id={popupId}
      role="tooltip"
      aria-hidden={state === 'closed'}
      data-state={state}
      data-placement={placement}
      className={[
        'absolute top-full mt-1.5 z-50 w-[280px]',
        alignClass,
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

function useTooltipState(triggerRef: RefObject<HTMLElement | null>) {
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

  const handleClick = useCallback(() => {
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? 'closed' : 'pinned'));
  }, []);

  // Esc + outside-click dismissal only fires when the popup is pinned.
  useEffect(() => {
    if (state !== 'pinned') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState('closed');
    };
    const onDown = (e: MouseEvent) => {
      if (!triggerRef.current) return;
      const target = e.target as Node;
      if (triggerRef.current.contains(target)) return;
      setState('closed');
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [state, triggerRef]);

  useEffect(() => () => clearLeaveTimer(), []);

  return {
    state,
    setState,
    handlers: {
      onPointerEnter: handlePointerEnter,
      onPointerLeave: handlePointerLeave,
      onFocus: handleFocus,
      onBlur: handleBlur,
      onClick: handleClick,
    },
  };
}

function CoreTooltip({ term, iconSize = 'md', className, triggerChildren }: CoreProps) {
  const popupId = useId();
  const entry = lookupTerm(term);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const { state, handlers } = useTooltipState(wrapperRef);
  const [placement, setPlacement] = useState<Placement>('bottom-start');

  // Recompute placement when the popup opens, so we read the actual
  // trigger position at that moment (and not whatever it was at mount).
  // Flip to bottom-end (right-aligned popup) when the trigger sits in
  // the right 30 % of the viewport — gives the 280 px popup room to grow
  // leftward without clipping the viewport edge.
  useEffect(() => {
    if (state === 'closed') return;
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    setPlacement(rect.left > vw * 0.7 ? 'bottom-end' : 'bottom-start');
  }, [state]);

  // If the entry doesn't exist, render a no-popup placeholder marked for the
  // glossary-coverage sweep test. The trigger is still a <button> so layout
  // (and the icon footprint) doesn't jump versus a real glossary hit; the
  // `data-testid="glossary-missing"` attribute is what the sweep test asserts
  // when scanning the rendered UI for missing keys.
  if (!entry) {
    return (
      <span
        ref={wrapperRef}
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

  const { onClick, ...spanHandlers } = handlers;

  return (
    <span
      ref={wrapperRef}
      className={['relative inline-flex items-center gap-1', className].filter(Boolean).join(' ')}
      {...spanHandlers}
    >
      <button
        type="button"
        onClick={onClick}
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
      <PopupRenderer term={term} state={state} popupId={popupId} placement={placement} />
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
