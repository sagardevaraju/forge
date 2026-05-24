/**
 * Task P3.8 — AuditLedger component tests.
 *
 * The /audit view renders a unified timeline of two write streams:
 *   - decision rows (one per /api/optimize/portfolio solve, P3.4)
 *   - chat audit rows (one per agent chat turn, P2.36)
 *
 * Tests pin the spec acceptance criteria:
 *   1. Renders both streams in a single time-ordered table.
 *   2. Diff view: expanding a decision row shows budget + objective +
 *      action-mix deltas vs the previous decision.
 *   3. Filters reduce row count visibly (type filter, operator filter).
 *   4. Pagination: only N rows shown initially with a "Load more" control
 *      when the corpus exceeds page size.
 *
 * We do NOT exercise URL-param plumbing here — that's a separate concern
 * the page-level component owns. The ledger component takes filters as
 * internal state.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { AuditLedger } from '@/components/AuditLedger';
import type { DecisionRow } from '@/lib/audit/decisions';
import type { AuditRow as ChatAuditRow } from '@/lib/audit/log';

afterEach(cleanup);

function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  const base: DecisionRow = {
    id: 'a'.repeat(64),
    solve_ts: '2026-05-23T10:00:00Z',
    operator: 'alice',
    inputs_hash: 'i'.repeat(64),
    inputs_json: JSON.stringify({
      budgets: { capital_budget: 1e7, max_nonrenew_pct: 0.1, cession_budget: 5e6 },
      horizon_start: '2026-01-01',
      horizon_end: '2026-12-31',
      cohorts_hash: 'c'.repeat(64),
    }),
    outputs_hash: 'o'.repeat(64),
    outputs_json: JSON.stringify({
      status: 'Optimal',
      objective: 12_000_000,
      action_summary: {
        retain: { count: 100, tiv: 1e9 },
        non_renew: { count: 5, tiv: 5e7 },
        cede_xs: { count: 10, tiv: 2e8 },
      },
    }),
    executed_at: null,
    reversed_at: null,
    reversed_by: null,
    notices_sent_at: null,
  };
  return { ...base, ...over };
}

function chat(over: Partial<ChatAuditRow> = {}): ChatAuditRow {
  const base: ChatAuditRow = {
    id: 'b'.repeat(64),
    ts: '2026-05-23T11:00:00Z',
    user_id: 'alice',
    prompt_hash: 'p'.repeat(64),
    tool_calls_json: '[{"name":"query_book_exposure","args":{"zip3_list":["330"]}}]',
    final_hash: 'f'.repeat(64),
  };
  return { ...base, ...over };
}

describe('<AuditLedger />', () => {
  test('renders an empty state when no rows', () => {
    render(<AuditLedger decisions={[]} chatRows={[]} />);
    expect(screen.getByTestId('audit-ledger-empty')).toBeTruthy();
  });

  test('renders a unified timeline with decisions + chat audits', () => {
    const decisions = [
      decision({ id: 'd1'.padEnd(64, '0'), solve_ts: '2026-05-23T10:00:00Z', operator: 'alice' }),
      decision({ id: 'd2'.padEnd(64, '0'), solve_ts: '2026-05-23T09:00:00Z', operator: 'bob' }),
    ];
    const chatRows = [
      chat({ id: 'c1'.padEnd(64, '0'), ts: '2026-05-23T09:30:00Z', user_id: 'alice' }),
    ];

    render(<AuditLedger decisions={decisions} chatRows={chatRows} />);

    const rows = screen.getAllByTestId('audit-row');
    expect(rows.length).toBe(3);
    // Newest first → d1 (10:00) > chat (09:30) > d2 (09:00).
    expect(within(rows[0]).getByText(/decision/i)).toBeTruthy();
    expect(within(rows[1]).getByText(/chat/i)).toBeTruthy();
    expect(within(rows[2]).getByText(/decision/i)).toBeTruthy();
  });

  test('expanding a decision row reveals the budget + objective deltas vs the previous decision', () => {
    // Two decisions by the same operator with different budgets.
    const newer = decision({
      id: 'd1'.padEnd(64, '0'),
      solve_ts: '2026-05-23T10:00:00Z',
      operator: 'alice',
      inputs_json: JSON.stringify({
        budgets: { capital_budget: 1.5e7, max_nonrenew_pct: 0.1, cession_budget: 6e6 },
        horizon_start: '2026-01-01',
        horizon_end: '2026-12-31',
        cohorts_hash: 'c'.repeat(64),
      }),
      outputs_json: JSON.stringify({
        status: 'Optimal',
        objective: 13_500_000,
        action_summary: {
          retain: { count: 95, tiv: 9.5e8 },
          non_renew: { count: 7, tiv: 7e7 },
          cede_xs: { count: 13, tiv: 2.5e8 },
        },
      }),
    });
    const older = decision({
      id: 'd2'.padEnd(64, '0'),
      solve_ts: '2026-05-23T09:00:00Z',
      operator: 'alice',
      inputs_json: JSON.stringify({
        budgets: { capital_budget: 1e7, max_nonrenew_pct: 0.1, cession_budget: 5e6 },
        horizon_start: '2026-01-01',
        horizon_end: '2026-12-31',
        cohorts_hash: 'c'.repeat(64),
      }),
      outputs_json: JSON.stringify({
        status: 'Optimal',
        objective: 12_000_000,
        action_summary: {
          retain: { count: 100, tiv: 1e9 },
          non_renew: { count: 5, tiv: 5e7 },
          cede_xs: { count: 10, tiv: 2e8 },
        },
      }),
    });

    render(<AuditLedger decisions={[newer, older]} chatRows={[]} />);

    // Click expand on the newer decision.
    const rows = screen.getAllByTestId('audit-row');
    const expandBtn = within(rows[0]).getByRole('button', { name: /expand/i });
    fireEvent.click(expandBtn);

    const diff = screen.getByTestId('decision-diff');
    // Budget moved: capital +5M, cession +1M.
    expect(within(diff).getByText(/capital_budget/i)).toBeTruthy();
    expect(within(diff).getByText(/cession_budget/i)).toBeTruthy();
    // Objective moved: +1.5M — match the section header exactly so the
    // "objective" entry-key in the li below doesn't double-count.
    expect(within(diff).getByText('Objective')).toBeTruthy();
    // Action mix shifted: retain -5, non_renew +2, cede_xs +3.
    expect(within(diff).getByText(/retain/i)).toBeTruthy();
    expect(within(diff).getByText(/non_renew/i)).toBeTruthy();
  });

  test('expanding the oldest decision shows "no prior decision" rather than crashing', () => {
    const lone = decision({ id: 'd1'.padEnd(64, '0'), solve_ts: '2026-05-23T10:00:00Z' });
    render(<AuditLedger decisions={[lone]} chatRows={[]} />);
    const row = screen.getByTestId('audit-row');
    fireEvent.click(within(row).getByRole('button', { name: /expand/i }));
    const diff = screen.getByTestId('decision-diff');
    expect(within(diff).getByText(/no prior decision/i)).toBeTruthy();
  });

  test('type filter — "decisions only" hides chat rows', () => {
    const decisions = [decision({ id: 'd1'.padEnd(64, '0') })];
    const chatRows = [chat({ id: 'c1'.padEnd(64, '0') })];
    render(<AuditLedger decisions={decisions} chatRows={chatRows} />);
    expect(screen.getAllByTestId('audit-row').length).toBe(2);

    const select = screen.getByTestId('audit-filter-type') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'decisions' } });
    const rowsAfter = screen.getAllByTestId('audit-row');
    expect(rowsAfter.length).toBe(1);
    expect(within(rowsAfter[0]).getByText(/decision/i)).toBeTruthy();
  });

  test('type filter — "chat only" hides decision rows', () => {
    const decisions = [decision({ id: 'd1'.padEnd(64, '0') })];
    const chatRows = [chat({ id: 'c1'.padEnd(64, '0') })];
    render(<AuditLedger decisions={decisions} chatRows={chatRows} />);

    fireEvent.change(screen.getByTestId('audit-filter-type'), {
      target: { value: 'chat' },
    });
    const rowsAfter = screen.getAllByTestId('audit-row');
    expect(rowsAfter.length).toBe(1);
    expect(within(rowsAfter[0]).getByText(/chat/i)).toBeTruthy();
  });

  test('operator filter — typing reduces row count', () => {
    const decisions = [
      decision({ id: 'd1'.padEnd(64, '0'), operator: 'alice' }),
      decision({ id: 'd2'.padEnd(64, '0'), operator: 'bob', solve_ts: '2026-05-22T10:00:00Z' }),
    ];
    const chatRows = [
      chat({ id: 'c1'.padEnd(64, '0'), user_id: 'alice', ts: '2026-05-23T08:00:00Z' }),
      chat({ id: 'c2'.padEnd(64, '0'), user_id: 'carol', ts: '2026-05-22T08:00:00Z' }),
    ];
    render(<AuditLedger decisions={decisions} chatRows={chatRows} />);
    expect(screen.getAllByTestId('audit-row').length).toBe(4);

    const input = screen.getByTestId('audit-filter-operator');
    fireEvent.change(input, { target: { value: 'alice' } });
    const rowsAfter = screen.getAllByTestId('audit-row');
    // alice has 1 decision + 1 chat = 2 rows.
    expect(rowsAfter.length).toBe(2);
  });

  test('pagination — caps display at pageSize and offers "load more"', () => {
    // 60 decisions, default pageSize = 25 → first render shows 25, button
    // appears, click loads the next 25.
    const decisions = Array.from({ length: 60 }, (_, i) =>
      decision({
        id: `d${i}`.padEnd(64, '0'),
        solve_ts: new Date(2026, 0, 1, 12, 0, 60 - i).toISOString(),
      }),
    );
    render(<AuditLedger decisions={decisions} chatRows={[]} pageSize={25} />);
    expect(screen.getAllByTestId('audit-row').length).toBe(25);

    const loadMore = screen.getByTestId('audit-load-more');
    fireEvent.click(loadMore);
    expect(screen.getAllByTestId('audit-row').length).toBe(50);

    fireEvent.click(loadMore);
    expect(screen.getAllByTestId('audit-row').length).toBe(60);

    // Once the corpus is exhausted the button disappears.
    expect(screen.queryByTestId('audit-load-more')).toBeNull();
  });

  test('reversed decision is visually marked', () => {
    const d = decision({
      id: 'd1'.padEnd(64, '0'),
      reversed_at: '2026-05-23T12:00:00Z',
      reversed_by: 'bob',
    });
    render(<AuditLedger decisions={[d]} chatRows={[]} />);
    expect(screen.getByTestId('audit-row-reversed')).toBeTruthy();
  });
});
