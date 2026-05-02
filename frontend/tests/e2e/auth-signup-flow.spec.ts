/**
 * Signup Happy-Path E2E (mocked backend)
 *
 * Walks through the 3-step signup flow:
 *   /signup → /signup/password → /signup/verify-email → /chat
 *
 * (The /auth/welcome-beta and /auth/privacy-consent intermediate pages were
 * removed in the auth-cleanup PR; verify-email now navigates straight to chat.)
 *
 * All backend API calls are mocked via Playwright route interception so the
 * test runs without a live backend. Each run uses a unique email via timestamp.
 *
 * Run: pnpm -C frontend exec playwright test auth-signup-flow
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const TEST_USER_ID = 'e2e-test-user-' + Date.now();

function uniqueEmail(): string {
  return `e2e+${Date.now()}@test.akis.dev`;
}

/** Set up route mocks for the entire signup flow */
async function mockSignupApi(page: Page, email: string) {
  // POST /auth/signup/start → return userId + email
  await page.route('**/auth/signup/start', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ userId: TEST_USER_ID, email }),
    });
  });

  // POST /auth/signup/password → return success (password step)
  await page.route('**/auth/signup/password', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, message: 'Password set' }),
    });
  });

  // POST /auth/verify-email → success (returns user object)
  await page.route('**/auth/verify-email', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: TEST_USER_ID,
          name: 'E2E Tester',
          email,
          status: 'active',
          emailVerified: true,
        },
        message: 'Email verified successfully',
      }),
    });
  });

  // POST /auth/resend-code → success
  await page.route('**/auth/resend-code', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, message: 'Verification code resent' }),
    });
  });

  // GET /auth/me → authenticated user
  await page.route('**/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TEST_USER_ID,
        name: 'E2E Tester',
        email,
        status: 'active',
        emailVerified: true,
      }),
    });
  });
}

test.describe('Signup happy path', () => {
  test('Step 1: /signup form accepts name + email and navigates to /signup/password', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await mockSignupApi(page, email);

    await page.goto('/signup');

    // Fill the form
    await page.locator('#firstName').fill('E2E');
    await page.locator('#lastName').fill('Tester');
    await page.locator('#email').fill(email);

    // Submit
    await page.locator('form').getByRole('button', { name: /continue|create/i }).click();

    // Should navigate to password step
    await page.waitForURL('**/signup/password', { timeout: 10_000 });
    expect(page.url()).toContain('/signup/password');
  });

  test('Step 2: /signup/password accepts password and navigates to verify-email', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await mockSignupApi(page, email);

    // Pre-seed sessionStorage (normally set by step 1)
    await page.goto('/signup');
    await page.evaluate(
      ([uid, em]) => {
        sessionStorage.setItem(
          'akis_signup_data',
          JSON.stringify({ userId: uid, firstName: 'E2E', lastName: 'Tester', email: em }),
        );
      },
      [TEST_USER_ID, email],
    );

    await page.goto('/signup/password');

    // The password page should show password fields
    const passwordInput = page.locator('#password, input[type="password"]').first();
    await expect(passwordInput).toBeVisible({ timeout: 5_000 });
    await passwordInput.fill('SecureP@ss123!');

    // Fill confirm password if it exists
    const confirmInput = page.locator('#confirmPassword, input[name="confirmPassword"]').first();
    if (await confirmInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirmInput.fill('SecureP@ss123!');
    }

    // Submit
    await page.locator('form').getByRole('button', { name: /create|continue|sign up/i }).click();

    // Should navigate to verify-email
    await page.waitForURL('**/signup/verify-email', { timeout: 10_000 });
    expect(page.url()).toContain('/signup/verify-email');
  });

  test('Step 3: /signup/verify-email renders with email and accepts 6-digit code', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await mockSignupApi(page, email);

    // Pre-seed sessionStorage (normally set by step 1)
    await page.goto('/signup');
    await page.evaluate(
      ([uid, em]) => {
        sessionStorage.setItem(
          'akis_signup_data',
          JSON.stringify({ userId: uid, firstName: 'E2E', lastName: 'Tester', email: em }),
        );
      },
      [TEST_USER_ID, email],
    );

    await page.goto('/signup/verify-email');

    // Page should show heading and email
    await expect(page.getByRole('heading', { name: /verify your email/i })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // Should show 6 code inputs
    const codeInputs = page.locator('input[inputmode="numeric"]');
    await expect(codeInputs).toHaveCount(6);

    // Fill code digit by digit
    for (let i = 0; i < 6; i++) {
      await codeInputs.nth(i).fill(String(i + 1));
    }

    // Submit
    await page.getByRole('button', { name: /verify/i }).click();

    // Should navigate to /chat after successful verification (intermediate
    // welcome-beta and privacy-consent pages were removed)
    await page.waitForURL('**/chat**', { timeout: 10_000 });
  });

  test('Step 3b: wrong verification code shows error', async ({ page }) => {
    const email = uniqueEmail();

    // Override verify-email to return error
    await page.route('**/auth/verify-email', async (route: Route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Invalid or expired verification code',
          code: 'INVALID_CODE',
        }),
      });
    });

    // Mock remaining APIs
    await page.route('**/auth/me', async (route: Route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    // Pre-seed sessionStorage
    await page.goto('/signup');
    await page.evaluate(
      ([uid, em]) => {
        sessionStorage.setItem(
          'akis_signup_data',
          JSON.stringify({ userId: uid, firstName: 'E2E', lastName: 'Tester', email: em }),
        );
      },
      [TEST_USER_ID, email],
    );

    await page.goto('/signup/verify-email');
    await expect(page.getByRole('heading', { name: /verify your email/i })).toBeVisible();

    // Fill wrong code
    const codeInputs = page.locator('input[inputmode="numeric"]');
    for (let i = 0; i < 6; i++) {
      await codeInputs.nth(i).fill('0');
    }

    await page.getByRole('button', { name: /verify/i }).click();

    // Error message should appear
    await expect(page.locator('.text-ak-danger')).toBeVisible({ timeout: 5_000 });

    // Should still be on verify page (not navigated)
    expect(page.url()).toContain('/signup/verify-email');
  });

  test('Step 3c: resend code button works', async ({ page }) => {
    const email = uniqueEmail();
    await mockSignupApi(page, email);

    // Pre-seed sessionStorage
    await page.goto('/signup');
    await page.evaluate(
      ([uid, em]) => {
        sessionStorage.setItem(
          'akis_signup_data',
          JSON.stringify({ userId: uid, firstName: 'E2E', lastName: 'Tester', email: em }),
        );
      },
      [TEST_USER_ID, email],
    );

    // Handle the alert dialog that shows on resend success
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/signup/verify-email');
    await expect(page.getByRole('heading', { name: /verify your email/i })).toBeVisible();

    // Click resend
    const resendBtn = page.getByText(/resend code/i);
    await expect(resendBtn).toBeVisible();
    await resendBtn.click();

    // The button text changes to "Resending..." briefly, then the alert fires
    // After accepting the dialog, page should still be on verify-email
    expect(page.url()).toContain('/signup/verify-email');
  });

  test('Step 3d: resend rate limited shows error', async ({ page }) => {
    const email = uniqueEmail();

    // Mock resend-code as rate limited
    await page.route('**/auth/resend-code', async (route: Route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Too many attempts. Please wait 15 minutes.',
          code: 'RATE_LIMITED',
        }),
      });
    });

    await page.route('**/auth/me', async (route: Route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    // Pre-seed sessionStorage
    await page.goto('/signup');
    await page.evaluate(
      ([uid, em]) => {
        sessionStorage.setItem(
          'akis_signup_data',
          JSON.stringify({ userId: uid, firstName: 'E2E', lastName: 'Tester', email: em }),
        );
      },
      [TEST_USER_ID, email],
    );

    await page.goto('/signup/verify-email');
    await expect(page.getByRole('heading', { name: /verify your email/i })).toBeVisible();

    // Click resend — should show error
    const resendBtn = page.getByText(/resend code/i);
    await resendBtn.click();

    // Error message about rate limit should appear
    await expect(page.locator('.text-ak-danger')).toBeVisible({ timeout: 5_000 });
  });

});
