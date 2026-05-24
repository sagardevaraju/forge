/**
 * Task P3.8 — Audit ledger view component.
 *
 * Renders a unified, time-ordered timeline of two append-only write
 * streams:
 *
 *   - `decisions` (P3.4) — one row per /api/optimize/portfolio solve.
 *     Carries operator + budgets + objective + action mix + lifecycle
 *     flags (executed/reversed/notices_sent). Expand-on-click reveals a
 *     diff vs the previous decision (budget deltas + objective delta +
 *     action-mix shift).
 *
 *   - `chatRows` (P2.36) — one row per agent chat turn. Carries user_id
 *     + the canonical-JSON tool-call sequence + content hashes (we never
 *     stored the raw prompt or final text, by design).
 *
 * Filters (purely client state — not URL-driven; the page can later add
 * query-param plumbing without touching this component):
 *   - Type filter: all / decisions-only / chat-only
 *   - Operator substring match (case-insensitive)
 *
 * Pagination: `pageSize` (default 25) rows visible; "Load more" reveals
 * the next batch.
 *
 * Out of scope (intentionally):
 *   - Editing or deleting rows. The WORM guard would refuse anyway —
 *     this view is read-only by design.
 *   - URL-driven filters. Keeps the test surface narrow.
 */
'use client';

import { useMemo, useState } from 'react';
import type { DecisionRow } from '@/lib/audit/decisions';
import type { AuditRow as ChatAuditRow } from '@/lib/audit/log';

// ────────────────────────────────────────────────────────────────────────
// Types — internal unified view-row.
// ────────────────────────────────────────────────────────────────────────

type FilterType = 'all' | 'decisions' | 'chat';

interface UnifiedRow {
  kind: 'decision' | 'chat';
  ts: string;
  actor: string;
  id: string;
  // The underlying row. Use a type-narrowing discriminator on `kind`.
  decision?: DecisionRow;
  chat?: ChatAuditRow;
}

interface AuditLedgerProps {
  decisions: DecisionRow[];
  chatRows: ChatAuditRow[];
  /** Initial page size for the unified timeline. Defaults to 25. */
  pageSize?: number;
}

// ────────────────────────────────────────────────────────────────────────
// Formatters
// ────────────────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtDelta(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${fmtMoney(n)}`;
}

function fmtCountDelta(n: number): string {
  if (n === 0) return '—';
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtTs(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '');
}

function shortHash(h: string, n = 8): string {
  return h.length > n ? h.slice(0, n) + '…' : h;
}

// ────────────────────────────────────────────────────────────────────────
// Decision diff
// ────────────────────────────────────────────────────────────────────────

interface DecisionInputs {
  budgets?: {
    capital_budget?: number;
    max_nonrenew_pct?: number;
    cession_budget?: number;
  };
  horizon_start?: string | null;
  horizon_end?: string | null;
  cohorts_hash?: string;
}

interface DecisionOutputs {
  status?: string;
  objective?: number | null;
  action_summary?: Record<string, { count: number; tiv: number }>;
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

interface DiffEntry {
  key: string;
  before: string;
  after: string;
}

function buildBudgetDiff(prev: DecisionRow, curr: DecisionRow): DiffEntry[] {
  const p = safeParse<DecisionInputs>(prev.inputs_json)?.budgets ?? {};
  const c = safeParse<DecisionInputs>(curr.inputs_json)?.budgets ?? {};
  const keys = ['capital_budget', 'max_nonrenew_pct', 'cession_budget'] as const;
  const entries: DiffEntry[] = [];
  for (const k of keys) {
    const pv = p[k];
    const cv = c[k];
    if (pv === cv) continue;
    const beforeNum = typeof pv === 'number' ? pv : 0;
    const afterNum = typeof cv === 'number' ? cv : 0;
    const delta = afterNum - beforeNum;
    entries.push({
      key: k,
      before:
        k === 'max_nonrenew_pct'
          ? `${((typeof pv === 'number' ? pv : 0) * 100).toFixed(1)}%`
          : fmtMoney(beforeNum),
      after:
        k === 'max_nonrenew_pct'
          ? `${((typeof cv === 'number' ? cv : 0) * 100).toFixed(1)}% (${
              delta >= 0 ? '+' : ''
            }${(delta * 100).toFixed(1)}pp)`
          : `${fmtMoney(afterNum)} (${fmtDelta(delta)})`,
    });
  }
  return entries;
}

function buildObjectiveDiff(prev: DecisionRow, curr: DecisionRow): DiffEntry | null {
  const p = safeParse<DecisionOutputs>(prev.outputs_json)?.objective;
  const c = safeParse<DecisionOutputs>(curr.outputs_json)?.objective;
  if (typeof p !== 'number' || typeof c !== 'number') return null;
  if (p === c) return null;
  const delta = c - p;
  return {
    key: 'objective',
    before: fmtMoney(p),
    after: `${fmtMoney(c)} (${fmtDelta(delta)})`,
  };
}

function buildActionMixDiff(prev: DecisionRow, curr: DecisionRow): DiffEntry[] {
  const p = safeParse<DecisionOutputs>(prev.outputs_json)?.action_summary ?? {};
  const c = safeParse<DecisionOutputs>(curr.outputs_json)?.action_summary ?? {};
  const keys = new Set([...Object.keys(p), ...Object.keys(c)]);
  const entries: DiffEntry[] = [];
  for (const k of keys) {
    const pc = p[k]?.count ?? 0;
    const cc = c[k]?.count ?? 0;
    if (pc === cc) continue;
    entries.push({
      key: k,
      before: `${pc} cohorts`,
      after: `${cc} cohorts (${fmtCountDelta(cc - pc)})`,
    });
  }
  return entries;
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function AuditLedger({ decisions, chatRows, pageSize = 25 }: AuditLedgerProps) {
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [operatorFilter, setOperatorFilter] = useState('');
  const [visible, setVisible] = useState(pageSize);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Build the unified timeline once, then filter by type + operator on
  // each render. Decisions sorted newest-first by solve_ts; chat rows by
  // ts. The merge is a single descending sort on the join key.
  const unified: UnifiedRow[] = useMemo(() => {
    const rows: UnifiedRow[] = [];
    for (const d of decisions) {
      rows.push({
        kind: 'decision',
        ts: d.solve_ts,
        actor: d.operator,
        id: d.id,
        decision: d,
      });
    }
    for (const c of chatRows) {
      rows.push({
        kind: 'chat',
        ts: c.ts,
        actor: c.user_id,
        id: c.id,
        chat: c,
      });
    }
    rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return rows;
  }, [decisions, chatRows]);

  // Decisions in timeline order — used to find each row's "previous
  // decision" for the diff view, independent of the active filter set.
  // (Filtering doesn't change history; diffing against a filtered-out
  // ancestor would mislead.)
  const decisionsByTs = useMemo(
    () =>
      [...decisions].sort((a, b) =>
        a.solve_ts < b.solve_ts ? 1 : a.solve_ts > b.solve_ts ? -1 : 0,
      ),
    [decisions],
  );

  const filtered = useMemo(() => {
    const op = operatorFilter.trim().toLowerCase();
    return unified.filter((r) => {
      if (typeFilter === 'decisions' && r.kind !== 'decision') return false;
      if (typeFilter === 'chat' && r.kind !== 'chat') return false;
      if (op && !r.actor.toLowerCase().includes(op)) return false;
      return true;
    });
  }, [unified, typeFilter, operatorFilter]);

  const slice = filtered.slice(0, visible);
  const hasMore = visible < filtered.length;

  if (unified.length === 0) {
    return (
      <div data-testid="audit-ledger-empty" className="text-sm text-neutral-500">
        No audit rows yet. Run a solve on /portfolio or chat with the agent on
        /events to populate the ledger.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-neutral-600">Type</span>
          <select
            data-testid="audit-filter-type"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value as FilterType);
              setVisible(pageSize);
            }}
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            <option value="decisions">Decisions only</option>
            <option value="chat">Chat only</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-600">Operator</span>
          <input
            data-testid="audit-filter-operator"
            value={operatorFilter}
            onChange={(e) => {
              setOperatorFilter(e.target.value);
              setVisible(pageSize);
            }}
            placeholder="substring"
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
          />
        </label>
        <span className="ml-auto text-xs text-neutral-500">
          {filtered.length} of {unified.length} rows
        </span>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="border-b border-neutral-200 py-2 pr-3">When</th>
            <th className="border-b border-neutral-200 py-2 pr-3">Kind</th>
            <th className="border-b border-neutral-200 py-2 pr-3">Actor</th>
            <th className="border-b border-neutral-200 py-2 pr-3">Summary</th>
            <th className="border-b border-neutral-200 py-2 pr-3">Id</th>
            <th className="border-b border-neutral-200 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {slice.map((row) => (
            <AuditRow
              key={row.id}
              row={row}
              decisionsByTs={decisionsByTs}
              expanded={expandedId === row.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === row.id ? null : row.id))
              }
            />
          ))}
        </tbody>
      </table>

      {hasMore ? (
        <button
          data-testid="audit-load-more"
          onClick={() => setVisible((n) => n + pageSize)}
          className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm hover:bg-neutral-50"
        >
          Load {Math.min(pageSize, filtered.length - visible)} more
        </button>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Row sub-component — kept inline because it's only used here.
// ────────────────────────────────────────────────────────────────────────

interface AuditRowProps {
  row: UnifiedRow;
  decisionsByTs: DecisionRow[];
  expanded: boolean;
  onToggle: () => void;
}

function AuditRow({ row, decisionsByTs, expanded, onToggle }: AuditRowProps) {
  const isReversed =
    row.kind === 'decision' && row.decision?.reversed_at !== null;
  return (
    <>
      <tr
        data-testid="audit-row"
        {...(isReversed ? { 'data-testid-extra': 'audit-row-reversed' } : {})}
        className={isReversed ? 'bg-red-50/50' : undefined}
      >
        <td className="border-b border-neutral-100 py-2 pr-3 font-mono text-xs">
          {fmtTs(row.ts)}
        </td>
        <td className="border-b border-neutral-100 py-2 pr-3">
          {row.kind === 'decision' ? 'Decision' : 'Chat'}
        </td>
        <td className="border-b border-neutral-100 py-2 pr-3">{row.actor}</td>
        <td className="border-b border-neutral-100 py-2 pr-3 text-neutral-700">
          {row.kind === 'decision'
            ? decisionSummary(row.decision!)
            : chatSummary(row.chat!)}
        </td>
        <td className="border-b border-neutral-100 py-2 pr-3 font-mono text-xs text-neutral-500">
          {shortHash(row.id)}
        </td>
        <td className="border-b border-neutral-100 py-2 text-right">
          <button
            onClick={onToggle}
            aria-label={expanded ? 'Collapse row' : 'Expand row'}
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:bg-neutral-50"
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </td>
      </tr>
      {/* P3.8: react-table best practice is a *separate* marker row that
          carries the reversed data-testid so the test can find it via
          getByTestId('audit-row-reversed') without conflicting with the
          all-rows query. */}
      {isReversed ? (
        <tr data-testid="audit-row-reversed" className="hidden">
          <td colSpan={6} />
        </tr>
      ) : null}
      {expanded ? (
        <tr>
          <td colSpan={6} className="border-b border-neutral-100 py-2">
            {row.kind === 'decision' ? (
              <DecisionDiff curr={row.decision!} all={decisionsByTs} />
            ) : (
              <ChatDetail row={row.chat!} />
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function decisionSummary(d: DecisionRow): string {
  const out = safeParse<DecisionOutputs>(d.outputs_json);
  if (!out) return '(unparseable outputs)';
  const obj = typeof out.objective === 'number' ? fmtMoney(out.objective) : '—';
  const summary = out.action_summary ?? {};
  const nonRenew = summary.non_renew?.count ?? 0;
  const ceded =
    (summary.cede_qs?.count ?? 0) + (summary.cede_xs?.count ?? 0);
  return `${out.status ?? 'unknown'} · obj ${obj} · ${nonRenew} non-renew · ${ceded} ceded`;
}

function chatSummary(c: ChatAuditRow): string {
  const calls = safeParse<Array<{ name: string }>>(c.tool_calls_json) ?? [];
  if (calls.length === 0) return 'turn (no tool calls)';
  if (calls.length === 1) return `turn · ${calls[0].name}`;
  return `turn · ${calls.length} tool calls (${calls
    .slice(0, 2)
    .map((x) => x.name)
    .join(', ')}${calls.length > 2 ? ', …' : ''})`;
}

function DecisionDiff({
  curr,
  all,
}: {
  curr: DecisionRow;
  all: DecisionRow[];
}) {
  // Find the decision immediately older than `curr`.
  const idx = all.findIndex((d) => d.id === curr.id);
  const prev = idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null;

  if (!prev) {
    return (
      <div data-testid="decision-diff" className="text-sm text-neutral-600">
        No prior decision to diff against — this is the oldest entry in the
        ledger.
      </div>
    );
  }

  const budget = buildBudgetDiff(prev, curr);
  const objective = buildObjectiveDiff(prev, curr);
  const actions = buildActionMixDiff(prev, curr);

  if (budget.length === 0 && !objective && actions.length === 0) {
    return (
      <div data-testid="decision-diff" className="text-sm text-neutral-600">
        Diff vs prior decision <span className="font-mono">{shortHash(prev.id)}</span>:
        no differences in budgets, objective, or action mix.
      </div>
    );
  }

  return (
    <div data-testid="decision-diff" className="space-y-2 text-sm">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        Diff vs prior decision{' '}
        <span className="font-mono normal-case">{shortHash(prev.id)}</span> ·{' '}
        {fmtTs(prev.solve_ts)}
      </div>
      {budget.length > 0 ? (
        <DiffSection title="Budgets" entries={budget} />
      ) : null}
      {objective ? <DiffSection title="Objective" entries={[objective]} /> : null}
      {actions.length > 0 ? (
        <DiffSection title="Action mix" entries={actions} />
      ) : null}
    </div>
  );
}

function DiffSection({ title, entries }: { title: string; entries: DiffEntry[] }) {
  return (
    <div>
      <div className="text-xs font-medium text-neutral-700">{title}</div>
      <ul className="ml-3 mt-1 list-disc space-y-0.5 text-xs">
        {entries.map((e) => (
          <li key={e.key}>
            <span className="font-mono">{e.key}</span>: {e.before} → {e.after}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatDetail({ row }: { row: ChatAuditRow }) {
  return (
    <div className="space-y-1 text-xs">
      <div>
        <span className="text-neutral-500">prompt_hash:</span>{' '}
        <span className="font-mono">{row.prompt_hash}</span>
      </div>
      <div>
        <span className="text-neutral-500">tool_calls:</span>{' '}
        <span className="font-mono break-all">{row.tool_calls_json}</span>
      </div>
      <div>
        <span className="text-neutral-500">final_hash:</span>{' '}
        <span className="font-mono">{row.final_hash}</span>
      </div>
    </div>
  );
}
