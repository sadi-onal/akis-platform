/**
 * GitHub JIT-gate flow (mocked backend)
 *
 * Verifies the bakkal flow: signup-equivalent state → /chat → type idea →
 * inline gate appears → connect → return from OAuth → auto-resume.
 *
 * Run: pnpm -C frontend exec playwright test github-oauth-gate
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const TEST_USER_ID = 'e2e-jit-gate-' + Date.now();
const TEST_EMAIL = `jit+${Date.now()}@test.akis.dev`;
const TEST_IDEA =
  'dükkanım için günlük stok takibi yapan basit bir uygulama istiyorum';

type GhStatus = 'disconnected' | 'connected';

async function mockChatApis(page: Page, ghStatusRef: { value: GhStatus }) {
  // Authenticated user
  await page.route('**/auth/me', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TEST_USER_ID,
        name: 'Bakkal Tester',
        email: TEST_EMAIL,
        status: 'active',
        emailVerified: true,
      }),
    }),
  );

  // GitHub status — flips based on the ref so we can simulate connect
  await page.route('**/api/integrations/github/status', (route: Route) => {
    if (ghStatusRef.value === 'connected') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connected: true,
          login: 'bakkal-test',
          avatarUrl: null,
          scope: 'read:user user:email repo',
        }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: false }),
      });
    }
  });

  // AI keys status — always configured so the gate is the only blocker
  await page.route('**/api/settings/ai-keys/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ activeProvider: 'mock' }),
    }),
  );

  // Conversations list — empty so the page lands on EmptyState
  await page.route('**/api/conversations**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversations: [], total: 0 }),
    }),
  );

  // Pipelines list (sidebar) — empty
  await page.route('**/api/pipelines?**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipelines: [], total: 0 }),
    }),
  );

  // OAuth start: simulate the dev-mode bypass — flip the ref and redirect
  // back to /chat?github=connected as the real backend would.
  await page.route('**/api/integrations/github/oauth/start', (route: Route) => {
    ghStatusRef.value = 'connected';
    route.fulfill({
      status: 302,
      headers: { Location: '/chat?github=connected' },
      body: '',
    });
  });

  // Pipeline create — return a minimal workflow object so the page transitions.
  await page.route('**/api/pipelines', (route: Route) => {
    if (route.request().method() !== 'POST') {
      return route.continue();
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'wf-' + Date.now(),
        title: 'stok takibi',
        currentStage: 'scribe_generating',
        conversation: [],
        stages: {},
      }),
    });
  });
}

async function loginViaSession(page: Page) {
  // Land on /chat directly; auth/me mock authenticates us.
  await page.goto('/chat');
  await page.waitForLoadState('networkidle');
}

test.describe('GitHub JIT-gate flow', () => {
  test('typing an idea without GitHub surfaces the inline gate, not a modal on first load', async ({
    page,
  }) => {
    const ghRef = { value: 'disconnected' as GhStatus };
    await mockChatApis(page, ghRef);
    await loginViaSession(page);

    // Critical regression check: the old upfront modal must NOT appear on /chat
    // load. The gate should only be visible after the user attempts to send.
    await expect(page.getByTestId('github-connect-gate')).toHaveCount(0);

    // Type the idea and submit — the EmptyState/ChatInput should accept it.
    // EmptyState shows a "Start New Chat" CTA — click it to instantiate the
    // pending conversation so ChatInput renders.
    await page
      .getByRole('button', { name: /Start New Chat|Yeni Sohbet Başlat|Yeni Sohbet/i })
      .first()
      .click();

    const input = page.getByRole('textbox', { name: 'Mesaj yaz' });
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill(TEST_IDEA);
    // Press Enter to submit (ChatInput supports Enter-to-send).
    await input.press('Enter');

    // Gate should appear with the idea quoted.
    const gate = page.getByTestId('github-connect-gate');
    await expect(gate).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('github-connect-gate-pending-idea')).toContainText(
      'stok takibi',
    );

    // Permission bullets visible.
    await expect(page.getByText('Senin için yeni bir depo açar')).toBeVisible();
    await expect(page.getByText('Mevcut depolarına dokunmaz')).toBeVisible();
  });

  test('connect button stores idea, follows OAuth redirect, and auto-resumes after return', async ({
    page,
  }) => {
    const ghRef = { value: 'disconnected' as GhStatus };
    await mockChatApis(page, ghRef);
    await loginViaSession(page);

    await page
      .getByRole('button', { name: /Start New Chat|Yeni Sohbet Başlat|Yeni Sohbet/i })
      .first()
      .click();
    const input = page.getByRole('textbox', { name: 'Mesaj yaz' });
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill(TEST_IDEA);
    await input.press('Enter');

    await expect(page.getByTestId('github-connect-gate')).toBeVisible({
      timeout: 5_000,
    });

    // Click the connect button. Mocked OAuth start flips ghRef and 302s to
    // /chat?github=connected; the auto-resume effect fires after the status
    // refetch sees connected=true.
    await page.getByTestId('github-connect-gate-connect').click();

    // After redirect, URL params should be cleaned and the gate should be gone.
    await page.waitForFunction(
      () => !window.location.search.includes('github=connected'),
      { timeout: 10_000 },
    );
    await expect(page.getByTestId('github-connect-gate')).toHaveCount(0);

    // Success toast surfaces.
    await expect(page.getByText('GitHub bağlandı. Pipeline başlatılıyor…')).toBeVisible({
      timeout: 5_000,
    });

    // The session-storage flag is cleared (idempotency).
    const flag = await page.evaluate(() =>
      sessionStorage.getItem('akis-oauth-just-completed'),
    );
    expect(flag).toBeNull();
  });

  test('cancel dismisses the gate without storing the idea', async ({ page }) => {
    const ghRef = { value: 'disconnected' as GhStatus };
    await mockChatApis(page, ghRef);
    await loginViaSession(page);

    await page
      .getByRole('button', { name: /Start New Chat|Yeni Sohbet Başlat|Yeni Sohbet/i })
      .first()
      .click();
    const input = page.getByRole('textbox', { name: 'Mesaj yaz' });
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill(TEST_IDEA);
    await input.press('Enter');

    await expect(page.getByTestId('github-connect-gate')).toBeVisible({
      timeout: 5_000,
    });

    await page.getByTestId('github-connect-gate-cancel').click();
    await expect(page.getByTestId('github-connect-gate')).toHaveCount(0);

    const stored = await page.evaluate(() =>
      sessionStorage.getItem('akis-pending-idea'),
    );
    expect(stored).toBeNull();
  });
});
