/**
 * Login Happy-Path E2E (mocked backend)
 *
 * Walks through the 2-step login flow:
 *   /login → /login/password → /dashboard
 *
 * Backend calls mocked via Playwright route interception.
 *
 * Run: pnpm -C frontend exec playwright test auth-login-flow
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const TEST_USER_ID = 'e2e-login-user-' + Date.now();

function uniqueEmail(): string {
  return `e2e+login+${Date.now()}@test.akis.dev`;
}

/** Set up route mocks for the login flow */
async function mockLoginApi(page: Page, email: string) {
  // POST /auth/login/start → return userId + email
  await page.route('**/auth/login/start', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ userId: TEST_USER_ID, email }),
    });
  });

  // POST /auth/login/complete → return user + token
  await page.route('**/auth/login/complete', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: TEST_USER_ID,
          email,
          firstName: 'E2E',
          lastName: 'LoginUser',
          emailVerified: true,
          role: 'user',
        },
        token: 'e2e-mock-jwt-token',
      }),
    });
  });

  // GET /auth/me → authenticated user
  await page.route('**/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TEST_USER_ID,
        email,
        firstName: 'E2E',
        lastName: 'LoginUser',
        emailVerified: true,
        role: 'user',
      }),
    });
  });

  // Mock dashboard data endpoints to prevent 404s after login
  await page.route('**/api/agents/jobs**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });
}

test.describe('Login happy path', () => {
  test('Step 1: /login accepts email and navigates to /login/password', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await mockLoginApi(page, email);

    await page.goto('/login');

    // Fill email
    await page.locator('#email').fill(email);

    // Submit
    await page.locator('form').getByRole('button', { name: /continue|sign in/i }).click();

    // Should navigate to password step
    await page.waitForURL('**/login/password', { timeout: 10_000 });
    expect(page.url()).toContain('/login/password');
  });

  test('Step 2: /login/password accepts password and navigates to /dashboard', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await mockLoginApi(page, email);

    // Pre-seed sessionStorage (normally set by step 1)
    await page.goto('/login');
    await page.evaluate(
      ([uid, em]) => {
        sessionStorage.setItem(
          'akis_login_data',
          JSON.stringify({ userId: uid, email: em }),
        );
      },
      [TEST_USER_ID, email],
    );

    await page.goto('/login/password');

    // Password page should show password input
    const passwordInput = page.locator('#password, input[type="password"]').first();
    await expect(passwordInput).toBeVisible({ timeout: 5_000 });
    await passwordInput.fill('SecureP@ss123!');

    // Submit
    await page.locator('form').getByRole('button', { name: /sign in|continue|log in/i }).click();

    // Should navigate to dashboard
    await page.waitForURL('**/dashboard**', { timeout: 15_000 });
    expect(page.url()).toContain('/dashboard');
  });

  test('Full flow: /login → /login/password → /dashboard (end-to-end)', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await mockLoginApi(page, email);

    // Step 1: Email
    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('form').getByRole('button', { name: /continue|sign in/i }).click();
    await page.waitForURL('**/login/password', { timeout: 10_000 });

    // Step 2: Password
    const passwordInput = page.locator('#password, input[type="password"]').first();
    await expect(passwordInput).toBeVisible({ timeout: 5_000 });
    await passwordInput.fill('SecureP@ss123!');
    await page.locator('form').getByRole('button', { name: /sign in|continue|log in/i }).click();

    // Should land on dashboard
    await page.waitForURL('**/dashboard**', { timeout: 15_000 });
    expect(page.url()).toContain('/dashboard');
  });

  test('/login page has OAuth buttons and sign-up link', async ({ page }) => {
    await page.goto('/login');

    // OAuth buttons should be present
    const googleBtn = page.getByRole('button', { name: /google/i });
    const githubBtn = page.getByRole('button', { name: /github/i });

    await expect(googleBtn).toBeVisible();
    await expect(githubBtn).toBeVisible();

    // Sign-up link
    const signupLink = page.getByRole('link', { name: /create|sign up/i });
    await expect(signupLink).toBeVisible();
    await expect(signupLink).toHaveAttribute('href', '/signup');
  });
});
