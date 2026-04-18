/**
 * Prod smoke — BUG-15 / PR #395: Engineer mode intro modal.
 *
 * First-time /engineer visitors should see an intro modal explaining what
 * engineer mode is. Clicking "Başla" dismisses it and persists a flag to
 * localStorage so it never reappears.
 *
 * We drive the flow twice:
 *   1. fresh localStorage → modal must appear → click "Başla" → dismissed
 *   2. reload page → modal must NOT reappear
 *
 * Skipped gracefully if /engineer requires auth and no creds are supplied.
 *
 * Tag: @prod @smoke
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const HAS_CREDS =
  !!process.env.TEST_USER_EMAIL && !!process.env.TEST_USER_PASSWORD;

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

  await page.route('**/api/github/status', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connected: true, login: 'OmerYasirOnal' }),
    });
  });
}

test.describe('BUG-15 / #395 — Engineer intro modal @prod @smoke', () => {
  test.skip(
    !HAS_CREDS && !process.env.PLAYWRIGHT_BASE_URL?.startsWith('http://127.0.0.1'),
    'Engineer page needs auth; supply TEST_USER_* or run against local dev',
  );

  test('first visit shows modal; "Başla" dismisses; reload does not re-show', async ({
    page,
  }) => {
    await stubAuthedUser(page);

    // Clear relevant localStorage keys before the first visit.
    await page.addInitScript(() => {
      // Any key variant the component might use — prune to be safe.
      [
        'engineer.intro.seen',
        'engineerIntroSeen',
        'akis:engineer:intro-seen',
      ].forEach((k) => localStorage.removeItem(k));
    });

    await page.goto('/engineer');

    // Modal appears — heading, role=dialog, or a "Başla" CTA button.
    const modal = page
      .getByRole('dialog')
      .or(page.locator('[data-testid="engineer-intro-modal"]'))
      .first();
    await expect(modal).toBeVisible({ timeout: 10_000 });

    const startBtn = page.getByRole('button', { name: /^Başla$/i }).first();
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    // Modal dismisses.
    await expect(modal).toBeHidden({ timeout: 5_000 });

    // Reload — modal MUST NOT reappear (persistence via localStorage).
    await page.reload();
    const modalAfterReload = page
      .getByRole('dialog')
      .or(page.locator('[data-testid="engineer-intro-modal"]'))
      .first();
    await expect(modalAfterReload).toBeHidden({ timeout: 5_000 });
  });
});
