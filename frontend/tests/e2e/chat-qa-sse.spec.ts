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
import {
  mockChatShellBase,
  openChatInput,
  type BasePipelineState,
} from './helpers/mock-chat-shell';

interface ChatQaState extends BasePipelineState {
  /** Drives the next /api/chat-qa/ask response payload. */
  next: {
    chunks: string[];
    answer: string;
    citations: Array<{ source: string; excerpt: string; refKey?: string }>;
    needsBuild: boolean;
  };
  /** Capture for assertions. */
  askCalls: Array<{ message: string }>;
}

async function mockChatShell(page: Page, state: ChatQaState) {
  await mockChatShellBase(page, state, { userName: 'ChatQA Tester' });

  // Classifier — pin to high-confidence ASK so the router dispatches to the
  // chat-qa handler without surfacing the disambiguation modal.
  await page.route('**/api/chat/intent', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
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

  test('navigating away mid-stream aborts the in-flight chat-qa request', async ({
    page,
  }) => {
    // Strategy: prove ChatPage's `useEffect cleanup → askAbortRef.current.abort()`
    // contract by holding a chat-qa SSE response open and then unmounting the
    // ChatPage via React Router (NOT a hard `goto`, which would destroy the
    // document before React cleanup runs). The probe in `chatQa.ts` bumps
    // `window.__chatQaAbortCount` when its onAbort handler fires; we read it
    // after the navigation lands.
    //
    // Mocking an infinite SSE stream is tricky: Playwright's `route.fulfill`
    // delivers a finite body in one go, so the FE iterator naturally finishes
    // before any abort can land. To get a genuine never-closing stream we
    // patch `window.fetch` for the chat-qa endpoint and return a Response
    // wrapping a `ReadableStream` we keep open until teardown. Everything
    // else (auth, classifier, etc.) keeps the standard `page.route` shape.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __chatQaAbortCount: number;
        __chatQaAskHits: number;
        __chatQaReleaseFirst?: () => void;
      };
      w.__chatQaAbortCount = 0;
      w.__chatQaAskHits = 0;

      const realFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (!url.includes('/api/chat-qa/ask')) {
          return realFetch(input, init);
        }
        w.__chatQaAskHits += 1;
        // Return a Response with a ReadableStream body. Emit a single chunk
        // so the FE renders the bubble, then park — the only way to end is
        // if reader.cancel() is called from chatQa.ts's onAbort handler.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode(
                'event: chunk\ndata: {"text":"yükleniyor "}\n\n: heartbeat\n\n',
              ),
            );
            w.__chatQaReleaseFirst = () => {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            };
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          }),
        );
      }) as typeof window.fetch;
    });

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Baseline shell + classifier (page.route-based; chat-qa is replaced
    // by our fetch override above so the shell's chat-qa route never
    // matches — that's fine).
    const shellState = freshState();
    await mockChatShell(page, shellState);

    const input = await openChatInput(page);
    await input.fill('Stok eklemek istiyorum');
    await input.press('Enter');

    // The response bubble appears once the first chunk lands.
    await expect(page.getByTestId('chat-qa-response')).toBeVisible({ timeout: 10_000 });

    // Confirm one ask fetch fired (sanity — our fetch override saw it).
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __chatQaAskHits?: number }).__chatQaAskHits ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // Navigate via React Router (history.pushState + popstate). This unmounts
    // ChatPage → useEffect cleanup → `askAbortRef.current?.abort()` →
    // chatQa.ts's `onAbort` runs → `window.__chatQaAbortCount` bumps. A hard
    // `page.goto('/')` would tear the document down before React's cleanup
    // runs, so we stay in-document.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // Poll the probe — abort handler should have fired exactly once.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __chatQaAbortCount?: number }).__chatQaAbortCount ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // Filter out abort-flavoured noise — those are the legitimate FE cleanup.
    // Anything else indicates an orphan-stream / unhandled-rejection regression.
    const unexpected = consoleErrors.filter(
      (e) => !/abort/i.test(e) && !/AbortError/i.test(e),
    );
    expect(unexpected, `unexpected console errors:\n${unexpected.join('\n')}`).toEqual([]);

    // Release the held response so the test tears down cleanly.
    await page.evaluate(() => {
      (window as unknown as { __chatQaReleaseFirst?: () => void }).__chatQaReleaseFirst?.();
    });
  });
});
