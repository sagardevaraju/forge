# Tooltip + Glossary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single tooltip + glossary system that lets a non-insurance reader hover any jargon term in the FORGE UI and see a plain-English explanation, with zero new dependencies.

**Architecture:** Three layers — `lib/grammar/glossary.ts` (strict-typed lookup), `components/grammar/InfoTooltip.tsx` (hover/focus/click-pin primitive with inline Lucide-style SVG), and 20+ surface wirings that pass `term="…"` props. TrustTierBadge migrates onto the same primitive in the same PR.

**Tech Stack:** TypeScript, Next.js 16 App Router, Tailwind 3.4, React 19, Vitest + Testing Library. Variant **D** from the 2026-05-25 brainstorm (outlined info-circle SVG, 14 px, zinc-500 → accent-green).

**Spec:** `docs/superpowers/specs/2026-05-25-tooltip-glossary-design.md`.

**Branch:** `feat/tooltip-glossary` (already created; spec committed at `fdb8381`).

---

## Task 1: Lock the glossary entry contract

**Files:**
- Modify: `lib/grammar/glossary.ts` (file exists as draft — verify contract + types compile)
- Create: `tests/lib/grammar/glossary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/grammar/glossary.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { GLOSSARY, lookupTerm } from '@/lib/grammar/glossary';

describe('glossary contract', () => {
  test('every entry has non-empty label + definition', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.label, `${key} label`).toBeTruthy();
      expect(entry.label.length, `${key} label length`).toBeGreaterThan(0);
      expect(entry.definition, `${key} definition`).toBeTruthy();
      expect(entry.definition.length, `${key} definition length`).toBeGreaterThan(10);
    }
  });

  test('lookupTerm returns undefined for unknown keys', () => {
    expect(lookupTerm('not-a-real-key')).toBeUndefined();
  });

  test('lookupTerm returns the entry for a known key', () => {
    const entry = lookupTerm('tvar-99');
    expect(entry).toBeDefined();
    expect(entry?.label).toMatch(/TVaR/i);
  });

  test('entry keys are kebab-case (no underscores, no spaces, no capitals)', () => {
    for (const key of Object.keys(GLOSSARY)) {
      expect(key, `key ${key}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test('seeded coverage includes the core risk-measure terms', () => {
    for (const k of ['tvar-99', 'p99', 'var', 'tail-exposure', 'capital-budget']) {
      expect(lookupTerm(k), `${k} should exist`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run the test — should pass against the draft glossary**

```bash
npx vitest run tests/lib/grammar/glossary.test.ts
```

Expected: PASS (all 5 tests). If any fail, fix the offending entries in `lib/grammar/glossary.ts` until green.

- [ ] **Step 3: Commit**

```bash
git add lib/grammar/glossary.ts tests/lib/grammar/glossary.test.ts
git commit -m "feat(FORGE): glossary lookup + contract tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Build the InfoTooltip primitive — hover + focus reveal

**Files:**
- Create: `components/grammar/InfoTooltip.tsx`
- Create: `tests/components/grammar/InfoTooltip.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/grammar/InfoTooltip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InfoIcon } from '@/components/grammar/InfoTooltip';

afterEach(() => cleanup());

describe('InfoIcon — hover + focus reveal', () => {
  test('renders a button trigger with aria-describedby', () => {
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button', { name: /definition of/i });
    expect(btn).toHaveAttribute('aria-describedby');
  });

  test('popup is hidden by default', () => {
    render(<InfoIcon term="tvar-99" />);
    // The popup exists in the DOM with the same id but is hidden.
    const btn = screen.getByRole('button');
    const popupId = btn.getAttribute('aria-describedby')!;
    const popup = document.getElementById(popupId)!;
    expect(popup).toHaveAttribute('data-state', 'closed');
  });

  test('hover opens the popup', () => {
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button');
    fireEvent.pointerEnter(btn);
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-state', 'open');
  });

  test('focus opens the popup', () => {
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button');
    fireEvent.focus(btn);
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-state', 'open');
  });

  test('unknown term renders the icon but with no popup content', () => {
    render(<InfoIcon term={'definitely-not-real' as never} />);
    const btn = screen.queryByRole('button');
    // The button still renders so layout doesn't jump, but it's marked
    // as a missing glossary entry for the sweep test.
    expect(btn).toHaveAttribute('data-testid', 'glossary-missing');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/components/grammar/InfoTooltip.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the primitive (hover + focus only, no pinning yet)**

Create `components/grammar/InfoTooltip.tsx`:

```tsx
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
  type ReactNode,
} from 'react';
import { lookupTerm } from '@/lib/grammar/glossary';

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

  const handleBlur = useCallback(() => {
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? prev : 'closed'));
  }, []);

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
  // glossary-coverage sweep test.
  if (!entry) {
    return (
      <span
        data-testid="glossary-missing"
        data-term={term}
        className={['inline-flex items-center gap-1', className].filter(Boolean).join(' ')}
      >
        {triggerChildren}
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
```

- [ ] **Step 4: Run the test — should pass**

```bash
npx vitest run tests/components/grammar/InfoTooltip.test.tsx
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add components/grammar/InfoTooltip.tsx tests/components/grammar/InfoTooltip.test.tsx
git commit -m "feat(FORGE): InfoTooltip primitive — hover + focus reveal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Click-pin + Esc + outside-click dismissal

**Files:**
- Modify: `components/grammar/InfoTooltip.tsx`
- Modify: `tests/components/grammar/InfoTooltip.test.tsx`

- [ ] **Step 1: Add failing tests for the pinning behavior**

Append to `tests/components/grammar/InfoTooltip.test.tsx`:

```tsx
describe('InfoIcon — click pinning', () => {
  test('click on trigger pins the popup open', () => {
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-state', 'pinned');
  });

  test('a second click un-pins (back to closed)', () => {
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn);
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-state', 'closed');
  });

  test('Escape on the trigger dismisses a pinned popup', () => {
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.keyDown(window, { key: 'Escape' });
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-state', 'closed');
  });

  test('outside click dismisses a pinned popup', () => {
    render(
      <div>
        <InfoIcon term="tvar-99" />
        <div data-testid="outside">outside</div>
      </div>,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.mouseDown(screen.getByTestId('outside'));
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-state', 'closed');
  });
});
```

- [ ] **Step 2: Run the test to verify the 4 new ones fail**

```bash
npx vitest run tests/components/grammar/InfoTooltip.test.tsx
```

Expected: FAIL for the 4 pinning tests (data-state ends up `closed` or `open`, not `pinned`).

- [ ] **Step 3: Add the click + Escape + outside-click handlers**

In `components/grammar/InfoTooltip.tsx`, extend `useTooltipState`:

Replace the existing `useTooltipState` function with:

```ts
function useTooltipState(triggerRef: React.RefObject<HTMLElement | null>) {
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
    leaveTimer.current = setTimeout(() => {
      setState((prev) => (prev === 'pinned' ? prev : 'closed'));
    }, 100);
  }, []);

  const handleFocus = useCallback(() => {
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? prev : 'open'));
  }, []);

  const handleBlur = useCallback(() => {
    clearLeaveTimer();
    setState((prev) => (prev === 'pinned' ? prev : 'closed'));
  }, []);

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
      // The trigger ref points at the wrapper span — clicks inside it
      // (the button or the popup) should not dismiss.
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
```

And update `CoreTooltip` to thread the ref:

```tsx
function CoreTooltip({ term, iconSize = 'md', className, triggerChildren }: CoreProps) {
  const popupId = useId();
  const entry = lookupTerm(term);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const { state, handlers } = useTooltipState(wrapperRef);

  if (!entry) {
    return (
      <span
        data-testid="glossary-missing"
        data-term={term}
        className={['inline-flex items-center gap-1', className].filter(Boolean).join(' ')}
      >
        {triggerChildren}
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
      <PopupRenderer term={term} state={state} popupId={popupId} />
    </span>
  );
}
```

- [ ] **Step 4: Run all InfoTooltip tests**

```bash
npx vitest run tests/components/grammar/InfoTooltip.test.tsx
```

Expected: PASS (all 9 tests now).

- [ ] **Step 5: Commit**

```bash
git add components/grammar/InfoTooltip.tsx tests/components/grammar/InfoTooltip.test.tsx
git commit -m "feat(FORGE): InfoTooltip — click pin + Esc + outside-click dismiss

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Auto-flip popup placement when near the right viewport edge

**Files:**
- Modify: `components/grammar/InfoTooltip.tsx`
- Modify: `tests/components/grammar/InfoTooltip.test.tsx`

- [ ] **Step 1: Add a failing test for the flip behavior**

Append to `tests/components/grammar/InfoTooltip.test.tsx`:

```tsx
describe('InfoIcon — popup placement', () => {
  test('flips to right-aligned when the trigger sits in the right 30% of the viewport', () => {
    // Force jsdom's window.innerWidth then place the trigger past the
    // 70% mark using getBoundingClientRect.
    Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true });
    const { container } = render(<InfoIcon term="tvar-99" />);
    const span = container.querySelector('span.relative')! as HTMLSpanElement;
    span.getBoundingClientRect = () =>
      ({ left: 850, right: 870, top: 0, bottom: 12, width: 20, height: 12 }) as DOMRect;
    fireEvent.pointerEnter(span);
    // The popup carries data-placement so the renderer can pick `left-0` vs `right-0`.
    const btn = screen.getByRole('button');
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-placement', 'bottom-end');
  });

  test('uses bottom-start when trigger sits in the left half', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true });
    const { container } = render(<InfoIcon term="tvar-99" />);
    const span = container.querySelector('span.relative')! as HTMLSpanElement;
    span.getBoundingClientRect = () =>
      ({ left: 100, right: 120, top: 0, bottom: 12, width: 20, height: 12 }) as DOMRect;
    fireEvent.pointerEnter(span);
    const btn = screen.getByRole('button');
    const popupId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(popupId)).toHaveAttribute('data-placement', 'bottom-start');
  });
});
```

- [ ] **Step 2: Run the test to verify failure**

```bash
npx vitest run tests/components/grammar/InfoTooltip.test.tsx -t placement
```

Expected: FAIL — `data-placement` is not present yet.

- [ ] **Step 3: Implement viewport-edge flip**

In `components/grammar/InfoTooltip.tsx`, add placement state to `CoreTooltip`. Replace `CoreTooltip` with:

```tsx
type Placement = 'bottom-start' | 'bottom-end';

function CoreTooltip({ term, iconSize = 'md', className, triggerChildren }: CoreProps) {
  const popupId = useId();
  const entry = lookupTerm(term);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const { state, handlers } = useTooltipState(wrapperRef);
  const [placement, setPlacement] = useState<Placement>('bottom-start');

  // Recompute placement when the popup opens, so we read the actual
  // trigger position at that moment (and not whatever it was at mount).
  useEffect(() => {
    if (state === 'closed') return;
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    // Flip to bottom-end (right-aligned popup) when the trigger sits in
    // the right 30% of the viewport — gives the 280 px popup room to grow
    // leftward without clipping.
    setPlacement(rect.left > vw * 0.7 ? 'bottom-end' : 'bottom-start');
  }, [state]);

  if (!entry) {
    return (
      <span
        data-testid="glossary-missing"
        data-term={term}
        className={['inline-flex items-center gap-1', className].filter(Boolean).join(' ')}
      >
        {triggerChildren}
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
```

Update `PopupRenderer` to read `placement` and switch the alignment class:

```tsx
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
```

- [ ] **Step 4: Run all InfoTooltip tests**

```bash
npx vitest run tests/components/grammar/InfoTooltip.test.tsx
```

Expected: PASS (all 11 tests).

- [ ] **Step 5: Commit**

```bash
git add components/grammar/InfoTooltip.tsx tests/components/grammar/InfoTooltip.test.tsx
git commit -m "feat(FORGE): InfoTooltip — auto-flip popup when near right viewport edge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: ExecCard accepts a `term` prop

**Files:**
- Modify: `components/grammar/ExecCard.tsx`
- Modify: `tests/components/grammar/ExecCard.test.tsx` (create if missing)

- [ ] **Step 1: Write the failing test**

Create or extend `tests/components/grammar/ExecCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ExecCard } from '@/components/grammar/ExecCard';

afterEach(() => cleanup());

describe('ExecCard — glossary term prop', () => {
  test('renders an info-icon button when term is provided', () => {
    render(<ExecCard label="Tail exposure" value="$96.7M" tier="MODEL_OUTPUT" term="tail-exposure" />);
    const btn = screen.getByRole('button', { name: /definition of tail exposure/i });
    expect(btn).toBeInTheDocument();
  });

  test('does NOT render an info-icon button when term is omitted', () => {
    render(<ExecCard label="Random" value="1" tier="MODEL_OUTPUT" />);
    expect(screen.queryByRole('button', { name: /definition of/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/components/grammar/ExecCard.test.tsx
```

Expected: FAIL on the first test — no button is rendered yet.

- [ ] **Step 3: Add the `term` prop to ExecCard**

In `components/grammar/ExecCard.tsx`:

After the `import` block, add:

```tsx
import { InfoIcon } from '@/components/grammar/InfoTooltip';
```

In the `ExecCardProps` interface, add (above `tier`):

```tsx
  /**
   * Optional glossary key. When set, an InfoIcon renders next to the label
   * so a layman can hover/click to read the definition.
   */
  term?: string;
```

In the function signature, destructure `term`:

```tsx
export function ExecCard({
  label,
  value,
  delta,
  band,
  caption,
  tier,
  term,
  variant = 'default',
  className,
}: ExecCardProps) {
```

In the label `<span>`, wrap the label and append the icon. Replace the existing label span block:

```tsx
      <div className="flex items-start justify-between gap-2 min-h-[20px]">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-zinc-500 leading-tight line-clamp-1 inline-flex items-center gap-1">
          {label}
          {term && <InfoIcon term={term} iconSize="sm" />}
        </span>
        <TrustTierBadge tier={tier} />
      </div>
```

- [ ] **Step 4: Run the test — should pass**

```bash
npx vitest run tests/components/grammar/ExecCard.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add components/grammar/ExecCard.tsx tests/components/grammar/ExecCard.test.tsx
git commit -m "feat(FORGE): ExecCard accepts optional term prop for glossary tooltip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Migrate TrustTierBadge to the InfoTooltip primitive

**Files:**
- Modify: `components/grammar/TrustTierBadge.tsx`
- Create: `tests/components/grammar/TrustTierBadge.test.tsx`
- Modify: `lib/grammar/trust-tiers.ts` (add per-tier glossary keys)

- [ ] **Step 1: Add per-tier glossary keys to the trust-tier metadata**

In `lib/grammar/trust-tiers.ts`, extend `TrustTierMeta`:

```ts
export interface TrustTierMeta {
  label: string;
  className: string;
  tooltip: string;
  /** Glossary key for the InfoTooltip popup (Task 6). */
  glossaryKey: string;
}
```

Then add `glossaryKey:` to each entry in `TRUST_TIER_META`:

```ts
  LIVE_FEED: { …, glossaryKey: 'live-feed' },
  MODEL_OUTPUT: { …, glossaryKey: 'model-output' },
  SYNTHETIC_SCAFFOLD: { …, glossaryKey: 'synthetic-scaffold' },
  RECOMMENDATION: { …, glossaryKey: 'recommendation' },
  MANUAL_OVERRIDE: { …, glossaryKey: 'manual-override' },
```

- [ ] **Step 2: Write the failing test**

Create `tests/components/grammar/TrustTierBadge.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';

afterEach(() => cleanup());

describe('TrustTierBadge — glossary integration', () => {
  test('renders the tier label', () => {
    render(<TrustTierBadge tier="LIVE_FEED" />);
    expect(screen.getByTestId('trust-tier-badge')).toHaveTextContent(/live/i);
  });

  test('exposes a glossary tooltip for the tier', () => {
    render(<TrustTierBadge tier="LIVE_FEED" />);
    const btn = screen.getByRole('button', { name: /definition of/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-describedby');
  });

  test('does NOT use native HTML title attribute anymore', () => {
    render(<TrustTierBadge tier="MODEL_OUTPUT" />);
    expect(screen.getByTestId('trust-tier-badge')).not.toHaveAttribute('title');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/components/grammar/TrustTierBadge.test.tsx
```

Expected: FAIL on the last two tests — the badge still uses `title=`, no button yet.

- [ ] **Step 4: Migrate TrustTierBadge**

Replace `components/grammar/TrustTierBadge.tsx` body:

```tsx
import { TRUST_TIER_META, type TrustTier } from '@/lib/grammar/trust-tiers';
import { InfoTooltip } from '@/components/grammar/InfoTooltip';

interface TrustTierBadgeProps {
  tier: TrustTier;
  className?: string;
}

export function TrustTierBadge({ tier, className }: TrustTierBadgeProps) {
  const meta = TRUST_TIER_META[tier];
  const classes = [
    'inline-flex items-center gap-1 px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.06em] rounded-sm',
    meta.className,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <InfoTooltip term={meta.glossaryKey}>
      <span data-testid="trust-tier-badge" className={classes}>
        <span aria-hidden="true" className="h-1 w-1 rounded-full bg-current opacity-70" />
        {meta.label}
      </span>
    </InfoTooltip>
  );
}
```

- [ ] **Step 5: Run all grammar tests**

```bash
npx vitest run tests/components/grammar/
```

Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add components/grammar/TrustTierBadge.tsx lib/grammar/trust-tiers.ts tests/components/grammar/TrustTierBadge.test.tsx
git commit -m "feat(FORGE): TrustTierBadge uses InfoTooltip primitive instead of native title

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire the Landing page (`app/page.tsx`)

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Pass `term=` to each ExecCard on the Landing page**

In `app/page.tsx`, find the four `<ExecCard>` calls and add `term=` to each:

```tsx
      <ExecCard label="Book TIV" term="book-tiv" value={`$${(totals.tiv / 1e9).toFixed(2)}B`} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard label="Policies" term="policies" value={totals.policies.toLocaleString()} tier="SYNTHETIC_SCAFFOLD" />
      <ExecCard
        label="Projected cession spend"
        term="projected-cession-spend"
        value={`$${(projectedCessionSpend / 1e6).toFixed(1)}M`}
        tier={optimization ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD'}
      />
      <ExecCard
        label="Open advisories"
        term="advisory"
        value={`${openAdvisories.count}`}
        tier={openAdvisories.source === 'live' ? 'LIVE_FEED' : 'SYNTHETIC_SCAFFOLD'}
      />
```

- [ ] **Step 2: Smoke-check the build**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds, no new lint warnings beyond pre-existing.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat(FORGE): landing ExecCards wire glossary terms

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire PortfolioHeader (every KPI label)

**Files:**
- Modify: `components/PortfolioHeader.tsx`

- [ ] **Step 1: Add `term=` to each ExecCard in `renderCard`**

Find each `<ExecCard>` block in `renderCard` (function starts ~line 147) and add a `term` prop matching the glossary key. Use this mapping:

| Card kind | term |
|---|---|
| `total_tiv` | `book-tiv` |
| `expected_margin` | `expected-margin` |
| `tvar_99` | `tvar-99` |
| `crps` | `crps` |
| `capital_used` | `tail-exposure` |
| `nonrenew_used` | `non-renew` |
| `cession_spend` | `cession` |
| `rol_by_layer` | `rate-on-line` |
| `retained_tail` | `retained-tail` |
| `vrp_demand` | `adjuster-load` |
| `saa_gap` | `objective` |

Example for `expected_margin`:

```tsx
    case 'expected_margin':
      return (
        <ExecCard
          key={kind}
          label="Expected margin"
          term="expected-margin"
          value={$Mor(p.objective)}
          delta={infeasible ? undefined : p.objectiveDelta}
          tier={infeasible ? 'SYNTHETIC_SCAFFOLD' : 'RECOMMENDATION'}
          variant={variant}
        />
      );
```

Repeat for each of the 11 cases.

- [ ] **Step 2: Verify the existing PortfolioHeader test still passes**

```bash
npx vitest run tests/components/PortfolioHeader.test.tsx 2>&1 | tail -20
```

If no such file exists, run the broader suite:

```bash
npx vitest run tests/components/
```

Expected: no test regressions.

- [ ] **Step 3: Commit**

```bash
git add components/PortfolioHeader.tsx
git commit -m "feat(FORGE): PortfolioHeader KPI labels wire glossary terms

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire the Portfolio drill-down surfaces

**Files:**
- Modify: `components/PortfolioDrillDown.tsx`
- Modify: `components/PortfolioMap.tsx`
- Modify: `components/PortfolioPareto.tsx`
- Modify: `components/PortfolioChoropleth.tsx`

- [ ] **Step 1: PortfolioDrillDown — table column headers + chip rows**

Open `components/PortfolioDrillDown.tsx`. Locate the table header row (search for `<thead>`). For each column header text, wrap the visible text with `<Term term="…">` or append an `<InfoIcon term="…" iconSize="sm" />` next to it. Mapping:

| Header text | term |
|---|---|
| `Cohort` | `cohort` |
| `TIV` | `tiv` |
| `Action` (or action name chips) | `retain`, `reprice`, `non-renew`, `cede-qs`, `cede-xs` (per-action chip wraps the action label) |
| `Quintile` | `tiv-quintile` |
| `Build` | `build-type` |
| `Flood zone` | `flood-zone` |
| `Loss p50` / `Expected loss` | `expected-loss` |
| `p99` | `p99` |
| `TVaR-99` | `tvar-99` |

Add at top of the file (alongside other imports):

```tsx
import { InfoIcon } from '@/components/grammar/InfoTooltip';
```

For each header `<th>` that should carry a tooltip, change e.g.:

```tsx
<th>Cohort</th>
```

to:

```tsx
<th className="whitespace-nowrap">
  <span className="inline-flex items-center gap-1">Cohort <InfoIcon term="cohort" iconSize="sm" /></span>
</th>
```

For action chips inside table rows (search `cede_qs`, `cede_xs`, `non_renew`, etc.) wrap the chip label with `<InfoIcon term="cede-qs" iconSize="sm" />` AFTER the existing chip span. Do NOT modify the chip rendering itself — just put an icon adjacent.

- [ ] **Step 2: PortfolioMap — legend labels**

Open `components/PortfolioMap.tsx`. Find the legend block (search `Legend` or per-action color swatches). For each action label, append the `InfoIcon`:

```tsx
<span className="inline-flex items-center gap-1">retain <InfoIcon term="retain" iconSize="sm" /></span>
```

- [ ] **Step 3: PortfolioPareto — axis labels + cell flag**

Open `components/PortfolioPareto.tsx`. Find the chart title (`Pareto sweep` text) and add an `InfoIcon term="pareto-sweep" iconSize="sm"` next to it. Find the capital-budget and cession-budget axis labels and add `term="capital-budget"` / `term="cession-budget"` icons. Find the `Infeasible (relaxed)` cell badge and add `term="infeasible-relaxed"`.

- [ ] **Step 4: PortfolioChoropleth — ZIP3 legend**

Open `components/PortfolioChoropleth.tsx`. Find any visible "ZIP3" label and wrap with `<Term term="zip3">ZIP3</Term>`.

- [ ] **Step 5: Build + test**

```bash
npm run build 2>&1 | tail -5 && npx vitest run tests/components/Portfolio*
```

Expected: build green, tests pass.

- [ ] **Step 6: Commit**

```bash
git add components/PortfolioDrillDown.tsx components/PortfolioMap.tsx components/PortfolioPareto.tsx components/PortfolioChoropleth.tsx
git commit -m "feat(FORGE): Portfolio drill-down/map/pareto/choropleth wire glossary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire WhatIfControl and SimulationBanner

**Files:**
- Modify: `components/grammar/WhatIfControl.tsx`
- Modify: `components/grammar/SimulationBanner.tsx`

- [ ] **Step 1: WhatIfControl title gets the budget term**

Open `components/grammar/WhatIfControl.tsx`. Locate where the slider title (label prop) is rendered. Replace the title element with one that appends an `<InfoIcon term={someTerm} iconSize="sm" />`. Since WhatIfControl is reused for capital / non-renew / cession budgets, accept an optional `term?: string` prop on the component and surface it next to the title:

```tsx
import { InfoIcon } from '@/components/grammar/InfoTooltip';
// …
interface Props {
  // existing props…
  term?: string;
}
// in the title render:
<span className="inline-flex items-center gap-1">{title}{term && <InfoIcon term={term} iconSize="sm" />}</span>
```

Callers can now pass `term="capital-budget"` etc.

- [ ] **Step 2: SimulationBanner — wrap jargon in the explanation prose**

In `components/grammar/SimulationBanner.tsx`, find the explanatory line:

```tsx
<div className="text-xs text-amber-400/80 mt-0.5">
  Adds K=1000 per sim to joint TVaR-99. Re-optimize to see updated
  portfolio actions.
</div>
```

Replace with:

```tsx
import { InfoIcon } from '@/components/grammar/InfoTooltip';
// …
<div className="text-xs text-amber-400/80 mt-0.5 inline-flex items-center gap-1 flex-wrap">
  Adds <span className="inline-flex items-center gap-1">K=1000<InfoIcon term="k-1000" iconSize="sm" /></span> per sim to joint <span className="inline-flex items-center gap-1">TVaR-99<InfoIcon term="tvar-99" iconSize="sm" /></span>. Re-optimize to see updated portfolio actions.
</div>
```

Also wrap the headline:

```tsx
const headline =
  unresolved.length === 1
    ? `1 unresolved simulation — ${unresolved[0].name}`
    : `${unresolved.length} unresolved simulations`;
```

Append an InfoIcon next to the headline in the JSX:

```tsx
<div className="text-sm text-amber-200 font-medium inline-flex items-center gap-1">
  {headline}
  <InfoIcon term="unresolved-simulation" iconSize="sm" />
</div>
```

- [ ] **Step 3: Test pass**

```bash
npx vitest run tests/components/grammar/SimulationBanner.test.tsx
```

Expected: still passes.

- [ ] **Step 4: Commit**

```bash
git add components/grammar/WhatIfControl.tsx components/grammar/SimulationBanner.tsx
git commit -m "feat(FORGE): WhatIfControl + SimulationBanner wire glossary terms

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Wire ClaimsTable column headers

**Files:**
- Modify: `components/ClaimsTable.tsx`

- [ ] **Step 1: Add InfoIcons to every column header**

Open `components/ClaimsTable.tsx`. Find the `<thead>` block (search `<th`) and wrap each header text. Mapping:

| Header text | term |
|---|---|
| `Policy` / `Policy ID` | (skip — not a jargon term) |
| `ZIP3` | `zip3` |
| `TIV` | `tiv` |
| `Build` / `Build type` | `build-type` |
| `Flood zone` | `flood-zone` |
| `Severity` | `severity` |
| `Notice days` / `Notice` | `notice-days` |
| `Expected loss` / `Loss p50` | `expected-loss` |
| `Δ` | (use term `expected-loss` with iconSize=sm) |

Import:

```tsx
import { InfoIcon } from '@/components/grammar/InfoTooltip';
```

Header pattern:

```tsx
<th><span className="inline-flex items-center gap-1">ZIP3 <InfoIcon term="zip3" iconSize="sm" /></span></th>
```

Also wrap the page-level "Claims pre-brief" or "Claims Pre-Brief" heading wherever it appears in the file or in `app/claims/page.tsx` with `<Term term="claims-pre-brief">Claims pre-brief</Term>`.

- [ ] **Step 2: Build + lint**

```bash
npm run build 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add components/ClaimsTable.tsx
git commit -m "feat(FORGE): ClaimsTable column headers wire glossary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Wire CalibrationView

**Files:**
- Modify: `components/CalibrationView.tsx`

- [ ] **Step 1: Add tooltips on chart titles**

Open `components/CalibrationView.tsx`. Find each chart title / section heading and append an `InfoIcon` based on the topic:

| Heading text contains | term |
|---|---|
| `PIT` | `pit` |
| `Reliability` | `reliability-diagram` |
| `CRPS` | `crps` |
| `Quantile` | `quantile-head` |

Import:

```tsx
import { InfoIcon } from '@/components/grammar/InfoTooltip';
```

Pattern:

```tsx
<h3 className="… inline-flex items-center gap-1">PIT histogram <InfoIcon term="pit" iconSize="sm" /></h3>
```

- [ ] **Step 2: Commit**

```bash
git add components/CalibrationView.tsx
git commit -m "feat(FORGE): CalibrationView chart titles wire glossary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Wire TreatyLadder

**Files:**
- Modify: `components/TreatyLadder.tsx`

- [ ] **Step 1: Add tooltips to layer column headers + per-layer labels**

Open `components/TreatyLadder.tsx`. Search for column headers and chip labels. Mapping:

| Visible text | term |
|---|---|
| `Treaty` (page title) | `treaty` |
| `Quota share` / `QS` | `quota-share` |
| `Excess of loss` / `XS` | `excess-of-loss` |
| `Attachment` / `Att` | `attachment` |
| `Exhaustion` / `Exh` | `exhaustion` |
| `RoL` / `Rate-on-line` | `rate-on-line` |
| `Reinstatement` / `Reinst` | `reinstatement` |
| `Fronting` | `fronting` |
| `Fronting fee` | `fronting-fee` |
| `Captive` | `captive` |
| `ILS` / `Cat bond` | `ils` |
| `UPR` | `upr` |
| `Book p99` reference line | `p99` |
| `Tail exposure` | `tail-exposure` |

Import:

```tsx
import { InfoIcon, Term } from '@/components/grammar/InfoTooltip';
```

For headers, pattern is the same as Task 11. For inline mentions in legend strings, use `<Term term="...">label</Term>`.

- [ ] **Step 2: Build + tests**

```bash
npm run build 2>&1 | tail -5 && npx vitest run tests/components/TreatyLadder*
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add components/TreatyLadder.tsx
git commit -m "feat(FORGE): TreatyLadder wires reinsurance glossary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Wire Events surfaces

**Files:**
- Modify: `components/EventConsole.tsx`
- Modify: `components/grammar/ThreatBanner.tsx`
- Modify: `components/ConeExposureBars.tsx`

- [ ] **Step 1: EventConsole — legend labels + section headings**

Open `components/EventConsole.tsx`. Map every visible label or legend chip:

| Visible | term |
|---|---|
| `NHC cone` / `Cone` | `nhc-cone` |
| `GEFS` | `gefs` |
| `FIRMS` | `firms` |
| `NWS` / `NWS alerts` | `nws` |
| `Sitrep` / `Situation report` | `sitrep` |
| `Advisory` | `advisory` |
| `Cone exposure` | `cone-exposure` |
| `Stochastic exposure` | `stochastic-exposure` |

Import + apply with `<Term>` or `<InfoIcon>` adjacent.

- [ ] **Step 2: ThreatBanner — sub-labels**

In `components/grammar/ThreatBanner.tsx`, find every sub-label (Peak wind, Advisory, Storm surge, etc.). Add `<InfoIcon term="peak-wind" iconSize="sm" />` etc. next to each.

- [ ] **Step 3: ConeExposureBars — bar legends**

In `components/ConeExposureBars.tsx`, add `<InfoIcon term="cone-exposure" iconSize="sm" />` next to the cone-exposure bar legend and `term="stochastic-exposure"` next to the stochastic bar legend.

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add components/EventConsole.tsx components/grammar/ThreatBanner.tsx components/ConeExposureBars.tsx
git commit -m "feat(FORGE): Events surfaces wire NHC/NWS/FIRMS glossary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Wire Simulate surfaces

**Files:**
- Modify: `components/sim/SimWorkspace.tsx`
- Modify: `components/sim/PerilPicker.tsx`
- Modify: `components/sim/SeverityStrip.tsx`

- [ ] **Step 1: PerilPicker — wrap each peril option label**

In `components/sim/PerilPicker.tsx`, find the array of peril options and wrap each visible peril name with `<Term term="peril">{name}</Term>` — same `term="peril"` for all of them so the popup explains "peril" as a concept. Then append a single `<InfoIcon term="severity" iconSize="sm" />` next to the severity selector.

- [ ] **Step 2: SeverityStrip — intensity / MMI / EF labels**

In `components/sim/SeverityStrip.tsx`, add tooltips next to each intensity-scale label. Mapping:

| Visible | term |
|---|---|
| `EF` (tornado scale) | `ef-scale` |
| `Mw` / `MMI` (earthquake) | `mmi` |
| `dNBR` (wildfire) | `dnbr` |
| `WSSI` (winter storm) | `wssi` |

- [ ] **Step 3: SimWorkspace — page title + footprint label**

In `components/sim/SimWorkspace.tsx`, append `<InfoIcon term="footprint" iconSize="sm" />` next to the footprint label.

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add components/sim/
git commit -m "feat(FORGE): Simulate workspace + peril picker + severity wire glossary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Wire AuditLedger

**Files:**
- Modify: `components/AuditLedger.tsx`
- Modify: `app/audit/page.tsx`

- [ ] **Step 1: Add tooltips on column headers + page heading**

In `components/AuditLedger.tsx`, locate the table `<thead>`. Wrap any header that uses jargon (`Type`, `Operator`, `Timestamp` are plain — skip). Pages title for the audit page: wrap the heading `Decisions table` / `Chat audit table` text with `<Term term="audit-ledger">…</Term>`. Add `<InfoIcon term="append-only" iconSize="sm" />` next to any "append-only" or "WORM" callout in `app/audit/page.tsx`.

- [ ] **Step 2: Commit**

```bash
git add components/AuditLedger.tsx app/audit/page.tsx
git commit -m "feat(FORGE): AuditLedger heading + WORM callout wire glossary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Methodology page — add anchor ids for tooltip deep-links

**Files:**
- Modify: `app/methodology/page.tsx`

- [ ] **Step 1: Add `id` attributes to the section headings referenced by glossary `source` slugs**

Open `app/methodology/page.tsx`. The glossary entries reference these `source` slugs: `mip`, `treaty`, `risk-measures`. Find the section headings that explain each concept and add a matching `id`:

- The MIP / Portfolio MIP section → `<h2 id="mip">`
- The Treaty / reinsurance section → `<h2 id="treaty">`
- The risk-measures / TVaR / VaR section → `<h2 id="risk-measures">`

Each becomes a deep-link target.

- [ ] **Step 2: Smoke-check that the anchor lands on the right section**

```bash
npm run dev &
sleep 4
curl -s http://localhost:3000/methodology | grep -E 'id="(mip|treaty|risk-measures)"' | head
kill %1 2>/dev/null
```

Expected: three `id=` matches.

- [ ] **Step 3: Commit**

```bash
git add app/methodology/page.tsx
git commit -m "feat(FORGE): methodology section anchors for tooltip deep-links

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Glossary-coverage sweep test (no missing keys ship)

**Files:**
- Create: `tests/lib/grammar/glossary-coverage.test.ts`

- [ ] **Step 1: Write the failing sweep test**

Create `tests/lib/grammar/glossary-coverage.test.ts`:

```ts
// Sweeps every `term="..."` literal in app/** and components/** and asserts
// the key exists in the glossary. The point: catch typos at test time, not
// when a user hovers a chip and gets no popup.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GLOSSARY } from '@/lib/grammar/glossary';

const ROOT = join(__dirname, '..', '..', '..');
const DIRS = ['app', 'components'];
const EXTS = ['.tsx', '.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

const TERM_RE = /\bterm=(?:"([a-z0-9-]+)"|\{['"]([a-z0-9-]+)['"]\})/g;

describe('glossary coverage', () => {
  test('every term="..." in app/** and components/** maps to a glossary entry', () => {
    const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
    const missing: { file: string; key: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      TERM_RE.lastIndex = 0;
      while ((m = TERM_RE.exec(src)) !== null) {
        const key = m[1] ?? m[2];
        if (!(key in GLOSSARY)) missing.push({ file: f.replace(ROOT + '/', ''), key });
      }
    }
    if (missing.length > 0) {
      const report = missing.map((m) => `  ${m.file}: term="${m.key}"`).join('\n');
      throw new Error(`Missing glossary entries:\n${report}`);
    }
  });
});
```

- [ ] **Step 2: Run the sweep**

```bash
npx vitest run tests/lib/grammar/glossary-coverage.test.ts
```

Expected: PASS. If any key surfaces as missing, add an entry to `lib/grammar/glossary.ts` (the report lists exact file + key) and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/grammar/glossary-coverage.test.ts lib/grammar/glossary.ts
git commit -m "test(FORGE): sweep test ensures every term= JSX prop has a glossary entry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Full test run + manual Playwright walkthrough

**Files:**
- (no edits — verification pass)

- [ ] **Step 1: Run the full Vitest suite**

```bash
FORGE_SKIP_REOPTIMIZE_INTEGRATION=1 npm test
```

Expected: pre-existing pass count + the new tests; no regressions.

- [ ] **Step 2: Run the Python test suite (smoke — these don't touch UI but the build sweep should still be clean)**

```bash
pytest -x -q 2>&1 | tail -10
```

Expected: same baseline as `main`.

- [ ] **Step 3: Walk the 4 high-jargon pages in Playwright**

Bring up the dev server, then through the Playwright MCP browser:

1. Navigate to `http://localhost:3000/` — verify each ExecCard label has an info icon, hover reveals the popup, click pins it.
2. Navigate to `http://localhost:3000/portfolio` — verify Header KPIs all have icons; click "Re-optimize" if there are unresolved sims, then verify post-solve labels still carry icons.
3. Navigate to `http://localhost:3000/treaty` — verify QS / XS / RoL / attachment / exhaustion labels all have icons.
4. Navigate to `http://localhost:3000/claims` — verify column headers all have icons; toggle severity filter.

For each page take one screenshot and visually confirm:
- No popups clip off the right edge.
- The icon doesn't visually fight with the trust-tier badge.
- Tab navigation reaches each icon and opens the popup on focus.

- [ ] **Step 4: Final commit + PR**

```bash
git push -u origin feat/tooltip-glossary
gh pr create --title "feat(FORGE): tooltip + glossary system across all UI surfaces" \
  --body "$(cat <<'EOF'
Ships variant D from the 2026-05-25 brainstorm: outlined info-circle SVG
adjacent to every jargon term in the FORGE UI. Hover/focus reveals a
280 px popup with definition + optional example + methodology deep-link;
click pins, Esc / outside-click dismiss.

Layers:
  - lib/grammar/glossary.ts — strict-typed lookup, ~150 seeded terms
  - components/grammar/InfoTooltip.tsx — InfoIcon / Term / InfoTooltip
  - 20 surface wirings + TrustTierBadge migration to the new primitive

Sweep test fails if any `term=` JSX prop maps to a missing glossary key.
No new dependencies (inline Lucide-style SVG, no popover lib).

Spec: docs/superpowers/specs/2026-05-25-tooltip-glossary-design.md
Plan: docs/superpowers/plans/2026-05-25-tooltip-glossary.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --squash --delete-branch
git checkout main && git pull --rebase origin main
```

Expected: merged squash-commit on `main`.

---

## Self-review notes

**Spec coverage:** ✅ Each spec section maps to a task — glossary lookup (T1), InfoTooltip primitive (T2–T4), ExecCard prop (T5), TrustTierBadge migration (T6), per-page wirings (T7–T16), methodology anchors (T17), coverage sweep (T18), verification (T19).

**Placeholders:** None — every step has exact paths and code blocks.

**Type consistency:** `lookupTerm`, `GLOSSARY`, `InfoIcon`, `Term`, `InfoTooltip`, `useTooltipState` all match across tasks. `placement: 'bottom-start' | 'bottom-end'` introduced in T4 stays consistent.

**Scope:** Each task touches a focused surface; T7–T16 are independent and can interleave with reviewer feedback. T1, T2, T3, T4, T5, T6 must land in order (foundation).
