// tests/e2e/phase1.spec.ts
import { test, expect } from '@playwright/test';

test('phase 1 smoke — landing → portfolio → events → claims → methodology', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await expect(page.getByTestId('exec-card').first()).toBeVisible();
  await page.click('text=Portfolio');
  await expect(page.locator('[data-testid="exec-card"]')).toHaveCount(5);
  await page.click('text=Events');
  await expect(page.getByTestId('trust-tier-badge').first()).toBeVisible();
  await page.click('text=Claims');
  await expect(page.getByTestId('provenance-footnote')).toBeVisible();
  await page.goto('http://localhost:3000/methodology');
  await expect(page.locator('h1')).toHaveText('Methodology');
});
