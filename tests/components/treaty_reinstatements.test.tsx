/**
 * Task P3.22 — per-occurrence remaining-capacity surfacing.
 *
 * XS layers now carry initial_capacity_usd / remaining_capacity_usd /
 * reinstatement_premium_factor. The TreatyLadder surfaces remaining
 * capacity inside the reinstatements column so the operator can see
 * how much layer width is consumed without a new column.
 *
 * Per plan: surface as MIP **input** not constraint — the precompute
 * MIP does not enforce remaining_capacity as an upper bound on cession.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TreatyLadder } from '@/components/TreatyLadder';
import type { TreatyStack } from '@/lib/treaty/types';

afterEach(cleanup);

function stackWithCapacity(
  remaining_capacity_usd: number,
  initial_capacity_usd = 80_000_000,
): TreatyStack {
  return {
    schema_version: 5,
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
        initial_capacity_usd,
        remaining_capacity_usd,
        reinstatement_premium_factor: 1.0,
      },
    ],
  };
}

function stackWithoutCapacity(): TreatyStack {
  return {
    schema_version: 2, // pre-P3.22 schema
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
        // No P3.22 fields — pre-P3.22 artifact
      },
    ],
  };
}

describe('TreatyLadder — per-occurrence remaining capacity (Task P3.22)', () => {
  test('renders initial + remaining capacity when fields are present', () => {
    render(<TreatyLadder stack={stackWithCapacity(80_000_000)} />);
    const cap = screen.getByTestId('xs-remaining-capacity');
    expect(cap).toBeInTheDocument();
    expect(cap.getAttribute('data-initial-capacity')).toBe('80000000');
    expect(cap.getAttribute('data-remaining-capacity')).toBe('80000000');
    expect(cap.textContent).toBe('1 · $80M of $80M left');
  });

  test('partially-consumed layer surfaces the right remaining number', () => {
    // Layer width is 40M, initial cap 80M (1 reinstatement), 50M remaining.
    render(<TreatyLadder stack={stackWithCapacity(50_000_000)} />);
    const cap = screen.getByTestId('xs-remaining-capacity');
    expect(cap.getAttribute('data-remaining-capacity')).toBe('50000000');
    expect(cap.textContent).toBe('1 · $50M of $80M left');
  });

  test('exhausted layer (0 remaining) still renders without crashing', () => {
    render(<TreatyLadder stack={stackWithCapacity(0)} />);
    const cap = screen.getByTestId('xs-remaining-capacity');
    expect(cap.getAttribute('data-remaining-capacity')).toBe('0');
    expect(cap.textContent).toBe('1 · $0M of $80M left');
  });

  test('legacy pre-P3.22 artifact (no capacity fields) renders plain integer', () => {
    render(<TreatyLadder stack={stackWithoutCapacity()} />);
    // Older artifacts have no capacity fields — the cell falls back
    // to the plain reinstatement count.
    expect(screen.queryByTestId('xs-remaining-capacity')).not.toBeInTheDocument();
    // The table still renders without crashing.
    expect(screen.getByTestId('treaty-layer-table')).toBeInTheDocument();
  });
});
