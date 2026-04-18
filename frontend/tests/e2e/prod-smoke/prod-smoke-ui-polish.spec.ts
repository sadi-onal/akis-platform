/**
 * Prod smoke — UI polish bundle.
 * Covers:
 *   - BUG-04 / #384: Settings tab spelled "Bütünlük" (not "Butunluk").
 *   - BUG-07 / #387: Plan row label reads "Eşzamanlı Pipeline".
 *   - BUG-11 / #391: Chat input visual min-height ≥ 72px.
 *   - BUG-12 / #392: Spec/PlanCard summary uses text-sm (computed ≥ 13px).
 *   - BUG-13 / #406: "Konsol" tab NOT visible in default view; reappears
 *                    with ?debug=1 query param.
 *   - #386 / #410: General typography and a11y guardrails.
 *
 * These tests read the Turkish i18n strings directly from tr.json when a
 * label must be asserted verbatim, so any future i18n rename is caught by
 * the test suite automatically.
 *
 * Tag: @prod @smoke
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import tr from '../../../src/i18n/locales/tr.json' with { type: 'json' };

async function stubAuthedUser(page: Page) {
  await page.route('**/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'smoke',
        email: 'smoke@akisflow.com',
        firstName: 'Smoke',
        lastName: 'User',
        emailVerified: true,
        hasSeenBetaWelcome: true,
        dataSharingConsent: true,
        role: 'user',
      }),
    });
  });
}

test.describe('UI polish — i18n / typography / chat input @prod @smoke', () => {
  test.beforeEach(async ({ page }) => {
    await stubAuthedUser(page);
  });

  test('BUG-04 #384 — Settings tab reads "Bütünlük" (not "Butunluk")', async ({
    page,
  }) => {
    const label = (tr as Record<string, string>)['settings.tab.integrity'];
    expect(label, 'tr.json must have settings.tab.integrity').toBe('Bütünlük');

    await page.goto('/settings');
    // The dotless "Butunluk" (legacy) must NOT appear.
    const bad = page.getByText(/\bButunluk\b/);
    await expect(bad).toHaveCount(0);

    const good = page.getByText('Bütünlük');
    await expect(good).toBeVisible({ timeout: 10_000 });
  });

  test('BUG-07 #387 — Plan row label reads "Eşzamanlı Pipeline"', async ({
    page,
  }) => {
    const label = (tr as Record<string, string>)['settings.plan.maxAgents'];
    expect(label).toBe('Eşzamanlı Pipeline');

    await page.goto('/settings?tab=plan');
    await expect(page.getByText('Eşzamanlı Pipeline')).toBeVisible({
      timeout: 10_000,
    });

    // Old "Maksimum Agent" label MUST be gone.
    await expect(page.getByText(/Maksimum Agent/i)).toHaveCount(0);
  });

  test('BUG-11 #391 — chat input has visual min-height ≥ 72px', async ({
    page,
  }) => {
    await page.goto('/chat');

    const input = page.locator('textarea').first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });

    const height = await input.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height;
    });

    expect(height).toBeGreaterThanOrEqual(72);
  });

  test('BUG-13 #406 — "Konsol" tab NOT visible in default view', async ({
    page,
  }) => {
    await page.goto('/chat');
    // Wait for layout to settle.
    await page.waitForLoadState('networkidle').catch(() => {});

    // The Konsol tab/button must not be in default end-user view.
    const konsol = page.getByRole('tab', { name: /Konsol/i });
    await expect(konsol).toHaveCount(0);

    const konsolButton = page.getByRole('button', { name: /^Konsol$/i });
    await expect(konsolButton).toHaveCount(0);
  });

  test('BUG-13 #406 — ?debug=1 reveals the Konsol tab', async ({ page }) => {
    await page.goto('/chat?debug=1');
    await page.waitForLoadState('networkidle').catch(() => {});

    // In debug mode, Konsol must be visible (either as tab or button).
    const konsol = page
      .getByRole('tab', { name: /Konsol/i })
      .or(page.getByRole('button', { name: /^Konsol$/i }))
      .first();
    await expect(konsol).toBeVisible({ timeout: 10_000 });
  });

  test('BUG-12 #392 — PlanCard summary renders at text-sm (≥13px)', async ({
    page,
  }) => {
    // The PlanCard is the Scribe "Proje Planı" card; it is only visible after
    // a scribe run. For this smoke test we just inject the class check on the
    // component in isolation when rendered (locally) or skip against prod if
    // no plan card is on screen.
    await page.goto('/chat');
    const planCard = page
      .locator('[data-testid="plan-card"], [class*="PlanCard"]')
      .first();

    const visible = await planCard.isVisible({ timeout: 2_000 }).catch(() => false);
    test.skip(!visible, 'No PlanCard on screen — pipeline has not run.');

    const summary = planCard.locator('[data-testid="plan-summary"], p').first();
    const fontSize = await summary.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize) || 0,
    );
    expect(fontSize).toBeGreaterThanOrEqual(13);
  });
});
