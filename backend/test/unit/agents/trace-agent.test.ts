/**
 * TraceAgent comprehensive unit tests.
 *
 * Covers: test file generation, coverage matrix verification,
 * Gherkin/BDD output, GitHub codebase reading, dry-run mode,
 * and error recovery.
 *
 * These tests verify the "verification" phase of the pipeline —
 * Trace reads Proto's output and generates automated tests,
 * completing the knowledge integrity chain for the thesis.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TraceAgent,
  type TraceAIDeps,
  type TraceGitHubDeps,
} from '../../../src/pipeline/agents/trace/TraceAgent.js';
import type { TraceInput, StructuredSpec } from '../../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Fixtures ─────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Blog Platform',
  problemStatement: 'Kullanıcıların blog yazıları paylaşabilecekleri bir platform.',
  userStories: [
    { persona: 'Yazar', action: 'Blog yazısı oluşturma', benefit: 'Fikirlerimi paylaşmak' },
    { persona: 'Okuyucu', action: 'Blog yazılarını okuma', benefit: 'Bilgi edinmek' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Yazar giriş yapmışken', when: 'Yeni yazı oluşturur', then: 'Yazı kaydedilir' },
    { id: 'ac-2', given: 'Okuyucu ana sayfadayken', when: 'Bir yazıya tıklar', then: 'Yazı detayı açılır' },
  ],
  technicalConstraints: { stack: 'Next.js + PostgreSQL', integrations: ['Markdown editor'], nonFunctional: ['SEO'] },
  outOfScope: ['Yorum sistemi'],
};

const testGenResponse = JSON.stringify({
  testFiles: [
    {
      filePath: 'tests/e2e/blog.spec.ts',
      content: 'import { test, expect } from "@playwright/test";\n\ntest("create post", async ({ page }) => {\n  await page.goto("/");\n});\ntest("read post", async ({ page }) => {\n  await page.goto("/posts/1");\n});',
      testCount: 2,
    },
    {
      filePath: 'tests/page-objects/BlogPage.ts',
      content: 'export class BlogPage { constructor(public page: any) {} }',
      testCount: 0,
    },
    {
      filePath: 'playwright.config.ts',
      content: 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({});',
      testCount: 0,
    },
  ],
  coverageMatrix: {
    'ac-1': ['tests/e2e/blog.spec.ts'],
    'ac-2': ['tests/e2e/blog.spec.ts'],
  },
  testSummary: {
    totalTests: 2,
    frameworks: ['playwright'],
    coverageRatio: 1.0,
  },
});

function baseInput(overrides?: Partial<TraceInput>): TraceInput {
  return {
    repoOwner: 'testuser',
    repo: 'blog-platform',
    branch: 'main',
    spec: validSpec,
    ...overrides,
  };
}

// ─── Mock Factories ───────────────────────────────

function createMockAI(response: string): TraceAIDeps {
  return { generateText: async () => response };
}

function createFailingAI(error: Error): TraceAIDeps {
  return { generateText: async () => { throw error; } };
}

const MOCK_FILES = [
  'package.json',
  'src/index.ts',
  'src/pages/Home.tsx',
  'src/components/PostList.tsx',
  'README.md',
  '.gitignore',
];

const MOCK_FILE_CONTENTS: Record<string, string> = {
  'package.json': '{"name":"blog-platform","dependencies":{"next":"14"}}',
  'src/index.ts': 'import express from "express";\nconst app = express();\napp.listen(3000);',
  'src/pages/Home.tsx': 'export default function Home() { return <h1>Blog</h1>; }',
  'src/components/PostList.tsx': 'export function PostList({ posts }) { return posts.map(p => <div key={p.id}>{p.title}</div>); }',
  'README.md': '# Blog Platform\nA simple blog.',
  '.gitignore': 'node_modules\n.env',
};

function createMockGitHub(overrides?: Partial<TraceGitHubDeps>): TraceGitHubDeps & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    listFiles: [], getFileContent: [], commitFile: [], pushFiles: [], createBranch: [], createPR: [],
  };
  return {
    calls,
    listFiles: async (...args: unknown[]) => { calls.listFiles.push(args); return MOCK_FILES; },
    getFileContent: async (_o: string, _r: string, _b: string, path: string) => {
      calls.getFileContent.push([_o, _r, _b, path]);
      return MOCK_FILE_CONTENTS[path] ?? '';
    },
    commitFile: async (...args: unknown[]) => { calls.commitFile.push(args); },
    pushFiles: async (...args: unknown[]) => { calls.pushFiles.push(args); },
    createBranch: async (...args: unknown[]) => { calls.createBranch.push(args); },
    createPR: async (...args: unknown[]) => { calls.createPR.push(args); return { url: 'https://github.com/testuser/blog-platform/pull/1' }; },
    ...overrides,
  };
}

// ─── Test File Generation ─────────────────────────

describe('TraceAgent — Test File Generation', () => {
  it('generates Playwright test files', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    assert.ok(result.data.ok, 'Should succeed');
    assert.ok(result.data.testFiles.length > 0, 'Should have test files');
  });

  it('includes .spec.ts test files', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const specFiles = result.data.testFiles.filter(f => f.filePath.includes('.spec.'));
    assert.ok(specFiles.length > 0, 'Should have .spec.ts files');
  });

  it('includes page object files', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const poFiles = result.data.testFiles.filter(f => f.filePath.includes('page-objects'));
    assert.ok(poFiles.length > 0, 'Should have page object files');
  });
});

// ─── Coverage Matrix ──────────────────────────────

describe('TraceAgent — Coverage Matrix Verification', () => {
  it('maps acceptance criteria to test files', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const matrix = result.data.coverageMatrix;
    assert.ok(matrix, 'Should have coverage matrix');
    assert.ok('ac-1' in matrix, 'Should cover ac-1');
    assert.ok('ac-2' in matrix, 'Should cover ac-2');
  });

  it('each AC maps to at least one test file', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    for (const [acId, files] of Object.entries(result.data.coverageMatrix)) {
      assert.ok(Array.isArray(files), `${acId} should map to array`);
      assert.ok(files.length > 0, `${acId} should have at least one test file`);
    }
  });

  it('includes test summary with totalTests', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    assert.ok(result.data.testSummary, 'Should have testSummary');
    assert.ok(result.data.testSummary.totalTests > 0, 'totalTests > 0');
  });
});

// ─── Codebase Reading ─────────────────────────────

describe('TraceAgent — GitHub Codebase Reading', () => {
  it('reads source files from GitHub', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    await agent.execute(baseInput());
    assert.ok(github.calls.listFiles.length > 0, 'Should call listFiles');
    assert.ok(github.calls.getFileContent.length > 0, 'Should call getFileContent');
  });

  it('filters out non-source files', async () => {
    const filesWithExcludes = [
      ...MOCK_FILES,
      'node_modules/express/index.js',
      '.git/HEAD',
      'dist/bundle.js',
      'package-lock.json',
    ];
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      listFiles: async () => filesWithExcludes,
    });
    const agent = new TraceAgent(ai, github);

    await agent.execute(baseInput());
    const readPaths = github.calls.getFileContent.map(c => c[3] as string);
    assert.ok(!readPaths.some(p => p.includes('node_modules')), 'Should not read node_modules');
    assert.ok(!readPaths.some(p => p.includes('.git/')), 'Should not read .git');
  });
});

// ─── Dry Run Mode ─────────────────────────────────

describe('TraceAgent — Dry Run', () => {
  it('does not push files in dry run', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(github.calls.pushFiles.length, 0, 'Should NOT push files');
    assert.equal(github.calls.commitFile.length, 0, 'Should NOT commit files');
  });

  it('still generates test data in dry run', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    assert.ok(result.data.testFiles.length > 0, 'Should still have test files');
  });
});

// ─── Error Handling ───────────────────────────────

describe('TraceAgent — Error Recovery', () => {
  it('returns error on AI failure', async () => {
    const ai = createFailingAI(new Error('AI timeout'));
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
  });

  it('returns error when codebase is empty', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      listFiles: async () => [],
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.ok(result.error.message, 'Should have error message');
  });

  it('returns error on empty testFiles', async () => {
    const emptyTests = JSON.stringify({
      testFiles: [],
      coverageMatrix: {},
      testSummary: { totalTests: 0, frameworks: [] },
    });
    const ai = createMockAI(emptyTests);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
  });

  it('handles JSON wrapped in ```json fences', async () => {
    const fenced = '```json\n' + testGenResponse + '\n```';
    const ai = createMockAI(fenced);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
  });

  it('handles PR creation failure gracefully (non-fatal)', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub({
      createPR: async () => { throw new Error('PR creation failed'); },
    });
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    // PR failure should not fail the whole process
    assert.equal(result.type, 'output');
  });
});

// ─── Test Summary ─────────────────────────────────

describe('TraceAgent — Test Summary Format', () => {
  it('includes frameworks list', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const summary = result.data.testSummary;
    assert.ok(Array.isArray(summary.frameworks), 'frameworks should be array');
    assert.ok(summary.frameworks.includes('playwright'), 'Should include playwright');
  });

  it('reports accurate totalTests count', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    assert.equal(result.data.testSummary.totalTests, 2);
  });
});

// ─── Cucumber/BDD Toggle (issue #397) ─────────────

describe('TraceAgent — Cucumber/BDD toggle', () => {
  it('skips Gherkin generation when cucumberEnabled is false (legacy path, dryRun)', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true, cucumberEnabled: false }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    assert.equal(result.data.gherkinFeatures?.length ?? 0, 0);
    assert.equal(result.data.stepDefinitions?.length ?? 0, 0);
  });

  it('skips Gherkin generation when cucumberEnabled is undefined', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    assert.equal(result.data.gherkinFeatures?.length ?? 0, 0);
  });

  it('generates Gherkin features + step defs when cucumberEnabled is true (legacy path, dryRun)', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true, cucumberEnabled: true }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    assert.ok((result.data.gherkinFeatures?.length ?? 0) > 0, 'should emit .feature files');
    assert.ok((result.data.stepDefinitions?.length ?? 0) > 0, 'should emit .steps.ts files');
  });

  it('skips Gherkin when spec is missing even if cucumberEnabled is true', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true, cucumberEnabled: true, spec: undefined }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    assert.equal(result.data.gherkinFeatures?.length ?? 0, 0);
  });

  it('pushes Gherkin files alongside Playwright tests when cucumberEnabled is true', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ cucumberEnabled: true }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    // Find the push call that included the test files — it should also
    // carry the .feature + .steps.ts files generated from the spec.
    const pushFlatFiles = github.calls.pushFiles.flatMap((c) => (c[3] as Array<{ path: string }>).map((f) => f.path));
    assert.ok(pushFlatFiles.some((p) => p.endsWith('.feature')), 'expected a .feature file in push');
    assert.ok(pushFlatFiles.some((p) => p.endsWith('.steps.ts')), 'expected a .steps.ts file in push');
  });

  it('does NOT push .feature files when cucumberEnabled is false', async () => {
    const ai = createMockAI(testGenResponse);
    const github = createMockGitHub();
    const agent = new TraceAgent(ai, github);

    const result = await agent.execute(baseInput({ cucumberEnabled: false }));
    assert.equal(result.type, 'output');
    const pushFlatFiles = github.calls.pushFiles.flatMap((c) => (c[3] as Array<{ path: string }>).map((f) => f.path));
    assert.ok(!pushFlatFiles.some((p) => p.endsWith('.feature')), '.feature file must not leak through when toggle is off');
    assert.ok(!pushFlatFiles.some((p) => p.endsWith('.steps.ts')), '.steps.ts file must not leak through when toggle is off');
  });
});
