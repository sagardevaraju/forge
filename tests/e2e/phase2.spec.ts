// tests/e2e/phase2.spec.ts
/**
 * Task P2.40 — Phase 2 end-to-end smoke.
 *
 * Six surfaces, six tests — each Phase 2 capability gets its own `test()`
 * block so a failure points at exactly one feature rather than the whole
 * mega-flow. Run via `npx playwright test tests/e2e/phase2.spec.ts`.
 *
 * Coverage:
 *   1. /portfolio what-if commit (P2.13)
 *   2. Persona switch through all 5 modes (P2.18) — Cat-ops / Actuary /
 *      Reinsurance / Field-ops / Academic
 *   3. /calibration renders (P2.16)
 *   4. /treaty renders (P2.17)
 *   5. Procedure-mode chat (P2.25) — pre_landfall_t72 runbook
 *   6. /claims push-mock (P2.26)
 *
 * Notes:
 *   - Procedure-mode test (#5) deliberately tolerates a final LLM error
 *     when API keys are absent: the smoke is about the UX path
 *     (mode toggle → runbook picker → status line streams) — not about
 *     the upstream summary text. We only require at least one tool_call
 *     status line to appear.
 *   - All test ids referenced here already exist in the production
 *     components (PortfolioWhatIfShell, PortfolioPersonaScope, ClaimsTable,
 *     CalibrationView, TreatyLadder, AgentChat).
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test('phase 2 — what-if commit on /portfolio re-solves and renders a delta', async ({ page }) => {
  await page.goto(`${BASE}/portfolio`);

  // 5-card ExecCard strip (cat-ops baseline = 5 cards in one row).
  await expect(page.locator('[data-testid="exec-card"]')).toHaveCount(5);

  // What-if rail is mounted for cat-ops.
  const rail = page.getByTestId('whatif-rail');
  await expect(rail).toBeVisible();

  // Three WhatIfControl sliders bound to the three MIP budgets.
  await expect(page.locator('[data-testid="whatif-control"]')).toHaveCount(3);

  // Move the cession budget slider. The shell renders Capital → Non-renew →
  // Cession sliders in that order; we drive the cession one through its
  // adjacent numeric input (the spinbutton next to each slider). Entering a
  // number + pressing Enter commits via WhatIfControl's `handleInputKeyDown`,
  // which is the same code path the route exercises in unit tests.
  // Phase-2 calibration sweep (commit c5fa234) added a unit suffix to the
  // What-if cession slider so its aria-label now ends in "($M)" rather than
  // "($)". The input value is in millions; we feed the new value back in the
  // same unit (raw / 1e6).
  const cessionInput = page
    .getByTestId('whatif-rail')
    .getByLabel('Cession budget ($M) numeric input');
  const currentVal = await cessionInput.inputValue();
  // Nudge by a large enough fraction that the server can compute a
  // measurable delta (the shell skips re-fetch when budgets are identical).
  const nextVal = (Number(currentVal) * 1.25).toFixed(0);
  await cessionInput.fill(nextVal);
  await cessionInput.press('Enter');

  // The "Solving..." spinner is mounted while the re-solve is in flight.
  // We try to catch it; if the re-solve completes faster than Playwright
  // can poll, we just continue — the post-condition (a delta sub-line)
  // is the real proof the commit fired.
  const spinner = page.getByTestId('whatif-spinner');
  await spinner.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  await expect(spinner).toBeHidden({ timeout: 60_000 });

  // After the re-solve, at least one ExecCard surfaces a "$Xm vs baseline"
  // delta sub-line. The shell injects the delta on the cards that move:
  // typically the cession-spend / capital-used / expected-margin trio.
  await expect(
    page.locator('[data-testid="exec-card"]').getByText(/vs baseline/i).first(),
  ).toBeVisible({ timeout: 30_000 });
});

test('phase 2 — persona switch through all 5 modes on /portfolio', async ({ page }) => {
  await page.goto(`${BASE}/portfolio`);

  // The persona toggle lives in the global LayoutSubBanner (one source of
  // truth). The PortfolioPersonaScope only reads `?persona=` and re-shapes
  // the page; it does not render its own toggle.
  const toggle = page.getByRole('group', { name: 'persona-toggle' });
  await expect(toggle).toBeVisible();

  // 1) Cat-ops — canonical, no query param. The cat-ops baseline includes
  // the Cession spend card (renamed from "Cession spend / budget" — the
  // "/ budget" suffix moved into a caption sub-line on the same card so
  // we match only the label proper here).
  await toggle.getByRole('button', { name: 'Cat-ops' }).click();
  await expect(page).toHaveURL(/\/portfolio(\?(?!.*persona=).*)?$/);
  await expect(page.getByText('Cession spend', { exact: true })).toBeVisible();

  // 2) Actuary — "Retained TVaR-99" replaces Expected margin; CRPS card
  // appears. Schema v5 (commit c5fa234) replaced the v4 single-quantile
  // VaR-99 proxy with a true book-level TVaR-99 from the artifact, so
  // the Actuary card now reads "Retained TVaR-99" — and that's the right
  // measure (coherent, sub-additive, reflects the optimizer's action
  // mix rather than the gross book).
  await toggle.getByRole('button', { name: 'Actuary' }).click();
  await expect(page).toHaveURL(/[?&]persona=actuary/);
  await expect(page.getByText('Retained TVaR-99')).toBeVisible();
  await expect(page.getByText('CRPS')).toBeVisible();

  // 3) Reinsurance — RoL by layer replaces Cession spend; Retained tail added.
  await toggle.getByRole('button', { name: 'Reinsurance' }).click();
  await expect(page).toHaveURL(/[?&]persona=reinsurance/);
  await expect(page.getByText('RoL by layer')).toBeVisible();
  await expect(page.getByText('Retained tail (post-XS)')).toBeVisible();

  // 4) Field-ops — adds VRP demand-adjustments card.
  await toggle.getByRole('button', { name: 'Field-ops' }).click();
  await expect(page).toHaveURL(/[?&]persona=field-ops/);
  await expect(page.getByText('VRP demand adj.')).toBeVisible();

  // 5) Academic — adds SAA optimality-gap card.
  await toggle.getByRole('button', { name: 'Academic' }).click();
  await expect(page).toHaveURL(/[?&]persona=academic/);
  await expect(page.getByText('SAA optimality gap')).toBeVisible();

  // Phase 3 cleanup removed the `/events` persona surface — the toggle
  // there only swapped a single drill-in link without reshaping the page,
  // so EventsPersonaScope was deleted and `/events` was dropped from
  // PERSONA_AWARE_ROUTES. The persona toggle is now only visible on
  // `/portfolio` where it materially swaps ExecCards.
  await page.goto(`${BASE}/events`);
  const eventsToggle = page.getByRole('group', { name: 'persona-toggle' });
  await expect(eventsToggle).toHaveCount(0);
});

test('phase 2 — /calibration renders reliability diagrams', async ({ page }) => {
  await page.goto(`${BASE}/calibration`);

  await expect(page.locator('h1')).toHaveText('Calibration');

  // Three reliability diagrams (p10 / p50 / p90).
  await expect(page.locator('[data-testid="reliability-chart"]')).toHaveCount(3);
  await expect(page.getByTestId('reliability-chart-p10')).toBeVisible();
  await expect(page.getByTestId('reliability-chart-p50')).toBeVisible();
  await expect(page.getByTestId('reliability-chart-p90')).toBeVisible();

  // PIT histogram for the scenario generator.
  await expect(page.getByTestId('pit-histogram')).toBeVisible();
});

test('phase 2 — /treaty renders the layer ladder', async ({ page }) => {
  await page.goto(`${BASE}/treaty`);

  await expect(page.locator('h1')).toHaveText('Treaty');

  // The TreatyLadder SVG, the per-layer table, and at least one stacked band.
  await expect(page.getByTestId('treaty-ladder-svg')).toBeVisible();
  await expect(page.getByTestId('treaty-layer-table')).toBeVisible();
  await expect(page.locator('[data-testid="treaty-band"]').first()).toBeVisible();
});

test('phase 2 — procedure-mode chat streams a runbook on /events', async ({ page }) => {
  await page.goto(`${BASE}/events`);

  const chat = page.getByTestId('agent-chat');
  await expect(chat).toBeVisible();

  // Flip to Procedure mode.
  await page.getByTestId('agent-mode-procedure').click();
  await expect(page.getByTestId('agent-procedure-form')).toBeVisible();

  // Pick the pre-landfall T-72 runbook (the dropdown lists by display name).
  await page.getByLabel('agent-runbook').selectOption({ value: 'pre_landfall_t72' });

  // Storm-id input only mounts once a runbook is selected.
  await page.getByLabel('agent-storm-id').fill('AL092024');

  // Submit. The route streams `tool_call` events as the runbook walks each
  // step — the AgentChat surfaces them via the status line.
  await page.getByRole('button', { name: 'Run' }).click();

  // Capture either a status-line update or a final assistant reply. We
  // accept either path because the route's terminal summarize LLM call
  // can legitimately fail without API keys; the procedure-mode UX path
  // is what we're verifying here.
  const status = page.getByTestId('agent-status-line');
  const lastAssistant = page.locator('div', { hasText: 'FORGE:' }).last();
  await Promise.race([
    status.waitFor({ state: 'visible', timeout: 30_000 }),
    lastAssistant.waitFor({ state: 'visible', timeout: 30_000 }),
  ]);

  // Either the status line said "Calling …" (tool stream observed) or the
  // assistant message landed — either proves the procedure-mode wiring
  // streamed end-to-end.
  const statusText = await status.textContent().catch(() => null);
  const assistantText = await lastAssistant.textContent().catch(() => null);
  expect(
    (statusText && /Calling|Step/i.test(statusText)) ||
      (assistantText && assistantText.trim().length > 'FORGE:'.length),
  ).toBeTruthy();
});

test('phase 2 — claims push-mock surfaces a success toast', async ({ page }) => {
  await page.goto(`${BASE}/claims`);

  // Table renders.
  await expect(page.getByTestId('claims-table')).toBeVisible();

  // Push to claims system → toast appears with "Pushed N polic(y|ies)".
  await page.getByTestId('push-to-claims').click();
  const toast = page.getByTestId('push-toast');
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toHaveText(/Pushed \d+ polic(y|ies)/);
});
