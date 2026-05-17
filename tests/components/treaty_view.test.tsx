/**
 * Task P2.17 — /treaty view component tests.
 *
 * The TreatyLadder renders the reinsurance stack as a vertical SVG bar
 * chart, one band per layer, plus a horizontal reference line at the
 * carrier's book p99. Each XS band carries its attachment/exhaustion as
 * data attributes so the geometry is testable without parsing SVG paths.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TreatyLadder } from '@/components/TreatyLadder';
import type { TreatyStack } from '@/lib/treaty/types';

afterEach(cleanup);

function makeStack(overrides: Partial<TreatyStack> = {}): TreatyStack {
  return {
    schema_version: 1,
    generated_at: '2026-05-17T07:23:05.159916+00:00',
    data_source: 'synthetic_demo',
    book_p99: 80_000_000,
    layers: [
      {
        type: 'qs',
        share: 0.5,
        rol: 0.18,
        description: 'Quota Share — 50% of every policy ceded.',
      },
      {
        type: 'xs',
        attachment: 20_000_000,
        exhaustion: 60_000_000,
        rol: 0.1,
        reinstatements_remaining: 1,
        description: 'Working XS layer — $40M xs $20M.',
      },
      {
        type: 'xs',
        attachment: 60_000_000,
        exhaustion: 120_000_000,
        rol: 0.06,
        reinstatements_remaining: 2,
        description: 'Cat XS layer — $60M xs $60M.',
      },
    ],
    ...overrides,
  };
}

describe('TreatyLadder', () => {
  test('renders a band per layer when given a 3-layer stack (1 QS + 2 XS)', () => {
    render(<TreatyLadder stack={makeStack()} />);
    const bands = screen.getAllByTestId('treaty-band');
    expect(bands).toHaveLength(3);
    // QS band is tagged distinctly so the test can find it without depending
    // on render order.
    expect(screen.getByTestId('treaty-band-qs')).toBeInTheDocument();
    const xsBands = screen.getAllByTestId('treaty-band-xs');
    expect(xsBands).toHaveLength(2);
  });

  test('XS bands expose their attachment + exhaustion as data attributes', () => {
    render(<TreatyLadder stack={makeStack()} />);
    const xsBands = screen.getAllByTestId('treaty-band-xs');
    const ranges = xsBands.map((b) => ({
      attachment: Number(b.getAttribute('data-attachment')),
      exhaustion: Number(b.getAttribute('data-exhaustion')),
    }));
    // Order-independent: the stack contains a $20M–$60M layer and a $60M–$120M
    // layer; both must be present.
    expect(ranges).toEqual(
      expect.arrayContaining([
        { attachment: 20_000_000, exhaustion: 60_000_000 },
        { attachment: 60_000_000, exhaustion: 120_000_000 },
      ])
    );
    // Geometry sanity: SVG y is inverted, so the higher attachment band
    // must have a smaller `y` (sit nearer the top of the plot) than the
    // lower attachment band.
    const lower = xsBands.find((b) => Number(b.getAttribute('data-attachment')) === 20_000_000)!;
    const upper = xsBands.find((b) => Number(b.getAttribute('data-attachment')) === 60_000_000)!;
    expect(Number(upper.getAttribute('y'))).toBeLessThan(Number(lower.getAttribute('y')));
  });

  test('QS band shows the share percentage', () => {
    render(<TreatyLadder stack={makeStack()} />);
    const qsBand = screen.getByTestId('treaty-band-qs');
    expect(qsBand.getAttribute('data-share')).toBe('0.5');
    // Annotation visible to the user.
    expect(screen.getByText(/50% QS share/i)).toBeInTheDocument();
  });

  test('displays RoL for each layer', () => {
    render(<TreatyLadder stack={makeStack()} />);
    // QS RoL = 18%, XS_1 = 10%, XS_2 = 6% — all three percentages should
    // appear in the rendered text.
    const text = document.body.textContent || '';
    expect(text).toMatch(/18%/);
    expect(text).toMatch(/10%/);
    expect(text).toMatch(/6%/);
  });

  test('displays reinstatements-remaining for each XS layer', () => {
    render(<TreatyLadder stack={makeStack()} />);
    // Each XS layer renders its reinstatement count in both the SVG band
    // annotation and the parameters table beneath the ladder — use
    // `getAllByText` so duplicate appearances don't fail the assertion.
    expect(screen.getAllByText(/1 reinstatement left/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 reinstatements left/i).length).toBeGreaterThan(0);
  });

  test('draws a book_p99 reference line at the correct y-coordinate', () => {
    render(<TreatyLadder stack={makeStack()} />);
    const ref = screen.getByTestId('book-p99-line');
    // Horizontal line — y1 === y2.
    expect(ref.getAttribute('y1')).toBe(ref.getAttribute('y2'));
    expect(ref.getAttribute('data-book-p99')).toBe('80000000');
    // The reference line sits ABOVE (i.e. smaller y) the bottom of the
    // lower XS band ($20M attachment) and BELOW (i.e. larger y) the top
    // of the upper XS band ($120M exhaustion), because 20M < 80M < 120M.
    const refY = Number(ref.getAttribute('y1'));
    const xsBands = screen.getAllByTestId('treaty-band-xs');
    const lower = xsBands.find((b) => Number(b.getAttribute('data-attachment')) === 20_000_000)!;
    const upper = xsBands.find((b) => Number(b.getAttribute('data-attachment')) === 60_000_000)!;
    // Lower band bottom = y + height; upper band top = y.
    const lowerBottom = Number(lower.getAttribute('y')) + Number(lower.getAttribute('height'));
    const upperTop = Number(upper.getAttribute('y'));
    expect(refY).toBeLessThan(lowerBottom);
    expect(refY).toBeGreaterThan(upperTop);
  });

  test('data_source: "synthetic_demo" triggers a SYNTHETIC_SCAFFOLD badge', () => {
    render(<TreatyLadder stack={makeStack({ data_source: 'synthetic_demo' })} />);
    const badges = screen.getAllByTestId('trust-tier-badge');
    expect(badges.some((b) => b.textContent === 'Demo')).toBe(true);
  });

  test('data_source: "live" triggers a MODEL_OUTPUT badge', () => {
    render(<TreatyLadder stack={makeStack({ data_source: 'live' })} />);
    const badges = screen.getAllByTestId('trust-tier-badge');
    expect(badges.some((b) => b.textContent === 'Model')).toBe(true);
  });

  test('renders gracefully when the layer list is empty', () => {
    render(<TreatyLadder stack={makeStack({ layers: [] })} />);
    // No bands.
    expect(screen.queryAllByTestId('treaty-band')).toHaveLength(0);
    // Honest empty-state message instead of a crash.
    expect(screen.getByText(/no treaty layers/i)).toBeInTheDocument();
  });
});
