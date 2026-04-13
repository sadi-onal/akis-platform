import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { ProtoInput, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Test Fixtures ────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Todo App with Google Auth',
  problemStatement: 'Kullanıcıların günlük görevlerini takip edebilecekleri basit bir uygulama.',
  userStories: [
    { persona: 'Kayıtlı kullanıcı', action: 'Yeni görev oluşturma', benefit: 'Görevlerimi takip etmek' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Giriş yapmış kullanıcı', when: 'Görev ekle butonuna tıklarsa', then: 'Yeni görev oluşur' },
  ],
  technicalConstraints: { stack: 'React + Vite + TypeScript', integrations: ['Google OAuth'], nonFunctional: [] },
  outOfScope: ['Admin paneli'],
};

const scaffoldResponse = JSON.stringify({
  files: [
    { filePath: 'package.json', content: '{"name":"todo-app"}', linesOfCode: 1 },
    { filePath: 'src/App.tsx', content: 'export default function App() { return <div>Hello</div>; }', linesOfCode: 1 },
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
      assert.equal(result.data.files.length, 3);
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
      assert.equal(result.data.files.length, 3);
    }
  });
});

// ─── GitHub Error Handling ────────────────────────

describe('Proto — GitHub error handling', () => {
  it('continues when repo already exists', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      async createRepository() {
        throw new Error('Repository name already exists on this account');
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
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
    const ai = createMockAI(JSON.stringify({
      files: [],
      setupCommands: [],
      metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'None' },
    }));
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
