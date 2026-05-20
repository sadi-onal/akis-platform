/**
 * CIService — triggers GitHub Actions workflow_dispatch, polls for results,
 * and downloads test artifacts.
 */

const GITHUB_API = 'https://api.github.com';
const POLL_INTERVAL_MS = 10_000; // 10s
const MAX_POLL_DURATION_MS = 10 * 60_000; // 10min

export interface CIResult {
  ok: boolean;
  runId: number;
  status: 'completed' | 'failure' | 'timed_out' | 'cancelled';
  conclusion: string | null;
  htmlUrl: string;
  testResults?: {
    passed: number;
    failed: number;
    total: number;
    failures: Array<{ file: string; line: number; message: string }>;
  };
}

async function ghFetch<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return res.json() as Promise<T>;
  }
  return {} as T;
}

/**
 * Trigger workflow_dispatch for the AKIS e2e workflow.
 *
 * T3: file name aligned with what Proto/Trace actually push into the user's
 * scaffold — see `pipeline/templates/akisE2eWorkflow.ts:7`. The previous
 * `akis-tests.yml` reference 404'd because the workflow on disk was always
 * `akis-e2e.yml`.
 */
export async function triggerWorkflowDispatch(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  await ghFetch(
    token,
    'POST',
    `/repos/${owner}/${repo}/actions/workflows/akis-e2e.yml/dispatches`,
    { ref: branch }
  );
}

/**
 * Poll for the workflow run triggered by dispatch.
 * Returns the run when it completes or times out.
 */
export async function pollWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  onProgress?: (status: string) => void
): Promise<CIResult> {
  const startTime = Date.now();

  // Wait a few seconds for the run to appear
  await new Promise((r) => setTimeout(r, 5000));

  while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
    const runs = await ghFetch<{
      workflow_runs: Array<{
        id: number;
        status: string;
        conclusion: string | null;
        html_url: string;
        head_branch: string;
        event: string;
      }>;
    }>(
      token,
      'GET',
      `/repos/${owner}/${repo}/actions/runs?branch=${branch}&event=workflow_dispatch&per_page=1`
    );

    const run = runs.workflow_runs?.[0];
    if (!run) {
      onProgress?.('Workflow run bekleniyor...');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    if (run.status === 'completed') {
      return {
        ok: run.conclusion === 'success',
        runId: run.id,
        status: 'completed',
        conclusion: run.conclusion,
        htmlUrl: run.html_url,
      };
    }

    onProgress?.(`CI çalışıyor... (${run.status})`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return {
    ok: false,
    runId: 0,
    status: 'timed_out',
    conclusion: null,
    htmlUrl: `https://github.com/${owner}/${repo}/actions`,
  };
}

// T3: the previous `AKIS_TESTS_WORKFLOW_YAML` template lived here as a
// would-be Proto inclusion, but Proto/Trace already push
// `pipeline/templates/akisE2eWorkflow.ts` into every scaffold. The two
// templates diverged in name (`akis-tests.yml` vs `akis-e2e.yml`) and
// content, causing `triggerWorkflowDispatch` to fire against a workflow
// file that wasn't on disk. The dead template is gone; the live template
// in `pipeline/templates/akisE2eWorkflow.ts` is the single source of truth.
