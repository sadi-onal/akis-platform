/**
 * PR-F — Trace iterate-loop E2E.
 *
 * Verifies the new architecture (Critic guardrail invisible + Trace iterate
 * loop, 2026-05-19 refactor):
 *
 *   1. PipelineCinema renders 3 columns (Scribe / Proto / Trace) — no
 *      separate Critic columns.
 *   2. When the backend emits a Trace `retry-trigger` activity, the Trace
 *      column shows a small "Test deniyor (n/m)" badge.
 *   3. After the loop terminates, the badge stays visible reflecting the
 *      final retry count.
 *
 * We mock the HTTP boundary at the GET /:id, /activities, /explanation
 * endpoints. The actual orchestrator/AI loop isn't exercised — the spec is
 * about whether the UI surfaces what the orchestrator emits.
 *
 * Run: pnpm -C frontend exec playwright test trace-iterate-loop
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  mockAuth,
  mockGitHubConnected,
  mockAiKeysMock,
  mockEmptyConversations,
  mockEmptyPipelinesList,
} from './helpers/mock-chat-shell';

const PIPELINE_ID = 'wf-trace-iterate-e2e';

interface FixtureState {
  /** Pipeline stage (drives mocked GET). */
  stage: 'completed' | 'awaiting_push_confirm';
}

function buildPipeline(stage: FixtureState['stage']): Record<string, unknown> {
  const protoFiles = [
    {
      filePath: '/src/App.tsx',
      content: 'export default function App() {\n  return <h1>Reminder</h1>;\n}\n',
      linesOfCode: 3,
    },
  ];
  return {
    id: PIPELINE_ID,
    userId: 'e2e-trace-user',
    stage,
    title: 'Reminder App (PR-F e2e)',
    traceEnabled: true,
    scribeConversation: [
      {
        type: 'user_idea',
        content: 'Hatırlatıcı uygulaması, 3 kabul kriteri.',
      },
    ],
    protoOutput: {
      ok: true,
      branch: 'akis/trace-iterate-e2e',
      repo: 'chat-tester/reminder',
      repoUrl: 'https://github.com/chat-tester/reminder',
      files: protoFiles,
      setupCommands: ['pnpm install'],
      metadata: {
        filesCreated: protoFiles.length,
        totalLinesOfCode: 3,
        stackUsed: 'react+vite',
        committed: false,
      },
    },
    intermediateState: {
      traceIterateRetryCount: 2,
      traceIterateLastFeedback:
        'Trace tamamlandı ama bazı kabul kriterleri test edilmedi.',
    },
    metrics: {
      scribeCompletedAt: '2026-05-19T10:00:00.000Z',
      approvedAt: '2026-05-19T10:01:00.000Z',
      protoCompletedAt: '2026-05-19T10:02:00.000Z',
    },
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T10:03:00.000Z',
  };
}

/**
 * Pre-baked activities that emulate the backend's emit sequence during a
 * Trace iterate-loop run. Scribe + Proto complete normally; Trace emits a
 * `retry-trigger` activity with retryCount=2 and a message in the
 * `... (2/3)` format the cinema regex parses.
 */
function buildActivities(): Array<Record<string, unknown>> {
  return [
    {
      pipelineId: PIPELINE_ID,
      stage: 'scribe',
      step: 'spec_done',
      message: 'Spec yazıldı',
      progress: 100,
      timestamp: '2026-05-19T10:00:30.000Z',
    },
    {
      pipelineId: PIPELINE_ID,
      stage: 'proto',
      step: 'scaffold_done',
      message: 'İskele üretildi',
      progress: 100,
      timestamp: '2026-05-19T10:01:30.000Z',
    },
    {
      pipelineId: PIPELINE_ID,
      stage: 'trace',
      step: 'retry-trigger',
      message:
        'Test eksik kaldı (2/3 kabul kriteri) — Proto yeniden çalışıyor (2/3)',
      progress: 80,
      retryCount: 2,
      timestamp: '2026-05-19T10:02:30.000Z',
    },
    {
      pipelineId: PIPELINE_ID,
      stage: 'trace',
      step: 'tests_generated',
      message: 'Testler üretildi',
      progress: 100,
      timestamp: '2026-05-19T10:03:00.000Z',
    },
  ];
}

async function mockShell(page: Page) {
  await mockAuth(page, 'PR-F Trace Tester');
  await mockGitHubConnected(page);
  await mockAiKeysMock(page);
  await mockEmptyConversations(page);
  await mockEmptyPipelinesList(page);

  // SSE: ready, no live events — cinema bootstraps from activities GET.
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

  await page.route(`**/api/pipelines/${PIPELINE_ID}/files-all`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: { '/src/App.tsx': 'export default () => <h1>Reminder</h1>;' },
      }),
    });
  });

  // Pre-loaded activities replay so the cinema can compute the retry badge.
  await page.route(`**/api/pipelines/${PIPELINE_ID}/activities`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ activities: buildActivities() }),
    });
  });

  // Explanation: empty payload so the rail's Açıklama tab doesn't 500.
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

async function mockPipelineGet(page: Page, state: FixtureState) {
  await page.route(`**/api/pipelines/${PIPELINE_ID}`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipeline: buildPipeline(state.stage) }),
    });
  });
}

test.describe('PR-F — Trace iterate-loop cinema badge', () => {
  test('renders 3-column cinema + Trace retry badge', async ({ page }) => {
    const state: FixtureState = { stage: 'completed' };
    await mockShell(page);
    await mockPipelineGet(page, state);

    await page.goto(`/chat/${PIPELINE_ID}`);
    await page.waitForLoadState('networkidle');

    // PR-F: critic columns must NOT exist anywhere on the page. This
    // assertion holds even when the rail body is collapsed, because the
    // collapsed mini-row also dropped the Critic dot.
    await expect(page.locator('[data-stage="critic_spec"]')).toHaveCount(0);
    await expect(page.locator('[data-stage="critic_code"]')).toHaveCount(0);

    // Expand the pipeline rail so the full Cinema (with the retry badge)
    // renders. Completed pipelines start collapsed by default; expand and
    // then switch to the Akış tab (default at completed is Açıklama).
    const railToggle = page.getByRole('button', { name: 'Pipeline detayı' });
    await railToggle.click();
    const akisTab = page.getByRole('tab', { name: 'Akış' });
    await akisTab.click();

    // 3 columns must exist (cinema rendered once inside the Akış tab).
    await expect(page.locator('[data-stage="scribe"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-stage="proto"]').first()).toBeVisible();
    await expect(page.locator('[data-stage="trace"]').first()).toBeVisible();

    // PR-F: Trace retry badge present because activities include
    // `retry-trigger` with retryCount=2 and message "... (2/3)".
    const badge = page.getByTestId('trace-retry-badge').first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/2\/3/);
  });
});
