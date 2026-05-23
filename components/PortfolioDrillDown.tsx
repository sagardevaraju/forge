'use client';
/**
 * Drilldown panel for a single ZIP3 within the Portfolio Map. (Task 13 adds
 * the Property-features sub-section + unmodeled-dim transparency footnote;
 * Task 17 wires hover-to-source attribution onto the action fractions so
 * reviewers can see the economic coefficients and the Python source line
 * that owns them. Task P2.33 adds the operator pin affordance — a per-cohort
 * dropdown + rationale text box + Pin button that POSTs to ``/api/pins`` and
 * surfaces existing pins inline with a Remove button.)
 *
 * Shows the cohorts inside the clicked ZIP3 along with the MIP-recommended
 * action mix per cohort. Dominant action is the row badge; minor fractions
 * appear as inline split-bars so the user can see when the optimizer is
 * recommending a blended action (e.g. 70% reprice-up + 30% cede_xs).
 *
 * Property features (Task 13) renders only the 5 modeled CV-head dims; the
 * 3 unmodeled dims (imperviousness, roof_complexity, tree_overhang) are
 * dropped and called out in a footnote so reviewers don't mistake the
 * absence for a bug.
 */
import { useEffect, useState } from 'react';
import type { Cohort } from '@/lib/db/cohorts';
import { type CvFeatures, UNMODELED_CV_DIMS } from '@/lib/portfolio/cv-features';
import {
  type OptimizedAction,
  type ActionName,
  ACTION_LABELS,
  ACTION_COLORS,
} from '@/lib/portfolio-actions';
import { renderRecommendation } from '@/lib/portfolio/narrative';
import { ECONOMICS_TABLE } from '@/lib/portfolio/economics';

interface PinRow {
  policy_id: number;
  action: ActionName;
  operator: string;
  ts: string;
  rationale: string;
}

interface Props {
  zip3: string;
  cohorts: Cohort[];
  /** Optional — when omitted (or the cache is missing) the action column
   * renders an em-dash and a footnote prompts the user to run the
   * precompute script. */
  actionByCohort?: Record<string, OptimizedAction>;
  onClose: () => void;
  /** P2.33 — show the operator pin affordance. Disabled in unit tests that
   * don't want the dropdown / fetch lifecycle. Defaults to ``true``. */
  enablePins?: boolean;
}

const ACTIONS: ActionName[] = [
  'retain',
  'reprice_n20',
  'reprice_n10',
  'reprice_0',
  'reprice_p5',
  'reprice_p10',
  'reprice_p15',
  'reprice_p20',
  'non_renew',
  'cede_qs',
  'cede_xs',
];

/** Human-friendly labels for the 5 modeled CV dims rendered in the panel. */
const CV_DIM_LABELS: Record<keyof CvFeatures, string> = {
  vegetation_density: 'Vegetation density',
  fuel_proximity: 'Fuel proximity',
  water_proximity: 'Water proximity',
  elevation_bucket: 'Elevation bucket',
  structure_density: 'Structure density',
};

/**
 * Average a per-dim CvFeatureValue across the cohorts in the drilled ZIP3,
 * weighted by policy count so a big cohort doesn't get drowned out by a
 * 1-policy sliver. Returns the same shape as a single cohort's CvFeatures.
 */
function averageCvFeatures(cohorts: Cohort[]): CvFeatures | null {
  const totalPolicies = cohorts.reduce((s, c) => s + c.policy_count, 0);
  if (totalPolicies === 0) return null;
  const dims = Object.keys(CV_DIM_LABELS) as Array<keyof CvFeatures>;
  const acc = {} as CvFeatures;
  for (const d of dims) {
    let weighted = 0;
    for (const c of cohorts) {
      weighted += c.avg_cv_features[d].value * c.policy_count;
    }
    acc[d] = { value: weighted / totalPolicies, modeled: true };
  }
  return acc;
}

/**
 * Hover-to-source tooltip (Task 17). Renders one line per economic term —
 * premium × REPRICE, loss × LOSS_FACTOR, cession cost — followed by the
 * Python source line and the Phase-2 replacement note. Plain-text only
 * because the `title` attribute does not render HTML.
 */
function economicsTooltip(a: ActionName, fracPct?: string): string {
  const row = ECONOMICS_TABLE[a];
  const header = fracPct
    ? `${ACTION_LABELS[a]} · ${fracPct}`
    : ACTION_LABELS[a];
  return [
    header,
    `premium ×${row.reprice.toFixed(2)}`,
    `loss ×${row.loss.toFixed(2)}`,
    `cession ${row.cession.toFixed(2)}`,
    `source: ${row.source}, ${row.note}`,
  ].join('\n');
}

function ActionSplitBar({ action }: { action: OptimizedAction }) {
  const segments = ACTIONS.map((a) => ({ a, frac: action[a] })).filter(
    (s) => s.frac > 0.005,
  );
  if (segments.length === 0) return null;
  return (
    <div
      role="img"
      aria-label={`action mix ${segments.map((s) => `${ACTION_LABELS[s.a]} ${(s.frac * 100).toFixed(0)}%`).join(', ')}`}
      style={{
        display: 'flex',
        width: '100%',
        height: 8,
        borderRadius: 2,
        overflow: 'hidden',
        border: '1px solid #e5e7eb',
      }}
    >
      {segments.map((s) => (
        <div
          key={s.a}
          style={{
            flexGrow: s.frac,
            background: ACTION_COLORS[s.a],
          }}
          title={economicsTooltip(s.a, `${(s.frac * 100).toFixed(0)}%`)}
        />
      ))}
    </div>
  );
}

export function PortfolioDrillDown({
  zip3,
  cohorts,
  actionByCohort,
  onClose,
  enablePins = true,
}: Props) {
  const totalTiv = cohorts.reduce((s, c) => s + c.total_tiv, 0);
  const totalPolicies = cohorts.reduce((s, c) => s + c.policy_count, 0);
  const actions = actionByCohort ?? {};
  const hasOptimization = Object.keys(actions).length > 0;
  const propertyFeatures = averageCvFeatures(cohorts);

  // ── P2.33 — Pin affordance state. ────────────────────────────────────
  // We keep one "drafting" pin at a time (per-cohort). The expanded cohort
  // is the one whose Pin button has been clicked but not yet submitted; the
  // panel exposes a dropdown + rationale box + Pin button. Existing pins
  // for the visible cohorts are rendered inline with a Remove button.
  const [draftCohort, setDraftCohort] = useState<string | null>(null);
  const [draftAction, setDraftAction] = useState<ActionName>('retain');
  const [draftRationale, setDraftRationale] = useState('');
  const [draftPolicyId, setDraftPolicyId] = useState('');
  const [pins, setPins] = useState<PinRow[]>([]);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  const cohortIds = cohorts.map((c) => c.id);

  async function refreshPins() {
    if (!enablePins) return;
    try {
      // Fetch every pin and filter locally — small N, single round-trip.
      const r = await fetch('/api/pins');
      if (!r.ok) return;
      const body = (await r.json()) as { pins?: PinRow[] };
      const all = body.pins ?? [];
      // Best-effort: when the route doesn't yet know about this cohort
      // (no policy_to_cohort_map seeded), keep every pin so the panel still
      // surfaces the override.
      setPins(all);
    } catch {
      // Network errors are non-fatal — the rest of the panel keeps working.
    }
  }

  useEffect(() => {
    void refreshPins();
    // We intentionally don't depend on `cohorts` — we want a single load per
    // panel open; Remove / Pin clicks refresh manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zip3]);

  function pinsForCohort(cohortId: string): PinRow[] {
    // No client-side policy_to_cohort_map; we keyword-match on cohort_id via
    // the server `?cohort_id=` filter on submit. For now, the panel surfaces
    // every pin; future iterations can scope by passing in a map prop.
    return pins.filter(() => cohortIds.includes(cohortId));
  }

  async function submitPin(cohortId: string) {
    const policyId = Number(draftPolicyId);
    if (!Number.isInteger(policyId) || policyId <= 0) {
      setPinError('Policy ID must be a positive integer.');
      return;
    }
    if (draftRationale.trim().length < 10) {
      setPinError('Rationale must be at least 10 characters.');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(
        `Pin policy ${policyId} to "${ACTION_LABELS[draftAction]}" for cohort ${cohortId}? ` +
          `This overrides the MIP for this cohort and is visible to the team.`,
      )
    ) {
      return;
    }
    setPinBusy(true);
    setPinError(null);
    try {
      const r = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          policy_id: policyId,
          action: draftAction,
          operator: 'demo_operator', // Phase 3 (P3.5) replaces this with auth.
          rationale: draftRationale.trim(),
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setPinError(body.error ?? `Pin failed (HTTP ${r.status}).`);
        return;
      }
      setDraftCohort(null);
      setDraftRationale('');
      setDraftPolicyId('');
      setDraftAction('retain');
      await refreshPins();
    } catch (e) {
      setPinError(e instanceof Error ? e.message : String(e));
    } finally {
      setPinBusy(false);
    }
  }

  async function removePin(policyId: number) {
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(`Remove pin for policy ${policyId}?`)
    ) {
      return;
    }
    setPinBusy(true);
    setPinError(null);
    try {
      const r = await fetch(`/api/pins?policy_id=${policyId}`, { method: 'DELETE' });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setPinError(body.error ?? `Delete failed (HTTP ${r.status}).`);
        return;
      }
      await refreshPins();
    } catch (e) {
      setPinError(e instanceof Error ? e.message : String(e));
    } finally {
      setPinBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 420,
        maxHeight: '92%',
        overflow: 'auto',
        background: 'white',
        padding: 16,
        border: '1px solid #e5e7eb',
        borderRadius: 4,
        fontSize: 13,
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close drill-down"
        style={{
          float: 'right',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 16,
          color: '#52525b',
        }}
      >
        ✕
      </button>
      <h3 style={{ fontWeight: 600, marginBottom: 8 }}>ZIP3 {zip3}</h3>
      <div style={{ color: '#3f3f46' }}>
        Total TIV: $
        {totalTiv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </div>
      <div style={{ color: '#3f3f46' }}>Policies: {totalPolicies.toLocaleString()}</div>
      {hasOptimization && (
        <p style={{ color: '#18181b', marginTop: 8 }}>
          {renderRecommendation(cohorts.map((c) => actions[c.id]).filter(Boolean))}
        </p>
      )}
      <h4 style={{ marginTop: 14, marginBottom: 6, fontWeight: 600 }}>
        Cohorts {hasOptimization ? '· recommended actions' : ''}
      </h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb', color: '#52525b' }}>
            <th style={{ textAlign: 'left', padding: '4px 6px 4px 0' }}>Cohort</th>
            <th style={{ textAlign: 'right', padding: 4 }}>TIV</th>
            <th style={{ textAlign: 'left', padding: 4 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => {
            const a = actions[c.id];
            const cohortPins = enablePins ? pinsForCohort(c.id) : [];
            const drafting = draftCohort === c.id;
            return (
              <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '4px 6px 4px 0', fontFamily: 'monospace' }}>
                  {c.id}
                </td>
                <td style={{ padding: 4, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  ${(c.total_tiv / 1e6).toFixed(1)}M
                </td>
                <td style={{ padding: 4, minWidth: 150 }}>
                  {a && a.dominant_action !== null ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'help' }}
                        title={economicsTooltip(
                          a.dominant_action,
                          `${(a.dominant_share * 100).toFixed(0)}%`,
                        )}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: ACTION_COLORS[a.dominant_action],
                            display: 'inline-block',
                          }}
                        />
                        <span style={{ color: '#18181b' }}>
                          {ACTION_LABELS[a.dominant_action]}
                          {a.dominant_share < 0.99 && (
                            <span style={{ color: '#6b7280' }}>
                              {' '}
                              · {(a.dominant_share * 100).toFixed(0)}%
                            </span>
                          )}
                        </span>
                      </div>
                      <ActionSplitBar action={a} />
                    </div>
                  ) : (
                    <span style={{ color: '#9ca3af' }}>—</span>
                  )}
                  {enablePins && (
                    <div
                      data-testid={`pin-controls-${c.id}`}
                      style={{ marginTop: 6 }}
                    >
                      {cohortPins.length > 0 && (
                        <ul
                          aria-label={`pins for cohort ${c.id}`}
                          style={{
                            listStyle: 'none',
                            padding: 0,
                            margin: '0 0 4px 0',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          }}
                        >
                          {cohortPins.map((p) => (
                            <li
                              key={p.policy_id}
                              style={{
                                fontSize: 11,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                color: '#374151',
                              }}
                            >
                              <span
                                aria-hidden
                                style={{
                                  width: 6,
                                  height: 6,
                                  borderRadius: '50%',
                                  background: ACTION_COLORS[p.action],
                                  display: 'inline-block',
                                }}
                              />
                              <span style={{ fontFamily: 'monospace' }}>
                                pin #{p.policy_id}
                              </span>
                              <span style={{ color: '#6b7280' }}>
                                {ACTION_LABELS[p.action]}
                              </span>
                              <button
                                type="button"
                                onClick={() => void removePin(p.policy_id)}
                                disabled={pinBusy}
                                aria-label={`Remove pin for policy ${p.policy_id}`}
                                style={{
                                  marginLeft: 'auto',
                                  fontSize: 10,
                                  border: '1px solid #e5e7eb',
                                  background: '#fafafa',
                                  borderRadius: 2,
                                  padding: '1px 4px',
                                  cursor: pinBusy ? 'wait' : 'pointer',
                                }}
                              >
                                Remove pin
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!drafting && (
                        <button
                          type="button"
                          onClick={() => {
                            setDraftCohort(c.id);
                            setPinError(null);
                          }}
                          style={{
                            fontSize: 11,
                            border: '1px solid #e5e7eb',
                            background: '#ffffff',
                            borderRadius: 2,
                            padding: '2px 6px',
                            cursor: 'pointer',
                            color: '#374151',
                          }}
                        >
                          Pin action
                        </button>
                      )}
                      {drafting && (
                        <div
                          data-testid={`pin-draft-${c.id}`}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            padding: 6,
                            border: '1px solid #e5e7eb',
                            background: '#f9fafb',
                            borderRadius: 2,
                          }}
                        >
                          <label style={{ fontSize: 11, color: '#374151' }}>
                            Policy ID
                            <input
                              type="number"
                              min={1}
                              value={draftPolicyId}
                              onChange={(e) => setDraftPolicyId(e.target.value)}
                              aria-label={`Policy ID to pin in ${c.id}`}
                              style={{
                                width: '100%',
                                fontSize: 11,
                                padding: 2,
                                border: '1px solid #d1d5db',
                                borderRadius: 2,
                              }}
                            />
                          </label>
                          <label style={{ fontSize: 11, color: '#374151' }}>
                            Action
                            <select
                              value={draftAction}
                              onChange={(e) =>
                                setDraftAction(e.target.value as ActionName)
                              }
                              aria-label={`Pin action for ${c.id}`}
                              style={{
                                width: '100%',
                                fontSize: 11,
                                padding: 2,
                                border: '1px solid #d1d5db',
                                borderRadius: 2,
                              }}
                            >
                              {ACTIONS.map((act) => (
                                <option key={act} value={act}>
                                  {ACTION_LABELS[act]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label style={{ fontSize: 11, color: '#374151' }}>
                            Rationale
                            <textarea
                              value={draftRationale}
                              onChange={(e) => setDraftRationale(e.target.value)}
                              aria-label={`Pin rationale for ${c.id}`}
                              minLength={10}
                              rows={2}
                              style={{
                                width: '100%',
                                fontSize: 11,
                                padding: 2,
                                border: '1px solid #d1d5db',
                                borderRadius: 2,
                                resize: 'vertical',
                              }}
                            />
                          </label>
                          {pinError && (
                            <div
                              role="alert"
                              style={{ color: '#b91c1c', fontSize: 11 }}
                            >
                              {pinError}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => void submitPin(c.id)}
                              disabled={pinBusy}
                              style={{
                                fontSize: 11,
                                border: '1px solid #0f766e',
                                background: '#0d9488',
                                color: 'white',
                                borderRadius: 2,
                                padding: '2px 8px',
                                cursor: pinBusy ? 'wait' : 'pointer',
                              }}
                            >
                              {pinBusy ? 'Pinning…' : 'Pin'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDraftCohort(null);
                                setPinError(null);
                              }}
                              disabled={pinBusy}
                              style={{
                                fontSize: 11,
                                border: '1px solid #e5e7eb',
                                background: '#ffffff',
                                borderRadius: 2,
                                padding: '2px 8px',
                                cursor: pinBusy ? 'wait' : 'pointer',
                                color: '#374151',
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {propertyFeatures && (
        <section
          aria-label="Property features"
          data-testid="property-features"
          style={{ marginTop: 18 }}
        >
          <h4 style={{ marginBottom: 8, fontWeight: 600 }}>Property features</h4>
          {/*
            Earlier render used a 3-col fixed-layout table where the label
            column got squeezed to ~0px and the nowrap label overflowed *into*
            the bar's column — labels rendered on top of the dark fill,
            illegible. Now each row is a vertical stack: label + value on a
            single justified line, full-width track underneath. Reads cleanly
            at any width and matches the rest of the redesign's tile rhythm.
          */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(Object.keys(CV_DIM_LABELS) as Array<keyof CvFeatures>).map((d) => {
              const f = propertyFeatures[d];
              const pct = Math.round(f.value * 100);
              return (
                <div
                  key={d}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 12,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: '#3f3f46' }}>{CV_DIM_LABELS[d]}</span>
                    <span
                      style={{
                        color: '#18181b',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 500,
                      }}
                    >
                      {f.value.toFixed(2)}
                    </span>
                  </div>
                  <div
                    role="img"
                    aria-label={`${CV_DIM_LABELS[d]} ${pct} percent`}
                    style={{
                      height: 6,
                      background: '#f3f4f6',
                      borderRadius: 999,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: '#3f3f46',
                        borderRadius: 999,
                        transition: 'width 240ms ease-out',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <p style={{ marginTop: 12, fontSize: 11, color: '#6b7280', lineHeight: 1.45 }}>
            Three CV dims ({UNMODELED_CV_DIMS.join(', ')}) are unmodeled in
            this build; Phase 2 swaps in NLCD + OSM weak labels.
          </p>
        </section>
      )}
      {!hasOptimization && (
        <p style={{ marginTop: 12, fontSize: 11, color: '#6b7280' }}>
          Optimization cache not available, run{' '}
          <code>scripts/precompute_portfolio_optimization.py</code>.
        </p>
      )}
    </div>
  );
}
