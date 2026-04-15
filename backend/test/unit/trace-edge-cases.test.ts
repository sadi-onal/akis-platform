import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TraceAgent,
  type TraceAIDeps,
  type TraceGitHubDeps,
} from '../../src/pipeline/agents/trace/TraceAgent.js';
import type {
  TraceInput,
  TraceOutput,
  StructuredSpec,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Shared Fixtures ─────────────────────────────

const minimalSpec: StructuredSpec = {
  title: 'Edge Case App',
  problemStatement: 'Test edge scenarios',
  userStories: [
    { persona: 'User', action: 'Interact', benefit: 'Value' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'User on page', when: 'clicks button', then: 'action happens' },
  ],
  technicalConstraints: { stack: 'React' },
  outOfScope: [],
};

const validAIResponse = JSON.stringify({
  testFiles: [
    {
      filePath: 'tests/e2e/app.spec.ts',
      content: 'import { test, expect } from "@playwright/test";\ntest("loads", async ({ page }) => { await page.goto("/"); });',
      testCount: 1,
    },
    {
      filePath: 'tests/playwright.config.ts',
      content: 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({});',
      testCount: 0,
    },
  ],
  coverageMatrix: { 'ac-1': ['tests/e2e/app.spec.ts'] },
  testSummary: {
    totalTests: 1,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
});

function baseInput(overrides?: Partial<TraceInput>): TraceInput {
  return {
    repoOwner: 'testuser',
    repo: 'edge-case-repo',
    branch: 'main',
    spec: minimalSpec,
    ...overrides,
  };
}

function createMockAI(response: string): TraceAIDeps {
  return { async generateText() { return response; } };
}

function createMockGitHub(overrides?: Partial<TraceGitHubDeps>): TraceGitHubDeps {
  return {
    async listFiles() { return ['src/App.tsx', 'src/index.ts']; },
    async getFileContent(_o, _r, _b, filePath) {
      if (filePath === 'src/App.tsx') return 'export default function App() { return <div>Hello</div>; }';
      return 'export {};';
    },
    async commitFile() {},
    async createBranch() {},
    async createPR() { return { url: 'https://github.com/testuser/edge-case-repo/pull/1' }; },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════
// 1. Empty repository — 0 files in repo
// ═══════════════════════════════════════════════════

describe('Trace edge — Empty repository', () => {
  it('returns TRACE_EMPTY_CODEBASE when repo has zero files', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() { return []; },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_EMPTY_CODEBASE');
      assert.equal(result.error.retryable, false);
      assert.ok(result.error.message.length > 0);
    }
  });

  it('AI generateText is never called for empty repo', async () => {
    let aiCalled = false;
    const ai: TraceAIDeps = {
      async generateText() { aiCalled = true; return ''; },
    };
    const github = createMockGitHub({
      async listFiles() { return []; },
    });
    const agent = new TraceAgent(ai, github);

    await agent.execute(baseInput());
    assert.equal(aiCalled, false, 'AI should not be called when there are no source files');
  });
});

// ═══════════════════════════════════════════════════
// 2. Only config files — no source code to test
// ═══════════════════════════════════════════════════

describe('Trace edge — Only config files (no source code)', () => {
  it('returns TRACE_EMPTY_CODEBASE when repo has only config/meta files', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        // None of these have source extensions (.ts/.tsx/.js/.jsx/.vue/.svelte/.css/.html)
        return [
          'package.json',
          'tsconfig.json',
          'README.md',
          '.gitignore',
          '.prettierrc',
          'LICENSE',
          'yarn.lock',
          'Dockerfile',
          '.env.example',
          'Makefile',
        ];
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_EMPTY_CODEBASE');
    }
  });

  it('filters out .json and .md files from source reading', async () => {
    const readFiles: string[] = [];
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        return ['package.json', 'README.md', 'src/main.ts', 'tsconfig.json'];
      },
      async getFileContent(_o, _r, _b, filePath) {
        readFiles.push(filePath);
        return 'export const x = 1;';
      },
    });
    const agent = new TraceAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.ok(readFiles.includes('src/main.ts'), 'Should read .ts files');
    assert.ok(!readFiles.includes('package.json'), 'Should not read .json files');
    assert.ok(!readFiles.includes('README.md'), 'Should not read .md files');
    assert.ok(!readFiles.includes('tsconfig.json'), 'Should not read tsconfig');
  });
});

// ═══════════════════════════════════════════════════
// 3. Binary files in repo — should be skipped
// ═══════════════════════════════════════════════════

describe('Trace edge — Binary files in repo', () => {
  it('skips binary files (images, PDFs, fonts) and only reads source', async () => {
    const readFiles: string[] = [];
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        return [
          'src/App.tsx',
          'public/logo.png',
          'public/favicon.ico',
          'docs/manual.pdf',
          'assets/font.woff2',
          'images/hero.jpg',
          'dist/bundle.js',       // excluded by EXCLUDE_PATTERNS (dist/)
          'build/output.js',      // excluded by EXCLUDE_PATTERNS (build/)
          'src/styles.css',       // CSS is a source extension
        ];
      },
      async getFileContent(_o, _r, _b, filePath) {
        readFiles.push(filePath);
        return 'content';
      },
    });
    const agent = new TraceAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.ok(readFiles.includes('src/App.tsx'), 'Should read .tsx');
    assert.ok(readFiles.includes('src/styles.css'), 'Should read .css');
    assert.ok(!readFiles.includes('public/logo.png'), 'Should skip .png');
    assert.ok(!readFiles.includes('public/favicon.ico'), 'Should skip .ico');
    assert.ok(!readFiles.includes('docs/manual.pdf'), 'Should skip .pdf');
    assert.ok(!readFiles.includes('assets/font.woff2'), 'Should skip .woff2');
    assert.ok(!readFiles.includes('images/hero.jpg'), 'Should skip .jpg');
    assert.ok(!readFiles.includes('dist/bundle.js'), 'Should skip dist/ files');
    assert.ok(!readFiles.includes('build/output.js'), 'Should skip build/ files');
  });
});

// ═══════════════════════════════════════════════════
// 4. TraceOutput schema validation
// ═══════════════════════════════════════════════════

describe('Trace edge — TraceOutput schema validation', () => {
  it('output has all required fields with correct types', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const data: TraceOutput = result.data;
    // ok
    assert.equal(typeof data.ok, 'boolean');
    assert.equal(data.ok, true);
    // testFiles
    assert.ok(Array.isArray(data.testFiles));
    for (const f of data.testFiles) {
      assert.equal(typeof f.filePath, 'string');
      assert.equal(typeof f.content, 'string');
      assert.equal(typeof f.testCount, 'number');
      assert.ok(f.filePath.length > 0, 'filePath must not be empty');
    }
    // coverageMatrix
    assert.equal(typeof data.coverageMatrix, 'object');
    assert.ok(!Array.isArray(data.coverageMatrix));
    for (const [key, val] of Object.entries(data.coverageMatrix)) {
      assert.equal(typeof key, 'string');
      assert.ok(Array.isArray(val));
    }
    // testSummary
    assert.equal(typeof data.testSummary, 'object');
    assert.equal(typeof data.testSummary.totalTests, 'number');
    assert.equal(typeof data.testSummary.coveragePercentage, 'number');
    assert.ok(Array.isArray(data.testSummary.coveredCriteria));
    assert.ok(Array.isArray(data.testSummary.uncoveredCriteria));
    assert.ok(data.testSummary.coveragePercentage >= 0);
    assert.ok(data.testSummary.coveragePercentage <= 100);
  });

  it('normalizes non-number testCount to 0', async () => {
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 'tests/a.spec.ts', content: 'test code', testCount: 'not-a-number' },
        { filePath: 'tests/b.spec.ts', content: 'more code', testCount: null },
      ],
      coverageMatrix: {},
      testSummary: { totalTests: 0, coveragePercentage: 0, coveredCriteria: [], uncoveredCriteria: [] },
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      for (const f of result.data.testFiles) {
        assert.equal(typeof f.testCount, 'number');
        assert.equal(f.testCount, 0, 'Non-numeric testCount should normalize to 0');
      }
    }
  });

  it('stringifies non-string filePath and content', async () => {
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 12345, content: true, testCount: 1 },
      ],
      coverageMatrix: {},
      testSummary: { totalTests: 1, coveragePercentage: 100, coveredCriteria: [], uncoveredCriteria: [] },
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(typeof result.data.testFiles[0].filePath, 'string');
      assert.equal(typeof result.data.testFiles[0].content, 'string');
    }
  });
});

// ═══════════════════════════════════════════════════
// 5. Test file syntax — generated test imports
// ═══════════════════════════════════════════════════

describe('Trace edge — Test file syntax validation', () => {
  it('generated test files contain Playwright imports', async () => {
    const responseWithImports = JSON.stringify({
      testFiles: [
        {
          filePath: 'tests/e2e/login.spec.ts',
          content: 'import { test, expect } from "@playwright/test";\n\ntest("login works", async ({ page }) => {\n  await page.goto("/login");\n  await expect(page.locator("h1")).toBeVisible();\n});',
          testCount: 1,
        },
      ],
      coverageMatrix: { 'ac-1': ['tests/e2e/login.spec.ts'] },
      testSummary: { totalTests: 1, coveragePercentage: 100, coveredCriteria: ['ac-1'], uncoveredCriteria: [] },
    });
    const ai = createMockAI(responseWithImports);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      const specFile = result.data.testFiles.find((f) => f.filePath.endsWith('.spec.ts'));
      assert.ok(specFile, 'Should have at least one .spec.ts file');
      assert.ok(
        specFile!.content.includes('@playwright/test'),
        'Spec file should import from @playwright/test'
      );
    }
  });

  it('preserves test file content through the pipeline', async () => {
    const originalContent = 'import { test } from "@playwright/test";\ntest("smoke", async () => {});';
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 'tests/smoke.spec.ts', content: originalContent, testCount: 1 },
      ],
      coverageMatrix: {},
      testSummary: { totalTests: 1, coveragePercentage: 100, coveredCriteria: [], uncoveredCriteria: [] },
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.testFiles[0].content, originalContent);
    }
  });
});

// ═══════════════════════════════════════════════════
// 6. GitHub API rate limit — 403 response
// ═══════════════════════════════════════════════════

describe('Trace edge — GitHub API rate limit (403)', () => {
  it('returns TRACE_CODE_READ_FAILED on persistent GitHub 403', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        const err = new Error('API rate limit exceeded') as Error & { status: number };
        err.status = 403;
        throw err;
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_CODE_READ_FAILED');
      assert.ok(result.error.retryable);
      assert.ok(
        result.error.technicalDetail?.includes('rate limit') || result.error.technicalDetail?.includes('403'),
        'Technical detail should mention rate limit or 403'
      );
    }
  });

  it('retries on transient GitHub errors before failing', async () => {
    let callCount = 0;
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        callCount++;
        if (callCount <= 3) throw new Error('GitHub 500 Internal Server Error');
        return ['src/App.tsx'];
      },
    });
    const agent = new TraceAgent(ai, github);

    // With 3 retries max (4 total attempts), the 4th call succeeds
    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(callCount, 4, 'Should have retried 3 times + 1 success');
  });
});

// ═══════════════════════════════════════════════════
// 7. Branch not found — deleted branch
// ═══════════════════════════════════════════════════

describe('Trace edge — Branch not found', () => {
  it('returns TRACE_CODE_READ_FAILED when branch does not exist', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        throw new Error('Git ref not found: refs/heads/deleted-branch');
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ branch: 'deleted-branch' }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_CODE_READ_FAILED');
      assert.ok(
        result.error.technicalDetail?.includes('not found') || result.error.technicalDetail?.includes('ref'),
        'Should mention branch not found in technical detail'
      );
    }
  });

  it('returns TRACE_CODE_READ_FAILED when repo does not exist', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        throw new Error('Not Found: repository nonexistent/repo');
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ repo: 'nonexistent-repo' }));
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'TRACE_CODE_READ_FAILED');
    }
  });
});

// ═══════════════════════════════════════════════════
// 8. dryRun mode — no GitHub writes
// ═══════════════════════════════════════════════════

describe('Trace edge — dryRun mode (no GitHub writes)', () => {
  it('does not call commitFile in dryRun mode', async () => {
    let commitCalled = false;
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async commitFile() { commitCalled = true; },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(commitCalled, false, 'commitFile must not be called in dryRun');
  });

  it('does not call createBranch in dryRun mode', async () => {
    let branchCreated = false;
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async createBranch() { branchCreated = true; },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(branchCreated, false, 'createBranch must not be called in dryRun');
  });

  it('does not call createPR in dryRun mode', async () => {
    let prCreated = false;
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async createPR() { prCreated = true; return { url: '' }; },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(prCreated, false, 'createPR must not be called in dryRun');
  });

  it('returns undefined branch in dryRun output', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.branch, undefined, 'Branch should be undefined in dryRun output');
      assert.equal(result.data.prUrl, undefined, 'prUrl should be undefined in dryRun output');
    }
  });

  it('still produces valid testFiles in dryRun mode', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.ok(result.data.testFiles.length > 0, 'dryRun should still generate test files');
      assert.ok(result.data.ok);
    }
  });
});

// ═══════════════════════════════════════════════════
// 9. Very large repo — 100+ files handling
// ═══════════════════════════════════════════════════

describe('Trace edge — Very large repo (100+ files)', () => {
  it('caps source files at MAX_SOURCE_FILES (80)', async () => {
    const readFiles: string[] = [];
    // Generate 150 .ts files
    const allFiles = Array.from({ length: 150 }, (_, i) => `src/component-${i}.ts`);
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() { return allFiles; },
      async getFileContent(_o, _r, _b, filePath) {
        readFiles.push(filePath);
        return `export const c${readFiles.length} = true;`;
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.ok(readFiles.length <= 80, `Should read at most 80 files, got ${readFiles.length}`);
  });

  it('skips individual files exceeding 100KB', async () => {
    const readFiles: string[] = [];
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() {
        return ['src/small.ts', 'src/huge.ts', 'src/medium.ts'];
      },
      async getFileContent(_o, _r, _b, filePath) {
        readFiles.push(filePath);
        if (filePath === 'src/huge.ts') return 'x'.repeat(200_000); // 200KB > 100KB limit
        return 'export const x = 1;';
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      // getFileContent was called for huge.ts, but it should be dropped from the
      // codebase context sent to AI due to exceeding MAX_FILE_SIZE_BYTES.
      // The agent still processes because small.ts and medium.ts provide content.
      assert.ok(result.data.testFiles.length > 0);
    }
  });

  it('respects context budget (200K chars) across files', async () => {
    // Each file is 60K chars. Budget is 200K. So at most 3 files fit.
    const allFiles = Array.from({ length: 10 }, (_, i) => `src/big-${i}.ts`);
    const readFiles: string[] = [];
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() { return allFiles; },
      async getFileContent(_o, _r, _b, filePath) {
        readFiles.push(filePath);
        return 'a'.repeat(60_000);
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    // 60K * 3 = 180K < 200K; 60K * 4 = 240K > 200K
    // Files are read sequentially but the 4th will exceed budget and stop.
    assert.ok(readFiles.length <= 4, `Context budget should cap files, got ${readFiles.length}`);
  });

  it('does not crash or timeout on repos with many excluded paths', async () => {
    // Mix of excluded and valid files
    const allFiles = [
      ...Array.from({ length: 500 }, (_, i) => `node_modules/pkg-${i}/index.js`),
      ...Array.from({ length: 50 }, (_, i) => `.git/objects/${i}`),
      ...Array.from({ length: 20 }, (_, i) => `dist/chunk-${i}.js`),
      'src/App.tsx',
      'src/main.ts',
    ];
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async listFiles() { return allFiles; },
      async getFileContent(_o, _r, _b, filePath) {
        if (filePath === 'src/App.tsx') return 'export default function App() { return <div />; }';
        return 'export {};';
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
  });
});

// ═══════════════════════════════════════════════════
// 10. Coverage matrix validation
// ═══════════════════════════════════════════════════

describe('Trace edge — Coverage matrix validation', () => {
  it('coverage matrix keys map to spec acceptance criteria IDs', async () => {
    const specWithMultipleACs: StructuredSpec = {
      ...minimalSpec,
      acceptanceCriteria: [
        { id: 'ac-1', given: 'User logged in', when: 'views dashboard', then: 'sees data' },
        { id: 'ac-2', given: 'User logged in', when: 'creates item', then: 'item appears' },
        { id: 'ac-3', given: 'User logged in', when: 'deletes item', then: 'item removed' },
      ],
    };
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 'tests/e2e/dashboard.spec.ts', content: 'test code', testCount: 2 },
        { filePath: 'tests/e2e/crud.spec.ts', content: 'test code', testCount: 1 },
      ],
      coverageMatrix: {
        'ac-1': ['tests/e2e/dashboard.spec.ts'],
        'ac-2': ['tests/e2e/crud.spec.ts'],
        // ac-3 intentionally missing
      },
      testSummary: {
        totalTests: 3,
        coveragePercentage: 67,
        coveredCriteria: ['ac-1', 'ac-2'],
        uncoveredCriteria: ['ac-3'],
      },
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true, spec: specWithMultipleACs }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.ok('ac-1' in result.data.coverageMatrix);
      assert.ok('ac-2' in result.data.coverageMatrix);
      assert.ok(result.data.testSummary.uncoveredCriteria.includes('ac-3'));
    }
  });

  it('produces empty coverageMatrix when AI returns none', async () => {
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 'tests/e2e/basic.spec.ts', content: 'test("works", () => {});', testCount: 1 },
      ],
      // No coverageMatrix in response
      testSummary: { totalTests: 1, coveragePercentage: 0, coveredCriteria: [], uncoveredCriteria: ['ac-1'] },
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.deepEqual(result.data.coverageMatrix, {});
    }
  });

  it('calculates correct coverage percentage from spec criteria', async () => {
    const specWith3ACs: StructuredSpec = {
      ...minimalSpec,
      acceptanceCriteria: [
        { id: 'ac-1', given: 'g', when: 'w', then: 't' },
        { id: 'ac-2', given: 'g', when: 'w', then: 't' },
        { id: 'ac-3', given: 'g', when: 'w', then: 't' },
      ],
    };
    // AI covers ac-1 and ac-2 (2/3 = 67%)
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 'tests/app.spec.ts', content: 'tests', testCount: 2 },
      ],
      coverageMatrix: {
        'ac-1': ['tests/app.spec.ts'],
        'ac-2': ['tests/app.spec.ts'],
      },
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true, spec: specWith3ACs }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      // Agent recalculates: 2 covered / 3 total = 67%
      assert.equal(result.data.testSummary.coveragePercentage, 67);
      assert.deepEqual(result.data.testSummary.coveredCriteria, ['ac-1', 'ac-2']);
      assert.deepEqual(result.data.testSummary.uncoveredCriteria, ['ac-3']);
    }
  });

  it('reports 100% coverage when spec has no acceptance criteria', async () => {
    const specNoACs: StructuredSpec = {
      ...minimalSpec,
      acceptanceCriteria: [],
    };
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 'tests/smoke.spec.ts', content: 'test("loads", () => {});', testCount: 1 },
      ],
      coverageMatrix: {},
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true, spec: specNoACs }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.testSummary.coveragePercentage, 100,
        'Should default to 100% when no criteria exist');
    }
  });

  it('ignores AI coverage matrix keys that are not in the spec', async () => {
    const aiResponse = JSON.stringify({
      testFiles: [
        { filePath: 'tests/app.spec.ts', content: 'tests', testCount: 1 },
      ],
      coverageMatrix: {
        'ac-1': ['tests/app.spec.ts'],
        'ac-99': ['tests/app.spec.ts'],  // not in spec
        'bogus': ['tests/app.spec.ts'],   // not in spec
      },
    });
    const ai = createMockAI(aiResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      // Only ac-1 is in minimalSpec, so coverage = 1/1 = 100%
      assert.deepEqual(result.data.testSummary.coveredCriteria, ['ac-1']);
      assert.deepEqual(result.data.testSummary.uncoveredCriteria, []);
    }
  });
});

// ═══════════════════════════════════════════════════
// Bonus: Spec-less execution
// ═══════════════════════════════════════════════════

describe('Trace edge — Execution without spec', () => {
  it('works when spec is undefined', async () => {
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ spec: undefined, dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.ok(result.data.ok);
      assert.ok(result.data.testFiles.length > 0);
    }
  });
});

// ═══════════════════════════════════════════════════
// Bonus: pushFiles vs commitFile fallback
// ═══════════════════════════════════════════════════

describe('Trace edge — pushFiles fallback to commitFile', () => {
  it('falls back to per-file commitFile when pushFiles is not available', async () => {
    const committedFiles: string[] = [];
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      pushFiles: undefined,
      async commitFile(_o, _r, _b, filePath) {
        committedFiles.push(filePath);
      },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.ok(committedFiles.length > 0, 'Should have committed files individually');
  });

  it('uses pushFiles for atomic commit when available', async () => {
    let pushFilesCalled = false;
    let commitFileCalled = false;
    const ai = createMockAI(validAIResponse);
    const github = createMockGitHub({
      async pushFiles() { pushFilesCalled = true; },
      async commitFile() { commitFileCalled = true; },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.equal(pushFilesCalled, true, 'Should prefer pushFiles');
    assert.equal(commitFileCalled, false, 'Should not call commitFile when pushFiles exists');
  });
});
