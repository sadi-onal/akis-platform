/**
 * Shared shell mocks for /chat E2E specs (FR-10 + FR-11).
 *
 * Centralises the auth + ancillary endpoints every chat spec needs: /auth/me,
 * GitHub status, AI-keys status, conversations, pipelines list. Each spec adds
 * its own classifier / chat-qa / pipelines-POST routes on top.
 *
 * Lives next to `mock-dashboard-apis.ts` and follows the same pattern: thin
 * helpers that take a Page + a per-test state bag so assertions can read what
 * fired.
 */
import type { Page, Route } from '@playwright/test';

/** Stable e2e identity — auth surface is mocked so a fixed string is fine. */
export const TEST_USER_ID = 'e2e-chat-user';
export const TEST_EMAIL = 'chat-e2e@test.akis.dev';

/** Minimal shape every chat spec extends with its own counters / captures. */
export interface BasePipelineState {
  /** Set to `true` after a POST /api/pipelines hits the shell handler. */
  buildCreated: boolean;
}

/**
 * Mock /auth/me as an active, email-verified user named per the caller.
 */
export async function mockAuth(page: Page, name = 'Chat Tester') {
  await page.route('**/auth/me', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TEST_USER_ID,
        name,
        email: TEST_EMAIL,
        status: 'active',
        emailVerified: true,
      }),
    }),
  );
}

/**
 * GitHub already connected — keeps the JIT gate out of the way so we can
 * reach the classifier path without an OAuth detour.
 */
export async function mockGitHubConnected(page: Page) {
  await page.route('**/api/integrations/github/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connected: true,
        login: 'chat-tester',
        avatarUrl: null,
        scope: 'read:user user:email repo',
      }),
    }),
  );
}

export async function mockAiKeysMock(page: Page) {
  await page.route('**/api/settings/ai-keys/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ activeProvider: 'mock' }),
    }),
  );
}

export async function mockEmptyConversations(page: Page) {
  await page.route('**/api/conversations**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversations: [], total: 0 }),
    }),
  );
}

export async function mockEmptyPipelinesList(page: Page) {
  await page.route('**/api/pipelines?**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipelines: [], total: 0 }),
    }),
  );
}

/**
 * POST /api/pipelines — BUILD-path indicator. Flags `state.buildCreated = true`
 * and returns a minimal workflow object so the page can transition without
 * errors. Non-POST falls through to the next handler (so the list mock can
 * still respond to `?` queries).
 */
export async function mockBuildPipelineCreate<T extends BasePipelineState>(
  page: Page,
  state: T,
) {
  await page.route('**/api/pipelines', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.buildCreated = true;
    await route.fulfill({
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
}

/**
 * Compose all the standard shell mocks. Caller still registers /api/chat/intent
 * and /api/chat-qa/ask routes — those vary per spec.
 *
 * NOTE: Playwright dispatches `page.route` handlers LIFO. The POST /api/pipelines
 * handler must be registered AFTER the GET-list handler so the GET handler is
 * checked first (`route.fallback()` then forwards to it for the POST handler's
 * non-POST branch).
 */
export async function mockChatShellBase<T extends BasePipelineState>(
  page: Page,
  state: T,
  opts: { userName?: string } = {},
) {
  await mockAuth(page, opts.userName ?? 'Chat Tester');
  await mockGitHubConnected(page);
  await mockAiKeysMock(page);
  await mockEmptyConversations(page);
  await mockEmptyPipelinesList(page);
  await mockBuildPipelineCreate(page, state);
}

/**
 * Reach /chat with the input rendered. The EmptyState's "Yeni Sohbet" CTA is
 * the same affordance bakkal users see; we skip `networkidle` because /chat
 * has long-poll/SSE behaviours that make it flaky — the input visibility wait
 * is the deterministic gate.
 */
export async function openChatInput(page: Page) {
  await page.goto('/chat');
  await page
    .getByRole('button', { name: /Start New Chat|Yeni Sohbet Başlat|Yeni Sohbet/i })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mesaj yaz' });
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  return input;
}
