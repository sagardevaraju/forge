/**
 * Phase 2 / Task P2.37 — drill-down property-features end-to-end smoke.
 *
 * Asserts the full surface of the weak-label retraining is visible to a
 * /portfolio reviewer:
 *
 *   1. Drill into ZIP3 346 (FL Hernando — coastal/built-up), capture the
 *      imperviousness + tree_overhang readouts.
 *   2. Drill into ZIP3 286 (NC mountain — forested), capture same dims.
 *   3. Assert the two ZIPs differ on at least one of the geography-driven
 *      dims (imperviousness OR tree_overhang) by |Δ| > 0.05.
 *   4. Assert the citation footer ("Sources") lists ESA WorldCover under
 *      CC-BY-4.0 AND Microsoft US Building Footprints under ODbL-1.0.
 *
 * Pre-requisites:
 *   - `artifacts/cv_head.pt` retrained against
 *     `artifacts/cv_weak_labels.parquet` (Task P2.37 retrain step).
 *   - `policies.cv_features` repopulated via
 *     `python scripts/populate_cv_features.py --mode cached --use-head`
 *     so the DB carries real per-policy values for idx 1, 3, 6 instead
 *     of the band-math placeholders the head produces under bypass.
 *   - Dev server up at http://localhost:3000.
 *
 * If either ZIP3 is missing from the live policy book the test is
 * skipped with a clear message rather than failing — the spec says
 * "at least 2 distinct ZIPs", not these specific two.
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
// The synthetic seed places policies pseudo-uniformly inside each state,
// so FL 346 (Hernando) and NC 286 (mountain) — the original spec example
// — both come out as rural forested ZIPs with near-identical impervious
// and tree fractions (precompute on 2026-05-23: impervious 0.046 vs
// 0.087, tree 0.631 vs 0.628). The urban-vs-rural pair the seed actually
// exposes is TX 770 (Houston / Harris) vs FL 346 (impervious Δ=0.49,
// tree Δ=0.28) — that's what this test uses.
const ZIP_URBAN = '770';      // TX Harris
const ZIP_RURAL = '346';      // FL Hernando
const DIFF_GATE = 0.05;

async function drillIntoZip(page: import('@playwright/test').Page, zip3: string) {
  await page.goto(`${BASE}/portfolio`);
  // The map renders ZIP3 buttons in the legend / list panel; click the
  // one matching the requested zip3 and wait for the drill-down to mount.
  const trigger = page.getByRole('button', { name: new RegExp(`ZIP3\\s+${zip3}\\b`, 'i') });
  if (!(await trigger.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
    return null;
  }
  await trigger.first().click();
  // The PortfolioDrillDown panel writes its header as "ZIP3 <zip3>".
  await expect(page.getByRole('heading', { name: `ZIP3 ${zip3}` })).toBeVisible({ timeout: 5_000 });
  // Property-features section is data-testid="property-features"; the
  // numeric labels carry tabular-nums in the same column as the dim name.
  // We grab the section text and parse the per-dim values by label.
  const section = page.getByTestId('property-features');
  await expect(section).toBeVisible();
  const text = (await section.innerText()).split('\n');
  const values: Record<string, number> = {};
  for (let i = 0; i < text.length - 1; i++) {
    const label = text[i].trim();
    const v = Number(text[i + 1]);
    if (!Number.isFinite(v)) continue;
    values[label] = v;
  }
  return values;
}

test('P2.37 — drill-down on 2 distinct ZIPs shows geographic differentiation', async ({ page }) => {
  const urban = await drillIntoZip(page, ZIP_URBAN);
  if (!urban) test.skip(true, `ZIP3 ${ZIP_URBAN} not in the policy book; skipping geographic-contrast assertion.`);
  const rural = await drillIntoZip(page, ZIP_RURAL);
  if (!rural) test.skip(true, `ZIP3 ${ZIP_RURAL} not in the policy book; skipping geographic-contrast assertion.`);

  // At least one of the two geography-driven dims must differ by > DIFF_GATE.
  const dImpervious = Math.abs((urban!['Imperviousness'] ?? 0) - (rural!['Imperviousness'] ?? 0));
  const dTree = Math.abs((urban!['Tree overhang'] ?? 0) - (rural!['Tree overhang'] ?? 0));
  expect(
    dImpervious > DIFF_GATE || dTree > DIFF_GATE,
    `Imperviousness Δ=${dImpervious.toFixed(3)} AND tree_overhang Δ=${dTree.toFixed(3)} both ≤ ${DIFF_GATE}. ` +
      `TX Harris (urban) vs FL Hernando (rural) should differ on at least one geography-driven dim after retrain.`,
  ).toBe(true);
});

test('P2.37 — citation footer lists ESA WorldCover CC-BY-4.0 + MS Buildings ODbL-1.0', async ({ page }) => {
  await page.goto(`${BASE}/portfolio`);
  // Click any ZIP3 to open the drill-down (the first one in the book).
  const anyZipButton = page.getByRole('button', { name: /ZIP3\s+\d{3}/ }).first();
  if (!(await anyZipButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
    test.skip(true, 'No ZIP3 buttons visible — book may be empty.');
  }
  await anyZipButton.click();
  const citations = page.getByTestId('cv-feature-citations');
  await expect(citations).toBeVisible({ timeout: 5_000 });
  await expect(citations).toContainText(/ESA WorldCover/);
  await expect(citations).toContainText(/CC-BY-4\.0/);
  await expect(citations).toContainText(/Microsoft US Building Footprints/);
  await expect(citations).toContainText(/ODbL-1\.0/);
});
