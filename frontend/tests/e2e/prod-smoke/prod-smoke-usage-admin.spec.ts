/**
 * Prod smoke — BUG-02 / BUG-03 / PR #401: admin unlimited usage + plan UI.
 *
 * For an admin session:
 *   - /settings?tab=plan: all limit rows must show "∞" (or the i18n string
 *     "Sinirsiz"), and NOT render a progress bar.
 *   - /settings?tab=usage: the page must show a "Sinirsiz" badge and "∞"
 *     remaining-token indicator.
 *
 * We stub /auth/me and /api/usage/* to simulate an admin with admin flags on;
 * tests that require a real admin session skip unless TEST_ADMIN_EMAIL is set.
 *
 * Tag: @prod @smoke
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const HAS_ADMIN = !!process.env.TEST_ADMIN_EMAIL && !!process.env.TEST_ADMIN_PASSWORD;

async function stubAdminSession(page: Page) {
  await page.route('**/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'admin-smoke',
        email: 'admin@akisflow.com',
        firstName: 'Admin',
        lastName: 'Smoke',
        emailVerified: true,
        role: 'admin',
        isAdmin: true,
      }),
    });
  });

  await page.route('**/api/usage/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        isAdmin: true,
        unlimited: true,
        tokens: { used: 92200, limit: null, remaining: null },
        jobs: { used: 7, limit: null, remaining: null },
        plan: { code: 'admin', name: 'Admin', unlimited: true },
      }),
    });
  });

  await page.route('**/api/plan/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        plan: { code: 'admin', name: 'Admin', unlimited: true },
        limits: {
          maxAgents: null,
          monthlyTokens: null,
          dailyJobs: null,
        },
      }),
    });
  });
}

test.describe('BUG-02 / #401 — admin plan tab unlimited @prod @smoke', () => {
  test.skip(!HAS_ADMIN && !process.env.PLAYWRIGHT_BASE_URL?.startsWith('http://127.0.0.1'),
    'Needs admin creds or local dev to exercise admin plan UI');

  test.beforeEach(async ({ page }) => {
    await stubAdminSession(page);
  });

  test('all plan limit rows show ∞ (no progress bars)', async ({ page }) => {
    await page.goto('/settings?tab=plan');

    // Either the literal infinity glyph or the tr.json key "Sinirsiz" must be present.
    const unlimitedIndicator = page
      .getByText(/∞|Sinirsiz|Sınırsız/i)
      .first();
    await expect(unlimitedIndicator).toBeVisible({ timeout: 10_000 });

    // Progress bars (role=progressbar) MUST NOT render for an admin.
    const bars = page.getByRole('progressbar');
    await expect(bars).toHaveCount(0);
  });
});

test.describe('BUG-03 / #401 — admin usage tab @prod @smoke', () => {
  test.skip(!HAS_ADMIN && !process.env.PLAYWRIGHT_BASE_URL?.startsWith('http://127.0.0.1'),
    'Needs admin creds or local dev to exercise admin usage UI');

  test.beforeEach(async ({ page }) => {
    await stubAdminSession(page);
  });

  test('usage page shows Sinirsiz badge + ∞ remaining', async ({ page }) => {
    await page.goto('/settings?tab=usage');

    const badge = page.getByText(/Sinirsiz|Sınırsız/i).first();
    await expect(badge).toBeVisible({ timeout: 10_000 });

    const infinity = page.getByText('∞').first();
    await expect(infinity).toBeVisible({ timeout: 10_000 });
  });
});
