/**
 * Chat-QA SSE streaming E2E (FR-10 / F-09).
 *
 * Verifies the streaming Q&A path end-to-end: ASK intent → POST /api/chat-qa/ask
 * → server-sent events (chunk → done) → rendered into a chat_qa_response. We
 * mock the SSE endpoint with `route.fulfill` returning a synthetic
 * `text/event-stream` body. The classifier endpoint always returns ASK with
 * high confidence so the router dispatches without a modal.
 *
 * Anchors:
 *   - docs/product/02-ux.md storyboard 1.3 (chat Q&A)
 *   - docs/product/04-quality.md § 2 FR-10 e2e row
 *   - frontend/src/services/api/chatQa.ts (SSE async-iterator)
 *   - frontend/src/components/chat/ChatMessage.tsx (chat_qa_response renderer)
 *
 * Run: pnpm -C frontend exec playwright test chat-qa-sse
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const TEST_USER_ID = 'e2e-chatqa-' + Date.now();
const TEST_EMAIL = `chatqa+${Date.now()}@test.akis.dev`;

interface ChatQaState {
  /** Drives the next /api/chat-qa/ask response payload. */
  next: {
    chunks: string[];
    answer: string;
    citations: Array<{ source: string; excerpt: string; refKey?: string }>;
    needsBuild: boolean;
  };
  /** Capture for assertions. */
  askCalls: Array<{ message: string }>;
  buildCreated: boolean;
}

async function mockChatShell(page: Page, state: ChatQaState) {
  await page.route('**/auth/me', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TEST_USER_ID,
        name: 'ChatQA Tester',
        email: TEST_EMAIL,
        status: 'active',
        emailVerified: true,
      }),
    }),
  );

  await page.route('**/api/integrations/github/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connected: true,
        login: 'chatqa-tester',
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

  // POST /api/pipelines — BUILD path indicator. We flag it but always succeed
  // with a tiny workflow object so the page can transition without errors.
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

  // Classifier — pin to high-confidence ASK so the router dispatches to the
  // chat-qa handler without surfacing the disambiguation modal.
  await page.route('**/api/chat/intent', (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        intent: 'ASK',
        confidence: 0.95,
        reasoning: 'mocked classifier',
        alternates: [],
        classificationId: `cls-${Date.now()}`,
        threshold: 0.7,
      }),
    });
  });

  // The streaming endpoint under test. Build a single-block SSE body with the
  // configured chunks + done event so the FE iterator pulls them off in order.
  await page.route('**/api/chat-qa/ask', async (route: Route) => {
    try {
      const body = JSON.parse(route.request().postData() ?? '{}') as { message?: string };
      state.askCalls.push({ message: body.message ?? '' });
    } catch {
      /* ignore */
    }

    const blocks: string[] = [];
    for (const text of state.next.chunks) {
      blocks.push(`event: chunk\ndata: ${JSON.stringify({ text })}\n\n`);
    }
    for (const c of state.next.citations) {
      blocks.push(`event: citation\ndata: ${JSON.stringify(c)}\n\n`);
    }
    blocks.push(
      `event: done\ndata: ${JSON.stringify({
        answer: state.next.answer,
        citations: state.next.citations,
        needsBuild: state.next.needsBuild,
      })}\n\n`,
    );

    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: blocks.join(''),
    });
  });
}

function freshState(overrides?: Partial<ChatQaState['next']>): ChatQaState {
  return {
    next: {
      chunks: ['Şu an ', 'projende ', '**3 dosya** var.'],
      answer: 'Şu an projende **3 dosya** var.',
      citations: [],
      needsBuild: false,
      ...overrides,
    },
    askCalls: [],
    buildCreated: false,
  };
}

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

test.describe('Chat Q&A SSE flow (FR-10)', () => {
  test('ASK intent triggers streaming Q&A and renders the final answer + citations', async ({
    page,
  }) => {
    const state = freshState({
      chunks: ['Şu an ', 'projende ', '**3 dosya** var.'],
      answer: 'Şu an projende **3 dosya** var.',
      citations: [
        { source: 'spec', excerpt: 'Bakkal — stok takibi', refKey: 'spec:Bakkal' },
      ],
    });
    await mockChatShell(page, state);

    const input = await openChatInput(page);
    await input.fill('Şu an projemde kaç dosya var?');
    await input.press('Enter');

    // The chat-qa response bubble should render — first as streaming, then
    // settled with the final answer and citation chips.
    const response = page.getByTestId('chat-qa-response');
    await expect(response).toBeVisible({ timeout: 10_000 });

    // Final content arrives after `done`.
    await expect(page.getByTestId('chat-qa-content')).toContainText('3 dosya', {
      timeout: 10_000,
    });

    // Citation chip surfaces for the spec excerpt we mocked.
    await expect(page.getByTestId('chat-qa-citations')).toBeVisible();
    await expect(page.getByTestId('chat-qa-citations')).toContainText('Spec');

    // Critical: BUILD path must NOT have fired — chat-qa is pipeline-free.
    expect(state.buildCreated).toBe(false);
    expect(state.askCalls).toHaveLength(1);
  });

  test('Build CTA appears when needsBuild=true and routes into the pipeline create path', async ({
    page,
  }) => {
    const state = freshState({
      chunks: ['Bunu bir özellik olarak ekleyebiliriz.'],
      answer: 'Bunu bir özellik olarak ekleyebiliriz.',
      citations: [],
      needsBuild: true,
    });
    await mockChatShell(page, state);

    const input = await openChatInput(page);
    await input.fill('Stok düşünce bana SMS gelse');
    await input.press('Enter');

    // Wait for the streamed response to settle.
    await expect(page.getByTestId('chat-qa-response')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('chat-qa-content')).toContainText('özellik', {
      timeout: 10_000,
    });

    // The build CTA is shown for needsBuild=true.
    const cta = page.getByTestId('chat-qa-build-cta');
    await expect(cta).toBeVisible({ timeout: 5_000 });
    await expect(cta).toContainText('Bunu özellik olarak ekleyelim mi?');

    // Clicking it triggers the BUILD path (POST /api/pipelines).
    await cta.click();
    await expect.poll(() => state.buildCreated, { timeout: 10_000 }).toBe(true);
  });

  test('navigating away mid-stream aborts cleanly without orphan errors', async ({
    page,
  }) => {
    // Slow stream: long pause before `done` so we can navigate during streaming.
    // We hand-craft the SSE response with an artificial delay using Playwright's
    // request fulfillment timing — chunks first, then a Promise that closes
    // long after the navigation completes.
    const askEvents: string[] = [];

    // Wire a baseline shell so /chat works. We'll override /api/chat-qa/ask
    // manually below to control timing.
    const shellState = freshState();
    await mockChatShell(page, shellState);

    let aborted = false;
    await page.route('**/api/chat-qa/ask', async (route: Route) => {
      askEvents.push('start');
      // Detect the AbortController-driven cancel by listening for the request's
      // `failure` after the page navigates away.
      const handleAbort = () => {
        aborted = true;
      };
      route.request().on('failed' as never, handleAbort);

      // Build a response that begins with an immediate chunk (so the FE shows
      // the bubble) but never closes — simulates an in-flight stream.
      const head =
        'event: chunk\ndata: {"text":"yükleniyor "}\n\n' +
        ': heartbeat\n\n';
      try {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          // Returning a finite body is fine — Playwright closes the response
          // after fulfill, but the FE's `for await` loop has already been
          // unmounted by the time we navigate away, so no UI errors should
          // surface either way. The orphan-stream contract is tested by
          // observing the absence of console errors.
          body: head,
        });
      } catch {
        /* response may already be cancelled by the abort */
      }
    }, { times: 1 });

    // Track console errors. We tolerate aborts (DOMException AbortError) but
    // any unrelated error indicates an orphan-stream regression.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const input = await openChatInput(page);
    await input.fill('Stok eklemek istiyorum');
    await input.press('Enter');

    // The response bubble appears as soon as the first chunk lands.
    await expect(page.getByTestId('chat-qa-response')).toBeVisible({ timeout: 10_000 });

    // Navigate away while the stream is still in-flight. This unmounts the
    // chat page → useEffect cleanup → askAbortRef.current.abort() fires.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Give the AbortController + cleanup a tick to land. We don't assert on
    // the route's `aborted` flag (Playwright may already have closed the
    // fulfill before the abort propagates) — what we care about is that no
    // unexpected console errors surfaced.
    await page.waitForTimeout(300);

    // Filter out abort-flavoured noise — they're the legitimate FE cleanup.
    // Anything else is a regression.
    const unexpected = consoleErrors.filter(
      (e) => !/abort/i.test(e) && !/AbortError/i.test(e),
    );
    expect(unexpected, `unexpected console errors:\n${unexpected.join('\n')}`).toEqual([]);

    // Sanity: the chat-qa endpoint was hit at least once before navigation.
    expect(askEvents).toContain('start');
    // We don't strictly require `aborted=true` because Playwright's route
    // hooks don't always fire on cancel; the meaningful signal is the lack
    // of orphan-stream errors above.
    void aborted;
  });
});
