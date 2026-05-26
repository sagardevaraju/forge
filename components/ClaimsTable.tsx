'use client';
/**
 * Task 22 — Claims Pre-Brief table.
 * Task 19 — Group rows by ZIP3 → county header rows.
 * Task 20 — Statutory non-renewal notice-period column.
 * Task P2.27 — Loss column reads cohort `loss_p50` from the Portfolio MIP
 *               artifact (not the LOSS_FACTOR heuristic). The column header
 *               now carries a `MODEL_OUTPUT` trust-tier badge to reflect
 *               that move; the rest of the page is still seeded synthetic
 *               policy data so the page-level badge stays SYNTHETIC_SCAFFOLD.
 *               Policies whose (zip3, build_type, quintile) cohort isn't in
 *               the artifact display "—" rather than a zero (so the table
 *               doesn't lie when the cohort is missing).
 * Task P2.26 — "Push to claims system" button. POSTs the visible (filtered)
 *               policy_ids to /api/claims/push, then surfaces an inline
 *               transient confirmation ("Pushed N policies"). Disabled when
 *               there are no visible rows. Phase 2 endpoint just logs;
 *               Phase 3 will persist to a decisions table.
 * Task P2.29 — Δ column compares each row's current `expected_loss` to the
 *               prior snapshot supplied via the `priorSeverities` prop. The
 *               page reads the previous snapshot from `claims_history` and
 *               writes the current one back so the next render can diff
 *               again. Tolerance: max($100, 2% of current) — anything inside
 *               that band renders "=" so noisy re-solves don't flicker the
 *               table. Missing prior or null current renders "—".
 *
 * Renders pre-flagged policies returned by the server component, with a
 * severity tier filter and a one-click CSV export. The export builds the
 * blob in-memory and uses `URL.createObjectURL` so we don't need a
 * server-side download endpoint for the demo.
 *
 * Rows are grouped by ZIP3. Each group is preceded by a header row that
 * shows the ZIP3, its real county (from `lib/regulatory/zip3_geo.ts`, which
 * the seed places every policy to match), a policy count, and a TIV
 * rollup. Severity filtering hides
 * individual policies; when a group has zero visible policies after the
 * filter is applied, the header is omitted as well so the table doesn't
 * render empty section banners.
 *
 * Each row also surfaces the statutory non-renewal notice-period window in
 * days (resolved from ZIP3 → state via `lib/regulatory/notice_periods.ts`)
 * so the ops user can gut-check whether a non-renewal action is even
 * feasible against the regulatory clock.
 */
import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { zip3CountyLabel } from '@/lib/regulatory/zip3_geo';
import { noticeWindowForZip3 } from '@/lib/regulatory/notice_periods';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { InfoIcon } from '@/components/grammar/InfoTooltip';

export interface PreflagPolicy {
  policy_id: number;
  zip3: string;
  tiv: number;
  build_type: string;
  flood_zone: string;
  severity: 'low' | 'medium' | 'high';
  /**
   * Task P2.27 — proportional split of the cohort's `loss_p50` based on
   * this policy's TIV share inside the cohort. `null` when the cohort
   * isn't present in the optimization artifact; the row renders "—" in
   * that case instead of faking a zero.
   */
  expected_loss: number | null;
}

interface Props {
  policies: PreflagPolicy[];
  /**
   * Task P2.29 — Map of `policy_id → prior severity` from the previous render
   * (read from `claims_history` server-side). Omit / undefined ⇒ first render,
   * every row shows "—".
   */
  priorSeverities?: Map<number, number>;
}

/**
 * Task P2.29 — Tolerance band for the severity-diff column. Anything inside
 * `max($100, 2% × current)` renders "=" rather than ↑/↓ to avoid flickering
 * arrows on negligible re-solves. Exported so unit tests / future callers
 * can reuse the same threshold.
 */
export const SEVERITY_DIFF_TOLERANCE_ABS = 100;
export const SEVERITY_DIFF_TOLERANCE_REL = 0.02;

export type SeverityDiff = '↑' | '↓' | '=' | '—';

/**
 * Task P2.29 — Pure helper: compares `current` against `prior` under the
 * documented tolerance and returns one of four symbols. Either argument
 * being `null` / `undefined` (no prior snapshot, or no current cohort match)
 * collapses to "—".
 */
export function computeSeverityDiff(
  current: number | null | undefined,
  prior: number | null | undefined,
): SeverityDiff {
  if (current == null || prior == null) return '—';
  const tol = Math.max(
    SEVERITY_DIFF_TOLERANCE_ABS,
    Math.abs(current) * SEVERITY_DIFF_TOLERANCE_REL,
  );
  const delta = current - prior;
  if (delta > tol) return '↑';
  if (delta < -tol) return '↓';
  return '=';
}

type SeverityFilter = 'all' | 'low' | 'medium' | 'high';

interface Zip3Group {
  zip3: string;
  county: string;
  policies: PreflagPolicy[];
  tivRollup: number;
}

/**
 * Group the filtered policy list by ZIP3, preserving the first-seen order
 * so the table doesn't reshuffle when the severity filter changes. Returns
 * one entry per ZIP3 with its real county, the policies in that ZIP3, and a
 * TIV rollup for the header row.
 */
function groupByZip3(policies: PreflagPolicy[]): Zip3Group[] {
  const order: string[] = [];
  const groups: Record<string, Zip3Group> = {};
  for (const p of policies) {
    if (!groups[p.zip3]) {
      order.push(p.zip3);
      groups[p.zip3] = {
        zip3: p.zip3,
        county: zip3CountyLabel(p.zip3),
        policies: [],
        tivRollup: 0,
      };
    }
    groups[p.zip3].policies.push(p);
    groups[p.zip3].tivRollup += p.tiv;
  }
  return order.map((z) => groups[z]);
}

export function ClaimsTable({ policies, priorSeverities }: Props) {
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const [pushState, setPushState] = useState<'idle' | 'pushing' | 'done' | 'error'>(
    'idle',
  );
  const [pushMessage, setPushMessage] = useState<string>('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const filtered = useMemo(
    () => (filter === 'all' ? policies : policies.filter((p) => p.severity === filter)),
    [filter, policies],
  );

  const groups = useMemo(() => groupByZip3(filtered), [filtered]);

  async function pushToClaimsSystem() {
    if (filtered.length === 0 || pushState === 'pushing') return;
    setPushState('pushing');
    setPushMessage('');
    try {
      const res = await fetch('/api/claims/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy_ids: filtered.map((p) => p.policy_id) }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { received: number };
      setPushState('done');
      setPushMessage(
        `Pushed ${data.received} ${data.received === 1 ? 'policy' : 'policies'}`,
      );
    } catch (e) {
      setPushState('error');
      setPushMessage(`Push failed: ${(e as Error).message}`);
    } finally {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => {
        setPushState('idle');
        setPushMessage('');
      }, 4000);
    }
  }

  const counts = useMemo(
    () => ({
      high: policies.filter((p) => p.severity === 'high').length,
      medium: policies.filter((p) => p.severity === 'medium').length,
      low: policies.filter((p) => p.severity === 'low').length,
    }),
    [policies],
  );

  function exportCsv() {
    const header =
      'policy_id,zip3,tiv,build_type,flood_zone,severity,expected_loss,notice_days\n';
    const rows = filtered
      .map(
        (p) =>
          `${p.policy_id},${p.zip3},${p.tiv},${p.build_type},${p.flood_zone},${p.severity},${p.expected_loss == null ? '' : p.expected_loss.toFixed(0)},${noticeWindowForZip3(p.zip3)}`,
      )
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preflag.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div data-testid="claims-table">
      <div className="flex gap-2 mb-3 items-center">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as SeverityFilter)}
          className="border rounded px-2 py-1 text-sm"
          aria-label="severity-filter"
        >
          <option value="all">All ({policies.length})</option>
          <option value="high">High ({counts.high})</option>
          <option value="medium">Medium ({counts.medium})</option>
          <option value="low">Low ({counts.low})</option>
        </select>
        <button
          onClick={exportCsv}
          className="bg-zinc-900 text-white px-3 py-1 rounded text-sm"
        >
          Export CSV
        </button>
        <button
          onClick={pushToClaimsSystem}
          disabled={filtered.length === 0 || pushState === 'pushing'}
          data-testid="push-to-claims"
          aria-label="push-to-claims-system"
          className="bg-blue-700 text-white px-3 py-1 rounded text-sm disabled:bg-zinc-300 disabled:text-zinc-500 disabled:cursor-not-allowed"
        >
          {pushState === 'pushing' ? 'Pushing…' : 'Push to claims system'}
        </button>
        <span className="text-xs text-zinc-500" data-testid="filtered-count">
          Showing {filtered.length}
        </span>
        {pushMessage && (
          <span
            data-testid="push-toast"
            role="status"
            aria-live="polite"
            className={`text-xs ${pushState === 'error' ? 'text-red-700' : 'text-emerald-700'}`}
          >
            {pushMessage}
          </span>
        )}
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th className="text-left p-2">Policy ID</th>
            <th className="text-left p-2">
              <span className="inline-flex items-center gap-1">
                ZIP3 <InfoIcon term="zip3" iconSize="sm" />
              </span>
            </th>
            <th className="text-right p-2">
              <span className="inline-flex items-center gap-1 justify-end">
                TIV <InfoIcon term="tiv" iconSize="sm" />
              </span>
            </th>
            <th className="text-left p-2">
              <span className="inline-flex items-center gap-1">
                Build <InfoIcon term="build-type" iconSize="sm" />
              </span>
            </th>
            <th className="text-left p-2">
              <span className="inline-flex items-center gap-1">
                Flood zone <InfoIcon term="flood-zone" iconSize="sm" />
              </span>
            </th>
            <th className="text-left p-2">
              <span className="inline-flex items-center gap-1">
                Severity <InfoIcon term="severity" iconSize="sm" />
              </span>
            </th>
            <th className="text-right p-2">
              <span className="inline-flex items-center gap-1 justify-end">
                Notice (days) <InfoIcon term="notice-days" iconSize="sm" />
              </span>
            </th>
            <th className="text-right p-2">
              <span className="inline-flex items-center gap-1.5 justify-end" data-testid="loss-trust-tier">
                Expected loss
                <InfoIcon term="expected-loss" iconSize="sm" />
                <TrustTierBadge tier="MODEL_OUTPUT" />
              </span>
            </th>
            <th
              className="text-center p-2"
              title="Change vs last refresh (max($100, 2%) tolerance)"
              data-testid="severity-diff-header"
            >
              <span className="inline-flex items-center gap-1 justify-center">
                Δ <InfoIcon term="expected-loss" iconSize="sm" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.zip3}>
              <tr
                className="bg-zinc-100 border-b border-zinc-300"
                data-testid={`zip3-group-${g.zip3}`}
              >
                <td
                  colSpan={9}
                  className="p-2 font-semibold text-zinc-800 text-xs uppercase tracking-wide"
                >
                  ZIP3 {g.zip3} · {g.county} · {g.policies.length}{' '}
                  {g.policies.length === 1 ? 'policy' : 'policies'} · $
                  {(g.tivRollup / 1e6).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                    minimumFractionDigits: 1,
                  })}
                  M TIV
                </td>
              </tr>
              {g.policies.map((p) => (
                <tr key={p.policy_id} className="border-b hover:bg-zinc-50">
                  <td className="p-2 font-mono text-xs">{p.policy_id}</td>
                  <td className="p-2">{p.zip3}</td>
                  <td className="p-2 text-right">${p.tiv.toLocaleString()}</td>
                  <td className="p-2">{p.build_type}</td>
                  <td className="p-2">{p.flood_zone}</td>
                  <td
                    className={`p-2 font-medium ${
                      p.severity === 'high'
                        ? 'text-red-700'
                        : p.severity === 'medium'
                          ? 'text-orange-700'
                          : 'text-zinc-700'
                    }`}
                  >
                    {p.severity}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {noticeWindowForZip3(p.zip3)}
                  </td>
                  <td className="p-2 text-right">
                    {p.expected_loss == null
                      ? '—'
                      : `$${p.expected_loss.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  </td>
                  {(() => {
                    const prior = priorSeverities?.get(p.policy_id);
                    const diff = computeSeverityDiff(p.expected_loss, prior);
                    const title =
                      prior == null
                        ? 'no prior snapshot'
                        : `prior $${prior.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
                    const color =
                      diff === '↑'
                        ? 'text-red-700'
                        : diff === '↓'
                          ? 'text-emerald-700'
                          : 'text-zinc-500';
                    return (
                      <td
                        className={`p-2 text-center font-medium tabular-nums ${color}`}
                        title={title}
                        data-testid={`severity-diff-${p.policy_id}`}
                      >
                        {diff}
                      </td>
                    );
                  })()}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
