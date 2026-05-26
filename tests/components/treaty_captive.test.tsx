/**
 * Task P3.20 — Captive vehicle UI tests.
 *
 * Renders a captive panel beneath the SVG ladder showing trapped vs
 * free capital composition (reserves / collateral / UPR / free) and a
 * single-row entry in the parameters table.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TreatyLadder } from '@/components/TreatyLadder';
import type { TreatyStack } from '@/lib/treaty/types';

afterEach(cleanup);

function makeStackWithCaptive(overrides: Partial<TreatyStack> = {}): TreatyStack {
  return {
    schema_version: 3,
    generated_at: '2026-05-24T07:23:05.159916+00:00',
    data_source: 'synthetic_demo',
    book_p99: 80_000_000,
    layers: [
      {
        type: 'fronting',
        residual_retention_share: 0.05,
        fronting_fee_share: 0.06,
        capital_provider: 'captive',
      },
      {
        type: 'captive',
        total_capital_usd: 100_000_000,
        outstanding_reserves_usd: 60_000_000,
        collateral_pledged_usd: 25_000_000,
        unearned_premium_reserve_usd: 10_000_000,
        description: 'Captive — 95% trapped, 5% free.',
      },
      {
        type: 'qs',
        share: 0.5,
      },
      {
        type: 'xs',
        attachment: 20_000_000,
        exhaustion: 60_000_000,
        rol: 0.1,
        reinstatements_remaining: 1,
      },
    ],
    ...overrides,
  };
}

function makeStackWithoutCaptive(): TreatyStack {
  return {
    schema_version: 2,
    generated_at: '2026-05-24T07:23:05.159916+00:00',
    data_source: 'synthetic_demo',
    book_p99: 80_000_000,
    layers: [
      {
        type: 'qs',
        share: 0.5,
      },
    ],
  };
}

describe('TreatyLadder — captive vehicle (Task P3.20)', () => {
  test('renders captive panel when a captive layer is present', () => {
    render(<TreatyLadder stack={makeStackWithCaptive()} />);
    expect(screen.getByTestId('captive-panel')).toBeInTheDocument();
  });

  test('omits captive panel when no captive layer in stack', () => {
    render(<TreatyLadder stack={makeStackWithoutCaptive()} />);
    expect(screen.queryByTestId('captive-panel')).not.toBeInTheDocument();
  });

  test('panel surfaces the correct trapped share', () => {
    render(<TreatyLadder stack={makeStackWithCaptive()} />);
    const panel = screen.getByTestId('captive-panel');
    // 60 + 25 + 10 = 95M trapped of 100M total ⇒ 95%
    expect(panel.getAttribute('data-trapped-share')).toBe('0.9500');
    expect(screen.getByTestId('captive-trapped-share').textContent).toMatch(
      /95% trapped/,
    );
  });

  test('panel surfaces a fully-reserved badge when trapped >= 95%', () => {
    render(<TreatyLadder stack={makeStackWithCaptive()} />);
    expect(screen.getByTestId('captive-trapped-share').textContent).toMatch(
      /fully reserved/,
    );
  });

  test('panel surfaces a redeployable badge when trapped < 50%', () => {
    const stack = makeStackWithCaptive({
      layers: [
        {
          type: 'captive',
          total_capital_usd: 100_000_000,
          outstanding_reserves_usd: 10_000_000,
          collateral_pledged_usd: 10_000_000,
          unearned_premium_reserve_usd: 5_000_000,
        },
      ],
    });
    render(<TreatyLadder stack={stack} />);
    // 25M / 100M = 25% trapped
    expect(screen.getByTestId('captive-trapped-share').textContent).toMatch(
      /25% trapped/,
    );
    expect(screen.getByTestId('captive-trapped-share').textContent).toMatch(
      /redeployable/,
    );
  });

  test('panel bar has four segments (reserves / collateral / UPR / free)', () => {
    render(<TreatyLadder stack={makeStackWithCaptive()} />);
    expect(screen.getByTestId('captive-bar-reserves')).toBeInTheDocument();
    expect(screen.getByTestId('captive-bar-collateral')).toBeInTheDocument();
    expect(screen.getByTestId('captive-bar-upr')).toBeInTheDocument();
    expect(screen.getByTestId('captive-bar-free')).toBeInTheDocument();
  });

  test('renders a captive table row alongside fronting / QS / XS', () => {
    render(<TreatyLadder stack={makeStackWithCaptive()} />);
    const row = screen.getByTestId('treaty-table-row-captive');
    expect(row).toBeInTheDocument();
    const cells = row.querySelectorAll('td');
    // Task 13 — `toMatch(/^Captive/)` because the InfoTooltip popup
    // renders the term label inside the cell's DOM (hidden state),
    // appending "CaptiveA reinsurance company…" to textContent.
    expect(cells[0]!.textContent).toMatch(/^Captive/);
    expect(cells[1]!.textContent).toMatch(/95% trapped/);
  });

  test('over-reserved captive still renders without crashing', () => {
    const stack = makeStackWithCaptive({
      layers: [
        {
          type: 'captive',
          total_capital_usd: 100_000_000,
          outstanding_reserves_usd: 90_000_000,
          collateral_pledged_usd: 30_000_000,
          unearned_premium_reserve_usd: 10_000_000,
        },
      ],
    });
    render(<TreatyLadder stack={stack} />);
    // Trapped 130M > total 100M ⇒ share capped at 1.0
    expect(screen.getByTestId('captive-panel').getAttribute('data-trapped-share')).toBe(
      '1.0000',
    );
    // Free = 0
    expect(screen.getByTestId('captive-free-label').textContent).toMatch(/Free \$0/);
  });
});
