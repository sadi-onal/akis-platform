/**
 * Auth Deep-Link Routing Guard
 *
 * Verifies that SPA client-side routes under /auth/* are served by the
 * Vite dev-server (or Caddy's try_files in production) as an HTML document,
 * NOT as a backend JSON 404.
 *
 * This is the test that would have caught the original Phase-A routing bug
 * where Caddy forwarded /auth/* to the Fastify backend instead of serving
 * index.html.
 *
 * Run: pnpm -C frontend exec playwright test auth-deep-links
 */
import { test, expect } from '@playwright/test';

test.describe('SPA deep-link routing', () => {
  test('/auth/welcome-beta is a deleted route — must catchall to landing', async ({
    page,
  }) => {
    // The /auth/welcome-beta page was removed in the auth-cleanup PR.
    // The catchall route in App.tsx redirects unknown paths to "/".
    const response = await page.goto('/auth/welcome-beta');
    expect(response).not.toBeNull();
    // Vite/Caddy still serves index.html (SPA fallback) and React handles the redirect.
    expect(response!.status()).toBe(200);
    const ct = response!.headers()['content-type'] ?? '';
    expect(ct).toContain('text/html');
    // After the redirect we should be on the landing page (not on welcome-beta).
    await page.waitForURL((url) => url.pathname === '/', { timeout: 5_000 });
  });

  test('/auth/privacy-consent is a deleted route — must catchall to landing', async ({
    page,
  }) => {
    const response = await page.goto('/auth/privacy-consent');
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    const ct = response!.headers()['content-type'] ?? '';
    expect(ct).toContain('text/html');
    await page.waitForURL((url) => url.pathname === '/', { timeout: 5_000 });
  });

  test('/signup renders React page (email form)', async ({ page }) => {
    const response = await page.goto('/signup');
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);

    const ct = response!.headers()['content-type'] ?? '';
    expect(ct).toContain('text/html');

    // SignupEmail has firstName, lastName, email fields
    await expect(page.locator('#firstName')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
  });

  test('/login renders React page (email form)', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);

    const ct = response!.headers()['content-type'] ?? '';
    expect(ct).toContain('text/html');

    // LoginEmail page has an email input and heading
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
