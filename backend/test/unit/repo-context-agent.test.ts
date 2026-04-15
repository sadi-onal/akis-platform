/**
 * Unit tests for RepoContextAgent.
 * Tests: file tree building, key file selection, language detection,
 * tech stack detection, AI summary parsing, content truncation, error handling.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { RepoContextAgent, type RepoContextAIDeps, type RepoContextGitHubDeps } from '../../src/pipeline/agents/repo-context/RepoContextAgent.js';

// ─── Test Fixtures ────────────────────────────────

const MOCK_FILE_LIST = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'src/index.ts',
  'src/app.ts',
  'src/utils/helpers.ts',
  'src/components/Button.tsx',
  'src/components/Header.tsx',
  'src/styles/global.css',
  'test/app.test.ts',
  '.gitignore',
  'vite.config.ts',
];

const MOCK_PACKAGE_JSON = JSON.stringify({
  name: 'test-app',
  version: '1.0.0',
  dependencies: {
    react: '^18.0.0',
    fastify: '^4.0.0',
  },
  devDependencies: {
    typescript: '^5.0.0',
    vite: '^5.0.0',
    vitest: '^1.0.0',
    tailwindcss: '^3.0.0',
  },
});

const MOCK_README = '# Test App\n\nA simple test application.\n';

const MOCK_AI_SUMMARY = JSON.stringify({
  summary: 'A React + Fastify full-stack application with TypeScript and Vite.',
  techStack: ['TypeScript', 'React', 'Fastify', 'Vite'],
  conventions: {
    language: 'TypeScript',
    style: 'functional components',
    testing: 'Vitest',
    patterns: ['component-based'],
  },
});

// ─── Mock Factories ──────────────────────────────

function createMockGitHub(
  files?: string[],
  fileContents?: Record<string, string>,
): RepoContextGitHubDeps {
  return {
    async listFiles(_owner: string, _repo: string, _branch: string) {
      return files ?? MOCK_FILE_LIST;
    },
    async getFileContent(_owner: string, _repo: string, _branch: string, filePath: string) {
      const contents: Record<string, string> = {
        'README.md': MOCK_README,
        'package.json': MOCK_PACKAGE_JSON,
        'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
        'src/index.ts': 'import { createApp } from "./app";\ncreateApp();\n',
        'src/app.ts': 'export function createApp() { return "hello"; }\n',
        ...fileContents,
      };
      const content = contents[filePath];
      if (!content) throw new Error(`File not found: ${filePath}`);
      return content;
    },
  };
}

function createMockAI(response?: string): RepoContextAIDeps {
  return {
    async generateText(_system: string, _user: string) {
      return response ?? MOCK_AI_SUMMARY;
    },
  };
}

function createFailingAI(): RepoContextAIDeps {
  return {
    async generateText() {
      throw new Error('AI service unavailable');
    },
  };
}

// ─── Tests ───────────────────────────────────────

describe('RepoContextAgent — fetchContext', () => {
  it('returns complete RepoContext with all fields', async () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const ctx = await agent.fetchContext({ owner: 'test', repo: 'my-app' });

    assert.equal(ctx.owner, 'test');
    assert.equal(ctx.repo, 'my-app');
    assert.equal(ctx.branch, 'main');
    assert.ok(ctx.fileTree.length > 0, 'fileTree should not be empty');
    assert.ok(ctx.summary.length > 0, 'summary should not be empty');
    assert.ok(Array.isArray(ctx.techStack), 'techStack should be an array');
    assert.ok(ctx.keyFiles.length > 0, 'keyFiles should not be empty');
    assert.ok(ctx.structure.totalFiles > 0, 'totalFiles should be > 0');
    assert.ok(ctx.fetchedAt, 'fetchedAt should be set');
  });

  it('uses custom branch when provided', async () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const ctx = await agent.fetchContext({ owner: 'test', repo: 'my-app', branch: 'develop' });

    assert.equal(ctx.branch, 'develop');
  });

  it('throws on GitHub listFiles failure', async () => {
    const failingGH: RepoContextGitHubDeps = {
      async listFiles() { throw new Error('403 Forbidden'); },
      async getFileContent() { return ''; },
    };
    const agent = new RepoContextAgent(createMockAI(), failingGH);

    await assert.rejects(
      () => agent.fetchContext({ owner: 'test', repo: 'private-repo' }),
      (err: Error) => {
        assert.ok(err.message.includes('dosya listesi alinamadi'));
        return true;
      },
    );
  });
});

describe('RepoContextAgent — buildTreeString', () => {
  it('produces a tree-like string with proper formatting', () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const tree = agent.buildTreeString(['src/index.ts', 'src/app.ts', 'README.md'], 3);

    assert.ok(tree.includes('src/'), 'tree should contain src/ directory');
    assert.ok(tree.includes('README.md'), 'tree should contain README.md');
    assert.ok(tree.includes('├── ') || tree.includes('└── '), 'tree should use tree connectors');
  });

  it('respects maxDepth limit', () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const deepFiles = [
      'a/b/c/d/deep.ts',
      'a/b/shallow.ts',
      'root.ts',
    ];
    const tree = agent.buildTreeString(deepFiles, 2);

    // maxDepth=2 means max path length = maxDepth+1 = 3 segments
    assert.ok(tree.includes('shallow.ts'), 'should include files within depth');
    assert.ok(!tree.includes('deep.ts'), 'should exclude files beyond depth');
  });
});

describe('RepoContextAgent — computeStructure', () => {
  it('correctly counts languages and directories', () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const structure = agent.computeStructure(MOCK_FILE_LIST);

    assert.equal(structure.totalFiles, MOCK_FILE_LIST.length);
    assert.ok(structure.languages['ts'] > 0, 'should detect TypeScript files');
    assert.ok(structure.languages['tsx'] > 0, 'should detect TSX files');
    assert.ok(structure.directories.includes('src'), 'should detect src directory');
    assert.ok(structure.directories.includes('test'), 'should detect test directory');
  });
});

describe('RepoContextAgent — AI fallback', () => {
  it('falls back to file-based tech stack detection when AI fails', async () => {
    const agent = new RepoContextAgent(createFailingAI(), createMockGitHub());
    const ctx = await agent.fetchContext({ owner: 'test', repo: 'my-app' });

    // Should still have a summary (fallback) and tech stack from package.json analysis
    assert.ok(ctx.summary.length > 0, 'fallback summary should exist');
    assert.ok(ctx.techStack.includes('React'), 'should detect React from package.json');
    assert.ok(ctx.techStack.includes('TypeScript'), 'should detect TypeScript');
    assert.ok(ctx.techStack.includes('Fastify'), 'should detect Fastify');
    assert.ok(ctx.techStack.includes('Vite'), 'should detect Vite');
    assert.ok(ctx.techStack.includes('Vitest'), 'should detect Vitest');
    assert.ok(ctx.techStack.includes('Tailwind CSS'), 'should detect Tailwind');
  });
});

describe('RepoContextAgent — content truncation', () => {
  it('truncates long files to max lines', () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const longContent = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    const truncated = agent.truncateContent(longContent, 500);

    const lines = truncated.split('\n');
    // 500 lines of content + 1 blank line + truncation notice
    assert.ok(lines.length <= 503, `truncated should have <= 503 lines, got ${lines.length}`);
    assert.ok(truncated.includes('truncated'), 'should include truncation notice');
    assert.ok(truncated.includes('500 more lines'), 'should mention how many lines were cut');
  });

  it('does not truncate short files', () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const shortContent = 'line 1\nline 2\nline 3';
    const result = agent.truncateContent(shortContent, 500);

    assert.equal(result, shortContent);
  });
});

describe('RepoContextAgent — key file selection', () => {
  it('prioritizes config files (README, package.json, tsconfig)', async () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const ctx = await agent.fetchContext({ owner: 'test', repo: 'my-app' });

    const paths = ctx.keyFiles.map((f) => f.path);
    assert.ok(paths.includes('README.md'), 'should include README.md');
    assert.ok(paths.includes('package.json'), 'should include package.json');
    assert.ok(paths.includes('tsconfig.json'), 'should include tsconfig.json');
  });

  it('includes entry point files', async () => {
    const agent = new RepoContextAgent(createMockAI(), createMockGitHub());
    const ctx = await agent.fetchContext({ owner: 'test', repo: 'my-app' });

    const paths = ctx.keyFiles.map((f) => f.path);
    assert.ok(paths.includes('src/index.ts'), 'should include src/index.ts entry point');
  });

  it('limits total key files to MAX_KEY_FILES', async () => {
    // Create a repo with lots of files
    const manyFiles = Array.from({ length: 50 }, (_, i) => `src/component-${i}.ts`);
    manyFiles.push('README.md', 'package.json', 'tsconfig.json');

    const agent = new RepoContextAgent(createMockAI(), createMockGitHub(manyFiles, {
      ...Object.fromEntries(manyFiles.map((f) => [f, `// ${f}`])),
    }));
    const ctx = await agent.fetchContext({ owner: 'test', repo: 'big-app' });

    assert.ok(ctx.keyFiles.length <= 10, `should have at most 10 key files, got ${ctx.keyFiles.length}`);
  });
});
