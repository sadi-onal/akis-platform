/**
 * Intent disambiguation modal E2E (FR-11 / 02-ux § 5.9).
 *
 * Verifies the ChatRouter routes high-confidence sends directly and surfaces
 * the DisambiguationModal for low-confidence sends. The classifier endpoint
 * (POST /api/chat/intent) is mocked deterministically so we control the
 * confidence value without touching the AI provider.
 *
 * Anchors:
 *   - docs/product/02-ux.md storyboard 1.5 (disambiguation)
 *   - docs/product/04-quality.md § 2 FR-11 e2e row
 *   - frontend/src/components/chat/{ChatRouter,DisambiguationModal}.tsx
 *
 * Run: pnpm -C frontend exec playwright test intent-disambiguation
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const TEST_USER_ID = 'e2e-intent-' + Date.now();
const TEST_EMAIL = `intent+${Date.now()}@test.akis.dev`;

interface IntentMockState {
  /** Drives the next /api/chat/intent response. */
  next: {
    intent: 'BUILD' | 'ASK' | 'FEEDBACK' | 'CHAT';
    confidence: number;
    classificationId?: string;
  };
  /** Captured request bodies — for assertion. */
  classifyCalls: Array<{ message: string }>;
  /** Captured override calls (PATCH /api/chat/intent/:id). */
  overrideCalls: Array<{ id: string; intent: string }>;
  /** Whether /api/pipelines POST has been hit (BUILD path indicator). */
  buildCreated: boolean;
  /** Whether /api/chat-qa/ask has been hit (ASK path indicator). */
  askCalled: boolean;
}

/** Set up the auth + chat shell mocks shared by every test. */
async function mockChatShell(page: Page, state: IntentMockState) {
  await page.route('**/auth/me', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TEST_USER_ID,
        name: 'Intent Tester',
        email: TEST_EMAIL,
        status: 'active',
        emailVerified: true,
      }),
    }),
  );

  // GitHub already connected — keeps the JIT gate out of the way so we can
  // reach the classifier path without a connect-OAuth detour.
  await page.route('**/api/integrations/github/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connected: true,
        login: 'intent-tester',
        avatarUrl: null,
        scope: 'read:user user:email repo',
      }),
    }),
  );

  await page.route('**/api/settings/ai-keys/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ activeProvider: 'mock' }),
    }),
  );

  await page.route('**/api/conversations**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversations: [], total: 0 }),
    }),
  );

  await page.route('**/api/pipelines?**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipelines: [], total: 0 }),
    }),
  );

  // POST /api/pipelines — BUILD path indicator. Returns a minimal workflow.
  await page.route('**/api/pipelines', (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    state.buildCreated = true;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'wf-' + Date.now(),
        title: 'mocked',
        currentStage: 'scribe_generating',
        conversation: [],
        stages: {},
      }),
    });
  });

  // The classifier endpoint — drives the modal vs direct-route decision.
  await page.route('**/api/chat/intent', async (route: Route) => {
    const method = route.request().method();
    if (method === 'POST') {
      try {
        const body = JSON.parse(route.request().postData() ?? '{}') as { message?: string };
        state.classifyCalls.push({ message: body.message ?? '' });
      } catch {
        /* ignore parse errors */
      }
      const next = state.next;
      const id = next.classificationId ?? `cls-${Date.now()}`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intent: next.intent,
          confidence: next.confidence,
          reasoning: 'mocked classifier',
          alternates: [],
          classificationId: id,
          threshold: 0.7,
        }),
      });
      return;
    }
    await route.continue();
  });

  // PATCH /api/chat/intent/:id — override telemetry. We capture but ignore.
  await page.route('**/api/chat/intent/*', async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const url = route.request().url();
    const id = decodeURIComponent(url.split('/').pop() ?? '');
    let intent = '';
    try {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        overrideIntent?: string;
      };
      intent = body.overrideIntent ?? '';
    } catch {
      /* ignore */
    }
    state.overrideCalls.push({ id, intent });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // ASK path indicator — chat-qa SSE. We don't need a real stream here; the
  // immediate `done` event lets the page resolve without spinning forever.
  await page.route('**/api/chat-qa/ask', async (route: Route) => {
    state.askCalled = true;
    const sse =
      'event: done\n' +
      'data: {"answer":"mock answer","citations":[],"needsBuild":false}\n\n';
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: sse,
    });
  });
}

function freshState(
  intent: IntentMockState['next']['intent'],
  confidence: number,
): IntentMockState {
  return {
    next: { intent, confidence, classificationId: 'cls-fixed' },
    classifyCalls: [],
    overrideCalls: [],
    buildCreated: false,
    askCalled: false,
  };
}

/**
 * Reach /chat with a pending conversation so ChatInput is rendered. The
 * EmptyState's "Yeni Sohbet" CTA is the same affordance bakkal users see.
 */
async function openChatInput(page: Page) {
  await page.goto('/chat');
  await page.waitForLoadState('networkidle');
  await page
    .getByRole('button', { name: /Start New Chat|Yeni Sohbet Başlat|Yeni Sohbet/i })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mesaj yaz' });
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  return input;
}

test.describe('Intent disambiguation flow (FR-11)', () => {
  test('high-confidence BUILD routes directly without showing the modal', async ({
    page,
  }) => {
    const state = freshState('BUILD', 0.95);
    await mockChatShell(page, state);

    const input = await openChatInput(page);
    await input.fill('Bakkal stoğu uygulaması yap');
    await input.press('Enter');

    // No modal should ever appear for high-confidence BUILD.
    await expect(page.getByTestId('intent-disambiguation-modal')).toHaveCount(0);

    // The BUILD path was taken — POST /api/pipelines fired.
    await expect.poll(() => state.buildCreated, { timeout: 10_000 }).toBe(true);
    expect(state.askCalled).toBe(false);
    expect(state.classifyCalls.length).toBeGreaterThanOrEqual(1);
    expect(state.classifyCalls[0]?.message).toContain('Bakkal');
  });

  test('low-confidence prompt opens the disambiguation modal with all four options', async ({
    page,
  }) => {
    const state = freshState('BUILD', 0.4);
    await mockChatShell(page, state);

    const input = await openChatInput(page);
    await input.fill('rapor');
    await input.press('Enter');

    const modal = page.getByTestId('intent-disambiguation-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // The user message is quoted in the modal body.
    await expect(modal).toContainText('rapor');

    // All three primary options + Vazgeç render.
    await expect(page.getByTestId('intent-option-BUILD')).toBeVisible();
    await expect(page.getByTestId('intent-option-ASK')).toBeVisible();
    await expect(page.getByTestId('intent-option-FEEDBACK')).toBeVisible();
    await expect(page.getByTestId('intent-option-cancel')).toBeVisible();

    // Bakkal-language labels (NFR-5.1). Use exact matches for words like
    // "Soru" that would otherwise greedily match strings like "sorun".
    await expect(page.getByText('Yeni özellik', { exact: true })).toBeVisible();
    await expect(page.getByText('Soru', { exact: true })).toBeVisible();
    await expect(page.getByText('Geribildirim', { exact: true })).toBeVisible();
    await expect(page.getByText('Vazgeç', { exact: true })).toBeVisible();

    // Handlers must NOT have fired yet — we're awaiting the user's pick.
    expect(state.buildCreated).toBe(false);
    expect(state.askCalled).toBe(false);
  });

  test('selecting "Soru" routes the message into the ASK (chat-qa) handler', async ({
    page,
  }) => {
    const state = freshState('BUILD', 0.45);
    await mockChatShell(page, state);

    const input = await openChatInput(page);
    await input.fill('rapor');
    await input.press('Enter');

    await expect(page.getByTestId('intent-disambiguation-modal')).toBeVisible({
      timeout: 5_000,
    });

    await page.getByTestId('intent-option-ASK').click();

    // Modal closes after selection.
    await expect(page.getByTestId('intent-disambiguation-modal')).toHaveCount(0);

    // Override telemetry was sent with the user's pick.
    await expect
      .poll(() => state.overrideCalls.length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
    expect(state.overrideCalls[0]?.intent).toBe('ASK');

    // The ASK path was taken — chat-qa SSE was fetched.
    await expect.poll(() => state.askCalled, { timeout: 10_000 }).toBe(true);
    // Critical: the BUILD path must NOT have been triggered as a side-effect.
    expect(state.buildCreated).toBe(false);
  });

  test('Vazgeç dismisses the modal without invoking any handler', async ({ page }) => {
    const state = freshState('BUILD', 0.45);
    await mockChatShell(page, state);

    const input = await openChatInput(page);
    await input.fill('rapor');
    await input.press('Enter');

    await expect(page.getByTestId('intent-disambiguation-modal')).toBeVisible({
      timeout: 5_000,
    });

    await page.getByTestId('intent-option-cancel').click();

    await expect(page.getByTestId('intent-disambiguation-modal')).toHaveCount(0);
    // No handler ran. No override PATCH was sent.
    expect(state.buildCreated).toBe(false);
    expect(state.askCalled).toBe(false);
    expect(state.overrideCalls).toHaveLength(0);
  });
});
