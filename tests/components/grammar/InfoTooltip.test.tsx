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

  test('blur to a focusable element inside the popup keeps it open', () => {
    // The popup ships a methodology link when entry.source is present.
    // capital-budget has no source, but we can construct the scenario by
    // checking that blurring with relatedTarget inside the wrapper does
    // not close. Use an entry that has a `source` for a real assertion.
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button');
    fireEvent.focus(btn);
    const popupId = btn.getAttribute('aria-describedby')!;
    const popup = document.getElementById(popupId)!;
    expect(popup).toHaveAttribute('data-state', 'open');
    // Find the methodology link inside the popup (entry.source = 'risk-measures').
    const link = popup.querySelector('a')!;
    expect(link).not.toBeNull();
    // Simulate focus moving from the button to the link: dispatch a blur
    // with relatedTarget=link. Testing Library's fireEvent.blur accepts an
    // event init.
    fireEvent.blur(btn, { relatedTarget: link });
    // State should remain open (relatedTarget is inside the wrapper).
    expect(popup).toHaveAttribute('data-state', 'open');
  });
});

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

  test('click inside the popup does not dismiss it', () => {
    // The wrapper-contains check on outside-mousedown should treat clicks
    // inside the popup as "inside" — so the popup stays pinned. Locks
    // down the invariant against a future portal/createPortal refactor.
    render(<InfoIcon term="tvar-99" />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    const popupId = btn.getAttribute('aria-describedby')!;
    const popup = document.getElementById(popupId)!;
    fireEvent.mouseDown(popup);
    expect(popup).toHaveAttribute('data-state', 'pinned');
  });
});

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
