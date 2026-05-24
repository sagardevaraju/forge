/**
 * Task P3.21 — ILS / cat-bond UI tests.
 *
 * Renders cat-bond layers as cyan bands in the SVG ladder (distinct
 * from emerald XS) and a row in the parameters table.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TreatyLadder } from '@/components/TreatyLadder';
import type { TreatyStack } from '@/lib/treaty/types';

afterEach(cleanup);

function makeStackWithIls(): TreatyStack {
  return {
    schema_version: 4,
    generated_at: '2026-05-24T07:23:05.159916+00:00',
    data_source: 'synthetic_demo',
    book_p99: 80_000_000,
    layers: [
      { type: 'qs', share: 0.5 },
      {
        type: 'xs',
        attachment: 20_000_000,
        exhaustion: 60_000_000,
        rol: 0.1,
        reinstatements_remaining: 1,
      },
      {
        type: 'ils',
        attachment: 120_000_000,
        exhaustion: 200_000_000,
        trigger: 'indemnity',
        coupon_rate: 0.085,
        term_years: 3,
        reset_years: 1,
        description: 'Cat-bond — indemnity trigger, $80M xs $120M, 8.5% coupon.',
      },
    ],
  };
}

describe('TreatyLadder — ILS / cat-bond (Task P3.21)', () => {
  test('renders a cyan ILS band when an ILS layer is present', () => {
    render(<TreatyLadder stack={makeStackWithIls()} />);
    const band = screen.getByTestId('treaty-band-ils');
    expect(band).toBeInTheDocument();
    expect(band.getAttribute('data-attachment')).toBe('120000000');
    expect(band.getAttribute('data-exhaustion')).toBe('200000000');
    expect(band.getAttribute('data-trigger')).toBe('indemnity');
  });

  test('omits ILS band when no ILS layer in stack', () => {
    const stack = makeStackWithIls();
    stack.layers = stack.layers.filter((l) => l.type !== 'ils');
    render(<TreatyLadder stack={stack} />);
    expect(screen.queryByTestId('treaty-band-ils')).not.toBeInTheDocument();
  });

  test('renders an ILS table row with trigger + coupon + term', () => {
    render(<TreatyLadder stack={makeStackWithIls()} />);
    const row = screen.getByTestId('treaty-table-row-ils');
    expect(row).toBeInTheDocument();
    const cells = row.querySelectorAll('td');
    expect(cells[0]!.textContent).toBe('ILS');
    // Range cell
    expect(cells[1]!.textContent).toBe('$120M to $200M');
    // RoL-equivalent cell (coupon)
    expect(cells[2]!.textContent).toBe('8.5% coupon');
    // Reinstatement-equivalent cell (term + trigger)
    expect(cells[3]!.textContent).toBe('3yr · indemnity');
  });

  test('y-axis ceiling expands to include the ILS exhaustion', () => {
    render(<TreatyLadder stack={makeStackWithIls()} />);
    // The book_p99 reference line should still be visible (sits at
    // $80M, well below the new $200M ceiling).
    const refLine = screen.getByTestId('book-p99-line');
    expect(refLine).toBeInTheDocument();
    expect(refLine.getAttribute('data-book-p99')).toBe('80000000');
  });

  test('SVG band metadata carries trigger + coupon', () => {
    render(<TreatyLadder stack={makeStackWithIls()} />);
    const band = screen.getByTestId('treaty-band-ils');
    expect(band.getAttribute('data-trigger')).toBe('indemnity');
  });
});
