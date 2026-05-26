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
 * popup; click pins it open with Esc + outside-click dismissal.
 *
 * 2026-05-26 — popup is now rendered via React's `createPortal` to
 * `document.body` with `position: fixed`, escaping every ancestor
 * `overflow: hidden` (PortfolioDrillDown, treaty bars, choropleth wrapper,
 * the portfolio page's own h-[60vh] overflow-hidden parent, etc.). Left is
 * clamped to the viewport so popups never clip horizontally regardless of
 * where the trigger sits.
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
import { createPortal } from 'react-dom';
import { lookupTerm } from '@/lib/grammar/glossary';

// 'closed' = hidden; 'open' = hover/focus reveal (auto-dismisses);
// 'pinned' = click-to-pin, persists until Esc, outside click, or a second
// click on the trigger.
type PopupState = 'closed' | 'open' | 'pinned';

// Popup placement. 'bottom-start' = popup left-aligned with the trigger
// (default); 'bottom-end' = right-aligned, used when the trigger sits late
// in the viewport so the 280 px popup grows leftward instead of clipping.
// Top placements are out of scope.
type Placement = 'bottom-start' | 'bottom-end';

// Visual constants. Popup width is a hard contract — the placement math
// and the viewport-clamp both reference it; if you bump it, bump these too.
const POPUP_WIDTH = 280;
const POPUP_GAP = 6; // vertical distance from trigger bottom to popup top
const VIEWPORT_PADDING = 8; // min distance from popup edge to viewport edge

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
  anchorRect: DOMRect | null;
  popupRef: RefObject<HTMLDivElement | null>;
}

function PopupRenderer({
  term,
  state,
  popupId,
  placement,
  anchorRect,
  popupRef,
}: PopupRendererProps) {
  const entry = lookupTerm(term);
  // SSR guard — `createPortal(..., document.body)` requires a real document.
  if (typeof document === 'undefined') return null;
  if (!entry) return null;

  // Compute viewport-fixed position from the trigger's bounding rect.
  // Before the first measurement we park the popup off-screen rather than
  // at (0,0) so it never flashes in the corner.
  let top = -9999;
  let left = -9999;
  if (anchorRect) {
    top = anchorRect.bottom + POPUP_GAP;
    if (placement === 'bottom-end') {
      // Right-aligned: popup's right edge matches the trigger's right edge.
      left = anchorRect.right - POPUP_WIDTH;
    } else {
      // Left-aligned: popup's left edge matches the trigger's left edge.
      left = anchorRect.left;
    }
    // Clamp inside the viewport so the popup never clips horizontally
    // regardless of which side of the page the trigger sits on.
    const vw =
      typeof window !== 'undefined' ? window.innerWidth : POPUP_WIDTH * 4;
    if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;
    if (left + POPUP_WIDTH > vw - VIEWPORT_PADDING) {
      left = vw - POPUP_WIDTH - VIEWPORT_PADDING;
    }
  }

  const popup = (
    <div
      ref={popupRef}
      id={popupId}
      role="tooltip"
      aria-hidden={state === 'closed'}
      data-state={state}
      data-placement={placement}
      style={{
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
        width: `${POPUP_WIDTH}px`,
        zIndex: 9999,
        borderColor: 'rgba(24, 24, 27, 0.14)',
      }}
      className={[
        'rounded-md border bg-white p-3 shadow-[0_6px_20px_rgba(24,24,27,0.12),0_1px_3px_rgba(24,24,27,0.08)]',
        'text-[12px] leading-[1.45] text-zinc-900 font-normal normal-case tracking-normal',
        'transition-opacity duration-100',
        state === 'closed'
          ? 'opacity-0 invisible pointer-events-none'
          : 'opacity-100 visible',
      ].join(' ')}
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

  return createPortal(popup, document.body);
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

function useTooltipState(
  triggerRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
) {
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

  const handleBlur = useCallback((e: FocusEvent<HTMLSpanElement>) => {
    // If focus moved into the trigger wrapper OR into the (portaled) popup,
    // keep it open. We have to check both because the popup is no longer a
    // DOM descendant of the wrapper after the portal change — without the
    // popupRef branch, tabbing from the trigger to the popup's methodology
    // link would dismiss the popup mid-keystroke.
    const next = e.relatedTarget as Node | null;
    if (e.currentTarget.contains(next)) return;
    if (popupRef.current && popupRef.current.contains(next)) return;
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? prev : 'closed'));
  }, []);

  const handleClick = useCallback(() => {
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? 'closed' : 'pinned'));
  }, []);

  // Esc + outside-click dismissal only fires when the popup is pinned.
  // Since the popup is portaled into `document.body`, the "inside" check
  // has to look at BOTH the trigger wrapper AND the popup ref — otherwise
  // clicks on the popup itself (e.g. to copy text from the definition)
  // would be treated as outside-clicks and dismiss the popup.
  useEffect(() => {
    if (state !== 'pinned') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState('closed');
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current && triggerRef.current.contains(target)) return;
      if (popupRef.current && popupRef.current.contains(target)) return;
      setState('closed');
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [state, triggerRef, popupRef]);

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

function CoreTooltip({
  term,
  iconSize = 'md',
  className,
  triggerChildren,
}: CoreProps) {
  const popupId = useId();
  const entry = lookupTerm(term);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const { state, handlers } = useTooltipState(wrapperRef, popupRef);
  const [placement, setPlacement] = useState<Placement>('bottom-start');
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Recompute placement + anchor rect whenever the popup is visible.
  // We re-listen on `scroll` (capture: true, so we hear ancestor scrolls
  // that don't bubble) and `resize` so the popup tracks the trigger as
  // the page changes underneath it. The `state === 'closed'` branch
  // releases the anchor so the popup parks off-screen until next open.
  useEffect(() => {
    if (state === 'closed') {
      setAnchorRect(null);
      return;
    }
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const updatePosition = () => {
      const w = wrapperRef.current;
      if (!w) return;
      const rect = w.getBoundingClientRect();
      const vw = window.innerWidth;
      // Flip to bottom-end when the trigger sits in the right 30 % of the
      // viewport — biases the popup to grow leftward before the
      // viewport-clamp kicks in.
      setPlacement(rect.left > vw * 0.7 ? 'bottom-end' : 'bottom-start');
      setAnchorRect(rect);
    };
    updatePosition();
    window.addEventListener('scroll', updatePosition, {
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, { capture: true });
      window.removeEventListener('resize', updatePosition);
    };
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
        className={['relative inline-flex items-center gap-1', className]
          .filter(Boolean)
          .join(' ')}
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
      className={['relative inline-flex items-center gap-1', className]
        .filter(Boolean)
        .join(' ')}
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
      <PopupRenderer
        term={term}
        state={state}
        popupId={popupId}
        placement={placement}
        anchorRect={anchorRect}
        popupRef={popupRef}
      />
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
