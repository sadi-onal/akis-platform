/**
 * Prod smoke — BUG-08 / PR #400: iteration prompts continue the same chat.
 *
 * After a pipeline completes, sending a follow-up prompt must NOT open a new
 * chat:
 *   - URL chat id stays the same
 *   - Sidebar has exactly one entry for this chat
 *   - POST goes to /api/pipelines/:id/message (not POST /api/pipelines)
 *
 * We don't run a real pipeline against prod; instead we stub a "completed"
 * chat and drive the follow-up prompt UI. When real creds are supplied the
 * test can be extended to drive an actual iteration — skipped by default.
 *
 * Tag: @prod @smoke
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const CHAT_ID = '63e3d93a-4548-4eda-9cb6-09369f1dcc15';
const HAS_TEST_CREDS =
  !!process.env.TEST_USER_EMAIL && !!process.env.TEST_USER_PASSWORD;

async function stubCompletedChat(page: Page) {
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

  await page.route('**/api/pipelines', async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pipelines: [
            {
              id: CHAT_ID,
              title: 'Basit Todo Uygulaması',
              state: 'completed',
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    } else if (route.request().method() === 'POST') {
      // After PR #400, iteration follow-ups must NOT hit POST /api/pipelines.
      // If we reach here during the follow-up step the test fails below.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-chat-should-not-exist' }),
      });
    } else {
      await route.continue();
    }
  });

  await page.route(`**/api/pipelines/${CHAT_ID}`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: CHAT_ID,
        title: 'Basit Todo Uygulaması',
        state: 'completed',
        messages: [],
      }),
    });
  });
}

test.describe('BUG-08 / #400 — iteration stays in same chat @prod @smoke', () => {
  test.skip(
    !HAS_TEST_CREDS && !process.env.PLAYWRIGHT_BASE_URL?.startsWith('http://127.0.0.1'),
    'Iteration test needs real creds or local dev server',
  );

  test('follow-up prompt posts to /pipelines/:id/message and URL does not change', async ({
    page,
  }) => {
    await stubCompletedChat(page);

    let sawNewPipelinePost = false;
    let sawMessagePost = false;

    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/pipelines$/.test(req.url())) {
        sawNewPipelinePost = true;
      }
      if (
        req.method() === 'POST' &&
        new RegExp(`/api/pipelines/${CHAT_ID}/message`).test(req.url())
      ) {
        sawMessagePost = true;
      }
    });

    await page.route(`**/api/pipelines/${CHAT_ID}/message`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/chat/${CHAT_ID}`);

    const input = page.locator('textarea, [contenteditable="true"]').first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill('bu resimdeki iconları değiştir');
    await input.press('Meta+Enter').catch(() => input.press('Control+Enter'));

    await page.waitForTimeout(2_000);

    expect(sawNewPipelinePost, 'must not create a new pipeline').toBe(false);
    expect(sawMessagePost, 'must post to /pipelines/:id/message').toBe(true);

    // URL chat id must not change.
    expect(page.url()).toContain(CHAT_ID);

    // Sidebar must have exactly one entry for this chat.
    const sidebarEntry = page.getByText('Basit Todo Uygulaması');
    await expect(sidebarEntry).toHaveCount(1);
  });
});
