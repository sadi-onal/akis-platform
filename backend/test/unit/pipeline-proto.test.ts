import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type {
  ProtoInput,
  StructuredSpec,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import { GitHubTokenInvalidError } from '../../src/pipeline/core/contracts/PipelineErrors.js';

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
  ],
  technicalConstraints: {
    stack: 'React + Vite + TypeScript',
    integrations: ['Google OAuth'],
    nonFunctional: [],
  },
  outOfScope: ['Admin paneli'],
};

const scaffoldResponse = JSON.stringify({
  files: [
    { filePath: 'package.json', content: '{"name":"todo-app"}', linesOfCode: 1 },
    {
      filePath: 'src/App.tsx',
      content: 'export default function App() { return <div>Hello</div>; }',
      linesOfCode: 1,
    },
    { filePath: 'README.md', content: '# Todo App', linesOfCode: 1 },
  ],
  setupCommands: ['npm install', 'npm run dev'],
  metadata: {
    filesCreated: 3,
    totalLinesOfCode: 3,
    stackUsed: 'React + Vite + TypeScript',
  },
});

function baseInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec: validSpec,
    repoName: 'my-todo-app',
    repoVisibility: 'private',
    owner: 'testuser',
    ...overrides,
  };
}

// ─── Mock Factories ───────────────────────────────

function createMockAI(response: string): ProtoAIDeps {
  return {
    async generateText() {
      return response;
    },
  };
}

function createFailingAI(failCount: number, thenRespond: string): ProtoAIDeps {
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

function createMockGitHub(overrides?: Partial<ProtoGitHubDeps>): ProtoGitHubDeps {
  return {
    async createRepository() {
      return { url: 'https://github.com/testuser/my-todo-app' };
    },
    async createBranch() {},
    async commitFile() {},
    async createPR() {
      return { url: 'https://github.com/testuser/my-todo-app/pull/1' };
    },
    ...overrides,
  };
}

// ─── Scaffold Generation ──────────────────────────

describe('Proto — Scaffold generation', () => {
  it('generates scaffold from spec and pushes to GitHub', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.ok, true);
      assert.equal(result.data.repo, 'testuser/my-todo-app');
      assert.ok(result.data.repoUrl.includes('github.com'));
      assert.equal(result.data.branch, 'main');
      // F-08: ScaffoldEnricher adds install.sh + Dockerfile + docker-compose.yml +
      // .env.example to the AI's 3-file output (README is enriched in place).
      // Final = 3 (AI) + 4 (enrichment) = 7. Use ≥ to stay tolerant of future
      // additions to the portability layer.
      assert.ok(result.data.files.length >= 3, 'AI files should not be dropped');
      const paths = new Set(result.data.files.map((f) => f.filePath));
      assert.ok(paths.has('install.sh'), 'F-08: install.sh added');
      assert.ok(paths.has('.env.example'), 'F-08: .env.example added');
      assert.ok(result.data.setupCommands.length >= 3); // clone + cd + npm install + npm run dev
      assert.equal(result.data.metadata.committed, true);
      assert.equal(result.data.metadata.stackUsed, 'React + Vite + TypeScript');
    }
  });

  it('includes git clone in setup commands', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.ok(result.data.setupCommands[0].includes('git clone'));
      assert.ok(result.data.setupCommands[1].includes('cd my-todo-app'));
    }
  });

  it('pushes directly to main without creating PR', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      // PR is skipped when pushing directly to main
      assert.equal(result.data.prUrl, undefined);
      assert.equal(result.data.branch, 'main');
    }
  });
});

// ─── Dry Run ──────────────────────────────────────

describe('Proto — Dry run mode', () => {
  it('generates scaffold without GitHub operations', async () => {
    let githubCalled = false;
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async createRepository() {
        githubCalled = true;
        return { url: '' };
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(githubCalled, false);
    if (result.type === 'output') {
      assert.equal(result.data.branch, 'dry-run');
      assert.equal(result.data.metadata.committed, false);
      // F-08: dry-run also returns enriched files (install.sh + Docker + .env.example).
      assert.ok(result.data.files.length >= 3);
      const paths = new Set(result.data.files.map((f) => f.filePath));
      assert.ok(paths.has('install.sh'));
    }
  });
});

// ─── GitHub Error Handling ────────────────────────

describe('Proto — GitHub error handling', () => {
  it('PR-V-duplicate-repo: tries suffixed names when the base name is taken (attempt-create fallback)', async () => {
    // PR-V-duplicate-repo (2026-05-20): the previous behavior silently
    // continued on "already exists" and pushed to the EXISTING repo,
    // potentially overwriting the user's previous output. The new behavior
    // appends `-2` and retries; only if all suffix attempts fail do we
    // surface an error.
    const ai = createMockAI(scaffoldResponse);
    const attemptedNames: string[] = [];
    const github = createMockGitHub({
      async createRepository(_owner: string, name: string) {
        attemptedNames.push(name);
        // "base" + "base-2".."base-5" all collide → expect surfaced error
        throw new Error('Repository name already exists on this account (422)');
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    // Should NOT silently continue — the legacy "ok on 422" path was
    // actively dangerous (silent overwrite). Verify the suffix retries
    // actually happened, then confirm we surface a clean error.
    assert.ok(attemptedNames.length >= 2, 'should retry with at least one suffix');
    assert.equal(attemptedNames[0], 'my-todo-app');
    assert.equal(attemptedNames[1], 'my-todo-app-2');
    assert.equal(result.type, 'error');
  });

  it('PR-V-duplicate-repo: succeeds on suffixed name when base is taken (attempt-create fallback)', async () => {
    const ai = createMockAI(scaffoldResponse);
    const attemptedNames: string[] = [];
    const github = createMockGitHub({
      async createRepository(_owner: string, name: string) {
        attemptedNames.push(name);
        if (name === 'my-todo-app') {
          throw new Error('Repository name already exists on this account (422)');
        }
        // suffixed name succeeds
        return { url: `https://github.com/test/${name}` };
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.deepEqual(attemptedNames, ['my-todo-app', 'my-todo-app-2']);
    if (result.type === 'output') {
      // The resolved name flows through to the output's repo URL.
      assert.ok(
        result.data.repo.endsWith('/my-todo-app-2'),
        `expected repo to end with /my-todo-app-2, got ${result.data.repo}`
      );
    }
  });

  it('returns GITHUB_PERMISSION_DENIED on 403', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async createRepository() {
        throw new Error('Resource forbidden (403)');
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'GITHUB_PERMISSION_DENIED');
    }
  });

  it('returns GITHUB_NOT_CONNECTED on 401', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async createRepository() {
        throw new Error('unauthorized (401)');
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'GITHUB_NOT_CONNECTED');
    }
  });

  it('returns GITHUB_API_ERROR on generic failure', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async createRepository() {
        throw new Error('Internal server error');
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'GITHUB_API_ERROR');
      assert.equal(result.error.retryable, true);
    }
  });

  it('returns GITHUB_TOKEN_INVALID when adapter throws GitHubTokenInvalidError (issue #489 BUG-M)', async () => {
    // Regression guard for #489: the adapter in #487 throws GitHubTokenInvalidError
    // on POST /user/repos 404, but ProtoAgent used to fall back to substring
    // matching which masked the typed error as generic GITHUB_API_ERROR,
    // hiding the reconnect-github CTA the banner depends on.
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async createRepository() {
        throw new GitHubTokenInvalidError(
          'POST /user/repos returned 404 — OAuth token is invalid or expired'
        );
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'GITHUB_TOKEN_INVALID');
      assert.equal(result.error.recoveryAction, 'reconnect_github');
      assert.equal(result.error.retryable, false);
    }
  });

  it('returns PROTO_PUSH_FAILED when push fails after retries', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async commitFile() {
        throw new Error('Push rejected');
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'PROTO_PUSH_FAILED');
    }
  });

  it('continues even if PR creation fails', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async createPR() {
        throw new Error('PR creation failed');
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.ok, true);
      assert.equal(result.data.prUrl, undefined);
    }
  });
});

// ─── AI Error Handling ────────────────────────────

describe('Proto — AI error handling', () => {
  it('retries scaffold generation on AI failure', async () => {
    const ai = createFailingAI(1, scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
  });

  it('returns error after all AI retries exhausted', async () => {
    const ai = createFailingAI(10, scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    }
  });

  it('returns error on invalid AI JSON response', async () => {
    const ai = createMockAI('not json at all');
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    }
  });

  it('returns error when AI returns empty files array', async () => {
    const ai = createMockAI(
      JSON.stringify({
        files: [],
        setupCommands: [],
        metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'None' },
      })
    );
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    }
  });
});

// ─── JSON Extraction ──────────────────────────────

describe('Proto — JSON extraction', () => {
  it('handles fenced code block responses', async () => {
    const wrapped = '```json\n' + scaffoldResponse + '\n```';
    const ai = createMockAI(wrapped);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
  });
});
