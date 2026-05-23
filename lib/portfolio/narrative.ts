/**
 * Plain-English narrative summary of a Portfolio MIP recommendation set.
 * (Task 16 — surfaces a one-line recommendation above the cohort table in
 * the drill-down panel so a reviewer doesn't have to read the bar chart to
 * understand what the optimizer suggested.)
 *
 * Pure helper, no I/O. The single-action case includes the cohort id and
 * dominant share; the multi-action case rolls cohorts up by dominant action
 * and reports counts sorted descending so the largest group reads first.
 */
import type { OptimizedAction, ActionName } from '../portfolio-actions';
import { ACTION_LABELS } from '../portfolio-actions';

export function renderRecommendation(actions: OptimizedAction[]): string {
  // Schema v5: dominant_action can be null under an Infeasible solve.
  // Filter those out — the optimizer didn't produce a recommendation for
  // them, and rendering "FORGE recommends null" would be worse than
  // silence.
  const decided = actions.filter(
    (a): a is OptimizedAction & { dominant_action: ActionName } => a.dominant_action !== null,
  );
  if (decided.length === 0) return 'No MIP recommendation available.';
  if (decided.length === 1) {
    const a = decided[0];
    return `FORGE recommends ${ACTION_LABELS[a.dominant_action].toLowerCase()} on cohort ${a.cohort_id} (${Math.round(a.dominant_share * 100)}%).`;
  }
  const counts: Partial<Record<ActionName, number>> = {};
  for (const a of decided) counts[a.dominant_action] = (counts[a.dominant_action] ?? 0) + 1;
  const parts = (Object.entries(counts) as [ActionName, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([action, n]) => `${ACTION_LABELS[action].toLowerCase()} ${n} cohort${n > 1 ? 's' : ''}`);
  return `FORGE recommends: ${parts.join(', ')}.`;
}
