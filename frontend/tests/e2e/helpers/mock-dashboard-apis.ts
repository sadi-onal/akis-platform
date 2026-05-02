/**
 * Shared mock helpers for E2E tests that need an authenticated dashboard.
 *
 * Centralises the Playwright `page.route()` interceptions so every test file
 * uses identical mock payloads and avoids copy-paste drift.
 */
import type { Page, Route } from '@playwright/test';

/* ---------- constants ---------- */
export const MOCK_USER = {
  id: 'e2e-user',
  email: 'e2e@test.akis.dev',
  firstName: 'E2E',
  lastName: 'Tester',
  emailVerified: true,
  role: 'user',
} as const;

export const MOCK_JOB_ID = 'e2e-job-00000001';

/* ---------- helpers ---------- */

/**
 * Mock the minimum set of APIs required for any authenticated dashboard page:
 * - GET /auth/me → authenticated user
 * - GET /api/agents/jobs/running → empty running jobs list
 * - GET /api/usage/** → zero usage
 */
export async function mockDashboardApis(page: Page) {
  await page.route('**/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_USER),
    });
  });

  await page.route('**/api/agents/jobs/running', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [] }),
    });
  });

  await page.route('**/api/usage/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ used: 0, limit: 100 }),
    });
  });
}

/**
 * Mock the unauthenticated state so route guards redirect to /login.
 */
export async function mockUnauthenticated(page: Page) {
  await page.route('**/auth/me', async (route: Route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' });
  });
}

/**
 * Mock AI-keys status (needed by agent consoles before job submission).
 * Real endpoint: GET /api/settings/ai-keys/status
 */
export async function mockAiKeysStatus(page: Page) {
  await page.route('**/api/settings/ai-keys/status', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        activeProvider: 'openai',
        providers: {
          openai: { configured: true, last4: '1234', updatedAt: '2026-02-08T00:00:00Z' },
          openrouter: { configured: false, last4: null, updatedAt: null },
        },
      }),
    });
  });
}

/**
 * Mock POST /api/agents/jobs → runAgent response.
 * Returns a deterministic job ID.
 */
export async function mockRunAgent(page: Page, jobId = MOCK_JOB_ID) {
  await page.route('**/api/agents/jobs', async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId, state: 'pending' }),
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * Mock GET /api/agents/jobs/:id with a sequence of states.
 * Each call pops the next state from the array. Last state is sticky.
 */
export function mockJobPolling(
  page: Page,
  states: Array<{
    state: 'pending' | 'running' | 'completed' | 'failed';
    result?: unknown;
    trace?: unknown[];
    error?: string;
    errorMessage?: string;
  }>,
  jobId = MOCK_JOB_ID,
) {
  let callIndex = 0;

  return page.route(`**/api/agents/jobs/${jobId}**`, async (route: Route) => {
    const entry = states[Math.min(callIndex, states.length - 1)];
    callIndex++;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: jobId,
        type: 'trace',
        state: entry.state,
        createdAt: '2026-02-08T12:00:00Z',
        updatedAt: '2026-02-08T12:00:05Z',
        ...(entry.result && { result: entry.result }),
        ...(entry.trace && { trace: entry.trace }),
        ...(entry.error && { error: entry.error }),
        ...(entry.errorMessage && { errorMessage: entry.errorMessage }),
      }),
    });
  });
}

/**
 * Mock POST /api/agents/jobs with a 500 server error.
 */
export async function mockRunAgentError(page: Page, statusCode = 500, message = 'Internal Server Error') {
  await page.route('**/api/agents/jobs', async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: statusCode,
        contentType: 'application/json',
        // HttpClient.parseErrorResponse reads error.message from { error: { message } }
        body: JSON.stringify({ error: { code: `HTTP_${statusCode}`, message } }),
      });
    } else {
      await route.continue();
    }
  });
}

/* ---------- Scribe-specific mocks ---------- */

/**
 * Mock GitHub integration as connected with repos and branches.
 * Intercepts:
 *   GET /api/integrations/github/status → connected + login
 *   GET /api/integrations/github/repos  → one repo
 *   GET /api/integrations/github/branches → main branch
 */
export async function mockGitHubConnected(page: Page) {
  await page.route('**/api/integrations/github/status', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connected: true,
        login: 'e2e-user',
        avatarUrl: 'https://example.com/avatar.png',
      }),
    });
  });

  await page.route('**/api/integrations/github/repos**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repos: [
          {
            name: 'demo-app',
            fullName: 'e2e-user/demo-app',
            defaultBranch: 'main',
            private: false,
            description: 'Demo application',
          },
        ],
      }),
    });
  });

  await page.route('**/api/integrations/github/branches**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        branches: [
          { name: 'main', isDefault: true },
          { name: 'develop', isDefault: false },
        ],
        defaultBranch: 'main',
      }),
    });
  });
}

/**
 * Mock GitHub integration as disconnected (API returns error → page shows error notice).
 */
export async function mockGitHubDisconnected(page: Page) {
  await page.route('**/api/integrations/github/status', async (route: Route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_CONNECTED', message: 'GitHub not connected' } }),
    });
  });
}
