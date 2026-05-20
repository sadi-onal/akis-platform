import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TraceAgent,
  type TraceAIDeps,
  type TraceGitHubDeps,
} from '../../src/pipeline/agents/trace/TraceAgent.js';
import type {
  TraceInput,
  StructuredSpec,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Test Fixtures ────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Todo App with Google Auth',
  problemStatement: 'Kullanıcıların günlük görevlerini takip edebilecekleri basit bir uygulama.',
  userStories: [
    {
      persona: 'Kayıtlı kullanıcı',
      action: 'Yeni görev oluşturma',
      benefit: 'Görevlerimi takip etmek',
    },
  ],
  acceptanceCriteria: [
    {
      id: 'ac-1',
      given: 'Giriş yapmış kullanıcı',
      when: 'Görev ekle butonuna tıklarsa',
      then: 'Yeni görev oluşur',
    },
    {
      id: 'ac-2',
      given: 'Giriş yapmış kullanıcı',
      when: 'Görevi silerse',
      then: 'Görev listeden kaldırılır',
    },
  ],
  technicalConstraints: {
    stack: 'React + Vite + TypeScript',
    integrations: ['Google OAuth'],
    nonFunctional: [],
  },
  outOfScope: ['Admin paneli'],
};

const testGenResponse = JSON.stringify({
  testFiles: [
    {
      filePath: 'tests/e2e/todo.spec.ts',
      content:
        'import { test, expect } from "@playwright/test";\n\ntest.describe("Todo App", () => {\n  test("should create todo", async ({ page }) => {\n    await page.goto("/");\n    await expect(page).toHaveTitle(/Todo/);\n  });\n  test("should delete todo", async ({ page }) => {\n    await page.goto("/");\n  });\n});',
      testCount: 2,
    },
    {
      filePath: 'tests/page-objects/BasePage.ts',
      content: 'export class BasePage { constructor(public page: any) {} }',
      testCount: 0,
    },
    {
      filePath: 'tests/playwright.config.ts',
      content:
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e" });',
      testCount: 0,
    },
  ],
  coverageMatrix: {
    'ac-1': ['tests/e2e/todo.spec.ts'],
    'ac-2': ['tests/e2e/todo.spec.ts'],
  },
  testSummary: {
    totalTests: 2,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1', 'ac-2'],
    uncoveredCriteria: [],
  },
});

function baseInput(overrides?: Partial<TraceInput>): TraceInput {
  return {
    repoOwner: 'testuser',
    repo: 'my-todo-app',
    branch: 'proto/scaffold-123',
    spec: validSpec,
    ...overrides,
  };
}

// ─── Mock Factories ───────────────────────────────

function createMockAI(response: string): TraceAIDeps {
  return {
    async generateText() {
      return response;
    },
  };
}

function createFailingAI(failCount: number, thenRespond: string): TraceAIDeps {
  let failures = 0;
  return {
    async generateText() {
      if (failures < failCount) {
        failures++;
        throw new Error('AI provider error');
      }
      return thenRespond;
    },
  };
}

function createMockGitHub(overrides?: Partial<TraceGitHubDeps>): TraceGitHubDeps {
  return {
    async listFiles() {
      return [
        'src/App.tsx',
        'src/index.ts',
        'package.json',
        'README.md',
        'node_modules/react/index.js',
        '.git/HEAD',
      ];
    },
    async getFileContent(_o, _r, _b, filePath) {
      if (filePath === 'src/App.tsx')
        return 'export default function App() { return <div>Hello</div>; }';
      if (filePath === 'src/index.ts') return 'import App from "./App";\nrender(App);';
      return '';
    },
    async commitFile() {},
    async createBranch() {},
    async createPR() {
      return { url: 'https://github.com/testuser/my-todo-app/pull/2' };
    },
    ...overrides,
  };
}

// ─── Test Generation ──────────────────────────────

describe('Trace — Test generation', () => {
  it('generates tests from codebase and pushes to GitHub', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.ok, true);
      assert.equal(result.data.testFiles.length, 3);
      assert.equal(result.data.branch, 'proto/scaffold-123');
      assert.ok(result.data.prUrl?.includes('pull/2'));
      assert.equal(result.data.testSummary.totalTests, 2);
    }
  });

  it('maps coverage matrix to acceptance criteria', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.deepEqual(result.data.coverageMatrix['ac-1'], ['tests/e2e/todo.spec.ts']);
      assert.deepEqual(result.data.coverageMatrix['ac-2'], ['tests/e2e/todo.spec.ts']);
      assert.equal(result.data.testSummary.coveragePercentage, 100);
      assert.deepEqual(result.data.testSummary.coveredCriteria, ['ac-1', 'ac-2']);
      assert.deepEqual(result.data.testSummary.uncoveredCriteria, []);
    }
  });

  it('creates PR with test summary', async () => {
    let prBody = '';
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      async createPR(_o, _r, _t, body) {
        prBody = body;
        return { url: 'https://github.com/testuser/my-todo-app/pull/2' };
      },
    });
    const agent = new TraceAgent(ai, github);

    await agent.execute(baseInput());
    assert.ok(prBody.includes('Playwright E2E Tests'));
    assert.ok(prBody.includes('AKIS Trace'));
    assert.ok(prBody.includes('ac-1'));
  });
});

// ─── Dry Run ──────────────────────────────────────

describe('Trace — Dry run mode', () => {
  it('generates tests without GitHub push operations', async () => {
    let githubPushCalled = false;
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      async commitFile() {
        githubPushCalled = true;
      },
      async createBranch() {
        githubPushCalled = true;
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(githubPushCalled, false);
    if (result.type === 'output') {
      assert.equal(result.data.testFiles.length, 3);
      assert.equal(result.data.branch, undefined);
    }
  });
});

// ─── File Filtering ───────────────────────────────

describe('Trace — File filtering', () => {
  it('excludes node_modules and .git files', async () => {
    const readFiles: string[] = [];
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      async getFileContent(_o, _r, _b, filePath) {
        readFiles.push(filePath);
        return 'content';
      },
    });
    const agent = new TraceAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.ok(!readFiles.includes('node_modules/react/index.js'));
    assert.ok(!readFiles.includes('.git/HEAD'));
    assert.ok(readFiles.includes('src/App.tsx'));
    assert.ok(readFiles.includes('src/index.ts'));
  });

  it('returns TRACE_EMPTY_CODEBASE when only non-source files exist', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      async listFiles() {
        return ['package.json', 'README.md', '.gitignore', 'node_modules/react/index.js'];
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_EMPTY_CODEBASE');
    }
  });
});

// ─── GitHub Error Handling ────────────────────────

describe('Trace — GitHub error handling', () => {
  it('returns error when file push fails', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      async commitFile() {
        throw new Error('Git push rejected');
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
  });

  it('continues even if PR creation fails', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      async createPR() {
        throw new Error('PR creation failed');
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.ok, true);
      assert.equal(result.data.prUrl, undefined);
      assert.equal(result.data.branch, 'proto/scaffold-123');
    }
  });

  // PR-V-github-401-graceful — when listFiles/getFileContent surface a
  // GitHubTokenInvalidError (401), TraceAgent must:
  //   1. Return GITHUB_TOKEN_INVALID error (not the vague TRACE_CODE_READ_FAILED)
  //   2. NOT retry (auth failure won't recover with backoff)
  // The orchestrator then catches the dedicated code, clears the stale token
  // row, and renders the reconnect-github banner.
  it('returns GITHUB_TOKEN_INVALID without retry when adapter throws auth error', async () => {
    const { GitHubTokenInvalidError } = await import(
      '../../src/pipeline/core/contracts/PipelineErrors.js'
    );
    let listFilesCalls = 0;
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      async listFiles() {
        listFilesCalls++;
        throw new GitHubTokenInvalidError(
          'GitHub API GET /repos/foo/bar/git/trees/main → 401: Bad credentials'
        );
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(
        result.error.code,
        'GITHUB_TOKEN_INVALID',
        'should surface dedicated auth error, not TRACE_CODE_READ_FAILED'
      );
      assert.equal(result.error.recoveryAction, 'reconnect_github');
      assert.equal(result.error.retryable, false);
    }
    // Critical: adapter must NOT be retried on auth failure.
    assert.equal(listFilesCalls, 1, '401 should bail immediately — no retry');
  });
});

// ─── AI Error Handling ────────────────────────────

describe('Trace — AI error handling', () => {
  it('retries test generation on AI failure', async () => {
    const ai = createFailingAI(1, testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
  });

  it('returns error after all AI retries exhausted', async () => {
    const ai = createFailingAI(10, testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_TEST_GENERATION_FAILED');
    }
  });

  it('returns error on invalid AI JSON response', async () => {
    const ai = createMockAI('not json at all');
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_TEST_GENERATION_FAILED');
    }
  });

  it('returns error when AI returns empty testFiles array', async () => {
    const ai = createMockAI(
      JSON.stringify({
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 0,
          coveragePercentage: 0,
          coveredCriteria: [],
          uncoveredCriteria: [],
        },
      })
    );
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_TEST_GENERATION_FAILED');
    }
  });

  // T3 EKSİK #1: testFiles dolu ama her dosyanın content'i boş/whitespace
  it('T3: returns error when all test files have empty content', async () => {
    const ai = createMockAI(
      JSON.stringify({
        testFiles: [
          { filePath: 'tests/e2e/todo.spec.ts', content: '', testCount: 0 },
          { filePath: 'tests/playwright.config.ts', content: '   \n  \t  ', testCount: 0 },
        ],
        coverageMatrix: { 'ac-1': ['tests/e2e/todo.spec.ts'] },
      })
    );
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_TEST_GENERATION_FAILED');
      assert.match(String(result.error.technicalDetail), /empty content/i);
    }
  });

  // T3 EKSİK #2: coverageMatrix tamamen boş + spec AC'leri var
  it('T3: returns error when coverageMatrix is empty and spec has acceptance criteria', async () => {
    const ai = createMockAI(
      JSON.stringify({
        testFiles: [
          {
            filePath: 'tests/e2e/todo.spec.ts',
            content: 'import { test, expect } from "@playwright/test";\ntest("x", () => {});',
            testCount: 1,
          },
        ],
        coverageMatrix: {},
      })
    );
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_TEST_GENERATION_FAILED');
      assert.match(String(result.error.technicalDetail), /No acceptance criterion/i);
    }
  });

  // T3 EKSİK #2 variant: coverageMatrix dolu ama hiçbir key spec AC ID'siyle eşleşmiyor
  it('T3: returns error when coverageMatrix keys do not match any spec AC', async () => {
    const ai = createMockAI(
      JSON.stringify({
        testFiles: [
          {
            filePath: 'tests/e2e/todo.spec.ts',
            content: 'import { test } from "@playwright/test";\ntest("x", () => {});',
            testCount: 1,
          },
        ],
        // ac-99 doesn't exist in spec — should fail
        coverageMatrix: { 'ac-99': ['tests/e2e/todo.spec.ts'] },
      })
    );
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_TEST_GENERATION_FAILED');
      assert.match(String(result.error.technicalDetail), /No acceptance criterion/i);
    }
  });
});

// ─── JSON Extraction ──────────────────────────────

describe('Trace — JSON extraction', () => {
  it('handles fenced code block responses', async () => {
    const wrapped = '```json\n' + testGenResponse + '\n```';
    const ai = createMockAI(wrapped);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
  });

  it('handles JSON surrounded by text', async () => {
    const wrapped = 'Here is the test output:\n' + testGenResponse + '\nDone.';
    const ai = createMockAI(wrapped);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
  });
});
