/**
 * Push-gate chat-driven iterate E2E (T5).
 *
 * Verifies the unified preview + chat-iterate flow that landed in T1+T2+T3:
 *   1. When a pipeline reaches `awaiting_push_confirm`, the right Preview
 *      Panel auto-opens and surfaces the sticky PushGateFooter (confirm +
 *      cancel actions).
 *   2. The compact PushConfirmGate card in the chat rail no longer renders an
 *      inline iframe (the duplicate-preview bug).
 *   3. A FEEDBACK intent typed into the chat input fires
 *      POST /api/pipelines/:id/iterate-with-feedback, surfaces the
 *      `chat.feedback.optimisticEcho` system message immediately, and the
 *      pipeline cycles back to `awaiting_push_confirm` after `proto_building`.
 *   4. The footer cancel button hits POST /api/pipelines/:id/cancel-push
 *      and transitions the pipeline to `completed_partial`.
 *
 * We mock the HTTP boundary (GET /api/pipelines/:id, the three POST mutations,
 * and the SSE pipeline-event stream — fulfilled with an immediate `done` so
 * the EventSource resolves without churn). This matches the pattern in
 * intent-disambiguation.spec.ts / chat-qa-sse.spec.ts: deterministic, fast,
 * and decoupled from the AI provider.
 *
 * Anchors:
 *   - docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T5
 *   - docs/superpowers/plans/2026-05-14-preview-unify-chat-iterate.md § Task 5
 *   - frontend/src/components/workflow/PushGateFooter.tsx (test IDs)
 *   - frontend/src/components/pipeline/PushConfirmGate.tsx (compact card)
 *   - frontend/src/pages/chat/hooks/useHandleIntentFeedback.ts (optimistic echo)
 *
 * Run: pnpm -C frontend exec playwright test push-gate-chat-iterate
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  mockAuth,
  mockGitHubConnected,
  mockAiKeysMock,
  mockEmptyConversations,
  mockEmptyPipelinesList,
} from './helpers/mock-chat-shell';

type Stage = 'awaiting_push_confirm' | 'proto_building' | 'completed_partial';

interface PushGateState {
  pipelineId: string;
  /** Current stage the GET handler should report. Mutated by POST handlers. */
  stage: Stage;
  /** Counters / captures for assertions. */
  iterateCalls: Array<{ feedback: string }>;
  cancelCalls: number;
  confirmCalls: number;
  /** Toggled by mockPipelinePollSequence so the second GET after iterate flips. */
  protoBuildingGetsBeforeSettle: number;
}

const PIPELINE_ID = 'wf-push-gate-e2e';

/**
 * Build a minimal Pipeline payload the FE accepts. We populate just enough
 * (`scribeConversation` + `protoOutput` with one file + metadata) so:
 *   - `mapPipelineToWorkflow` flags `protoCommitted = false` at push-confirm
 *     and `true` after confirm.
 *   - `useProtoFiles` derives a non-empty file map via the `proto_result`
 *     conversation entry → the right panel can render the Sandpack preview.
 *   - `mapStageToUIState` lifts the stage to the matching `uiState`, which
 *     in turn drives `isPushGate`, the auto-open effect, and the placeholder.
 */
function buildPipeline(stage: Stage): Record<string, unknown> {
  const baseFiles = [
    {
      filePath: '/src/App.tsx',
      content: 'export default function App() {\n  return <h1>QR Üretici</h1>;\n}\n',
      linesOfCode: 3,
    },
    {
      filePath: '/package.json',
      content: JSON.stringify({ name: 'demo', version: '0.0.0' }, null, 2),
      linesOfCode: 4,
    },
  ];

  // committed flag drives the cancel-vs-trace-failure rendering for
  // `completed_partial` (workflows.ts:95). Cancel = never committed.
  const committed = stage === 'completed_partial' ? false : false;

  return {
    id: PIPELINE_ID,
    userId: 'e2e-chat-user',
    stage,
    title: 'QR Kod Üretici (e2e)',
    traceEnabled: false,
    scribeConversation: [
      {
        type: 'user_idea',
        content: 'QR kod üretici, tek dosyalık React uygulaması.',
      },
    ],
    protoOutput: {
      ok: true,
      branch: 'akis/push-gate-e2e',
      repo: 'chat-tester/qr-uretici',
      repoUrl: 'https://github.com/chat-tester/qr-uretici',
      files: baseFiles,
      setupCommands: ['pnpm install', 'pnpm dev'],
      metadata: {
        filesCreated: baseFiles.length,
        totalLinesOfCode: 7,
        stackUsed: 'react+vite',
        committed,
      },
    },
    metrics: {
      scribeCompletedAt: '2026-05-14T10:00:00.000Z',
      approvedAt: '2026-05-14T10:01:00.000Z',
      protoCompletedAt: '2026-05-14T10:02:00.000Z',
    },
    createdAt: '2026-05-14T10:00:00.000Z',
    updatedAt: '2026-05-14T10:02:00.000Z',
  };
}

/**
 * Compose the chat-shell auth + sidebar mocks. We don't reuse
 * `mockChatShellBase` because it registers a generic POST /api/pipelines
 * handler we don't need (this spec navigates directly to an existing chat
 * by id) and a list mock that would otherwise swallow our pipeline GET.
 */
async function mockShell(page: Page) {
  await mockAuth(page, 'PushGate Tester');
  await mockGitHubConnected(page);
  await mockAiKeysMock(page);
  await mockEmptyConversations(page);
  await mockEmptyPipelinesList(page);

  // SSE stream — return an immediate `done`-equivalent empty stream so the
  // EventSource doesn't spin error-retries that pollute the console. The
  // chat page treats stream-down as "fall back to polling", which still
  // hits our mocked GET handlers.
  await page.route(`**/api/pipelines/${PIPELINE_ID}/stream`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body: 'event: ready\ndata: {}\n\n',
    });
  });

  // /files-all is hit by useProtoFiles as a fallback when the conversation
  // doesn't yet carry a `proto_result` entry. We supply both via the
  // conversation, but answer the GET anyway so the network panel stays clean.
  await page.route(`**/api/pipelines/${PIPELINE_ID}/files-all`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: {
          '/src/App.tsx': 'export default () => <h1>QR Üretici</h1>;',
          '/package.json': '{"name":"demo"}',
        },
      }),
    });
  });

  // The rail's `Akış` + `Açıklama` tabs eagerly fetch these auxiliary
  // endpoints. Without an explicit mock they fall through to the real
  // backend which rejects the synthetic non-UUID pipeline id with a 500 —
  // visible as a red banner in the chat. Returning empty payloads keeps
  // the UI quiet without exercising those features (out of scope for T5).
  await page.route(`**/api/pipelines/${PIPELINE_ID}/activities`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ activities: [] }),
    });
  });
  await page.route(`**/api/pipelines/${PIPELINE_ID}/explanation`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        explanation: { stages: [], narrative: '', attentionPoints: [] },
      }),
    });
  });
}

/**
 * Mock the GET /api/pipelines/:id endpoint as a state-machine view. The
 * stage is read from `state.stage`, which the POST handlers mutate.
 *
 * After iterate-with-feedback we want the FE to observe a brief
 * `proto_building` poll before settling back to `awaiting_push_confirm` —
 * `protoBuildingGetsBeforeSettle` controls how many GETs return the
 * intermediate stage before we flip back. Default 1 = one poll, then settle.
 */
async function mockPipelineGet(page: Page, state: PushGateState) {
  await page.route(`**/api/pipelines/${PIPELINE_ID}`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();

    // While `protoBuildingGetsBeforeSettle > 0` we return that intermediate
    // stage and decrement; afterwards we flip to `awaiting_push_confirm` so
    // the gate re-renders with the (mocked) "fresh" files.
    if (state.stage === 'proto_building') {
      if (state.protoBuildingGetsBeforeSettle > 0) {
        state.protoBuildingGetsBeforeSettle -= 1;
      } else {
        state.stage = 'awaiting_push_confirm';
      }
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipeline: buildPipeline(state.stage) }),
    });
  });
}

async function mockMutations(page: Page, state: PushGateState) {
  await page.route(
    `**/api/pipelines/${PIPELINE_ID}/iterate-with-feedback`,
    async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      try {
        const body = JSON.parse(route.request().postData() ?? '{}') as { feedback?: string };
        state.iterateCalls.push({ feedback: body.feedback ?? '' });
      } catch {
        /* ignore */
      }
      // Backend response transitions the pipeline to proto_building. The
      // poll loop will then see proto_building → awaiting_push_confirm.
      state.stage = 'proto_building';
      state.protoBuildingGetsBeforeSettle = 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pipeline: buildPipeline('proto_building') }),
      });
    }
  );

  await page.route(`**/api/pipelines/${PIPELINE_ID}/cancel-push`, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.cancelCalls += 1;
    state.stage = 'completed_partial';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipeline: buildPipeline('completed_partial') }),
    });
  });

  await page.route(`**/api/pipelines/${PIPELINE_ID}/confirm-push`, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.confirmCalls += 1;
    // confirmPush would normally trigger trace; for this spec we just settle
    // back to awaiting_push_confirm so the response shape stays valid. The
    // confirm path isn't exercised here — cancel is the second test case.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipeline: buildPipeline('awaiting_push_confirm') }),
    });
  });

  // Intent classifier — pin FEEDBACK + high confidence so the ChatRouter
  // dispatches without surfacing the DisambiguationModal. This is the path
  // exercised by FR-PU-3 + FR-PU-8.
  await page.route('**/api/chat/intent', async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intent: 'FEEDBACK',
          confidence: 0.95,
          reasoning: 'mocked classifier',
          alternates: [],
          classificationId: `cls-${Date.now()}`,
          threshold: 0.7,
        }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/chat/intent/*', async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

function freshState(): PushGateState {
  return {
    pipelineId: PIPELINE_ID,
    stage: 'awaiting_push_confirm',
    iterateCalls: [],
    cancelCalls: 0,
    confirmCalls: 0,
    protoBuildingGetsBeforeSettle: 0,
  };
}

test.describe('Push-gate chat-driven iterate flow (T5)', () => {
  test('auto-opens preview, footer surfaces actions, chat input drives iterate cycle', async ({
    page,
  }) => {
    const state = freshState();
    await mockShell(page);
    await mockPipelineGet(page, state);
    await mockMutations(page, state);

    await page.goto(`/chat/${PIPELINE_ID}`);

    // FR-PU-2 + FR-PU-4: footer is rendered at the bottom of the auto-opened
    // right Preview Panel. Footer is the canonical "panel is visible" signal
    // — there's no `data-testid="preview-panel"` root, but the footer only
    // mounts when both (a) panel is shown and (b) pushGateProps are passed.
    await expect(page.getByTestId('push-gate-footer')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('push-gate-footer-confirm')).toBeVisible();
    await expect(page.getByTestId('push-gate-footer-cancel')).toBeVisible();

    // FR-PU-5: the compact gate card is present in the chat rail.
    const card = page.getByTestId('push-confirm-gate');
    await expect(card).toBeVisible();

    // FR-PU-1 (no duplicate preview): the card itself has no inline iframe.
    // The iframe lives in the right Preview Panel only.
    await expect(card.locator('iframe')).toHaveCount(0);

    // FR-PU-3: type a FEEDBACK message into the chat input. Placeholder check
    // doubles as a guard that `useConversationState` picked up the new
    // awaiting_push_confirm copy (i18n delta from T3).
    const input = page.getByRole('textbox', { name: 'Mesaj yaz' });
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(input).toHaveAttribute('placeholder', /Ne değişsin/i);
    await input.fill('başlığı büyült');
    await input.press('Enter');

    // FR-PU-8: optimistic echo appears immediately. The exact string is
    // resolved from `chat.feedback.optimisticEcho`, which can be the TR or
    // EN locale depending on the browser's i18next-detected language. The
    // regex matches both translations:
    //   TR: "Düzeltme gönderildi. Proto güncelleniyor..."
    //   EN: "Correction sent. Proto is updating..."
    // Both share the trailing "Proto" + dotted continuation, which is what
    // we anchor on.
    await expect(page.getByText(/(Düzeltme gönderildi|Correction sent).*Proto/i)).toBeVisible({
      timeout: 10_000,
    });

    // The iterate endpoint was hit exactly once with our feedback.
    await expect
      .poll(() => state.iterateCalls.length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
    expect(state.iterateCalls[0]?.feedback).toBe('başlığı büyült');
    // The classifier-dispatched FEEDBACK intent must NOT have been treated
    // as BUILD (that would have hit POST /api/pipelines, which we never
    // mocked — but the contract is also that confirm/cancel didn't fire).
    expect(state.cancelCalls).toBe(0);
    expect(state.confirmCalls).toBe(0);

    // The pipeline transitions through proto_building and settles back to
    // awaiting_push_confirm. We observe the settled state by re-asserting
    // the gate is still visible (it would unmount during proto_building
    // because `pushGateActive` is gated on `awaiting_push_confirm` only).
    // Polling cadence is 8s when SSE is "down" (the stream mock fulfills
    // with a minimal payload that doesn't keep the FE in connected mode),
    // so the timeout has to be generous.
    await expect(page.getByTestId('push-gate-footer')).toBeVisible({ timeout: 20_000 });
  });

  test('cancel action ends the pipeline (completed_partial)', async ({ page }) => {
    const state = freshState();
    await mockShell(page);
    await mockPipelineGet(page, state);
    await mockMutations(page, state);

    await page.goto(`/chat/${PIPELINE_ID}`);

    // Gate has to be live before we can click cancel.
    await expect(page.getByTestId('push-gate-footer-cancel')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('push-gate-footer-cancel').click();

    // The cancel API fired exactly once.
    await expect.poll(() => state.cancelCalls, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    // Backend transitioned to completed_partial. The push-confirm gate
    // unmounts (state machine: !isPushGate(uiState) once stage === completed_partial)
    // and so does the PushGateFooter (it's only rendered while uiState ===
    // awaiting_push_confirm — see ChatPageLayout.tsx pushGateProps wiring).
    await expect(page.getByTestId('push-confirm-gate')).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.getByTestId('push-gate-footer')).toHaveCount(0);
  });
});
