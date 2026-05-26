/**
 * Task P3.19 — Fronting vehicle render + toggle tests.
 *
 * Adds a violet fronting band beneath the QS slice, a fronting row in
 * the layer-parameters table, and a client-side toggle to hide/show
 * fronting layers (operator wants to see gross-of-fronting capital
 * position).
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { TreatyLadder } from '@/components/TreatyLadder';
import type { TreatyStack } from '@/lib/treaty/types';

afterEach(cleanup);

function makeStackWithFronting(): TreatyStack {
  return {
    schema_version: 2,
    generated_at: '2026-05-24T07:23:05.159916+00:00',
    data_source: 'synthetic_demo',
    book_p99: 80_000_000,
    layers: [
      {
        type: 'fronting',
        residual_retention_share: 0.05,
        fronting_fee_share: 0.06,
        capital_provider: 'captive',
        description:
          'Fronting — 95% ceded to captive, 5% retained by fronter; 6% fronting fee on premium.',
      },
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
    ],
  };
}

function makeStackWithoutFronting(): TreatyStack {
  return {
    schema_version: 2,
    generated_at: '2026-05-24T07:23:05.159916+00:00',
    data_source: 'synthetic_demo',
    book_p99: 80_000_000,
    layers: [
      {
        type: 'qs',
        share: 0.5,
        rol: 0.18,
      },
      {
        type: 'xs',
        attachment: 20_000_000,
        exhaustion: 60_000_000,
        rol: 0.1,
        reinstatements_remaining: 1,
      },
    ],
  };
}

describe('TreatyLadder — fronting vehicle (Task P3.19)', () => {
  test('renders a violet fronting band when a fronting layer is present', () => {
    render(<TreatyLadder stack={makeStackWithFronting()} />);
    const band = screen.getByTestId('treaty-band-fronting');
    expect(band).toBeInTheDocument();
    expect(band.getAttribute('data-capital-provider')).toBe('captive');
    expect(band.getAttribute('data-residual-retention')).toBe('0.05');
    expect(band.getAttribute('data-fronting-fee')).toBe('0.06');
  });

  test('renders a fronting row in the layer-parameters table', () => {
    render(<TreatyLadder stack={makeStackWithFronting()} />);
    const row = screen.getByTestId('treaty-table-row-fronting');
    expect(row).toBeInTheDocument();
    // First cell == layer-kind label "Fronting".
    const cells = row.querySelectorAll('td');
    // Task 13 — `toMatch(/^Fronting/)` because the InfoTooltip popup on the
    // first occurrence of the row label appends the term-popup text
    // ("FrontingA licensed insurer…") to the cell's textContent.
    expect(cells[0]!.textContent).toMatch(/^Fronting/);
    // Second cell == cession share text (95% ceded to captive).
    expect(cells[1]!.textContent).toBe('95% ceded to captive');
    // Third cell == fronting fee rate (6% fee). Same Task-13 popup-bleed
    // — the fronting-fee InfoIcon lives next to the "6% fee" text.
    expect(cells[2]!.textContent).toMatch(/^6% fee/);
    // Fourth cell == reinstatements placeholder (— for fronting).
    expect(cells[3]!.textContent).toBe('—');
  });

  test('shows fronting toggle when a fronting layer is present', () => {
    render(<TreatyLadder stack={makeStackWithFronting()} />);
    expect(screen.getByTestId('fronting-toggle')).toBeInTheDocument();
    const checkbox = screen.getByTestId('fronting-toggle-input') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  test('hides toggle when no fronting layer in stack', () => {
    render(<TreatyLadder stack={makeStackWithoutFronting()} />);
    expect(screen.queryByTestId('fronting-toggle')).not.toBeInTheDocument();
  });

  test('toggle off hides fronting band + table row', () => {
    render(<TreatyLadder stack={makeStackWithFronting()} />);
    const checkbox = screen.getByTestId('fronting-toggle-input') as HTMLInputElement;
    expect(screen.getByTestId('treaty-band-fronting')).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    // After toggling off, the fronting band + table row are gone.
    expect(screen.queryByTestId('treaty-band-fronting')).not.toBeInTheDocument();
    expect(screen.queryByTestId('treaty-table-row-fronting')).not.toBeInTheDocument();
    // QS + XS bands remain.
    expect(screen.getByTestId('treaty-band-qs')).toBeInTheDocument();
  });

  test('toggle on after off restores the fronting band', () => {
    render(<TreatyLadder stack={makeStackWithFronting()} />);
    const checkbox = screen.getByTestId('fronting-toggle-input') as HTMLInputElement;
    fireEvent.click(checkbox);  // off
    fireEvent.click(checkbox);  // back on
    expect(checkbox.checked).toBe(true);
    expect(screen.getByTestId('treaty-band-fronting')).toBeInTheDocument();
    expect(screen.getByTestId('treaty-table-row-fronting')).toBeInTheDocument();
  });

  test('SVG band carries the calibrated industry-typical metadata', () => {
    render(<TreatyLadder stack={makeStackWithFronting()} />);
    const band = screen.getByTestId('treaty-band-fronting');
    // Industry-typical: 95% ceded / 5% retained, 6% fronting fee on premium.
    expect(band.getAttribute('data-residual-retention')).toBe('0.05');
    expect(band.getAttribute('data-fronting-fee')).toBe('0.06');
    expect(band.getAttribute('data-capital-provider')).toBe('captive');
  });
});
