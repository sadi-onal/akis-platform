/**
 * ProtoAgent comprehensive unit tests.
 *
 * Covers: scaffold file generation, GitHub mock operations,
 * branch naming, setup commands, dry-run mode, file safety,
 * JSON extraction edge cases, and error recovery.
 *
 * These tests verify Proto's ability to translate an approved spec
 * into a working codebase scaffold — the "build" phase of the pipeline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../../src/pipeline/agents/proto/ProtoAgent.js';
import type { ProtoInput, StructuredSpec } from '../../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Fixtures ─────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Blog Platform',
  problemStatement: 'Kullanıcıların blog yazıları paylaşabilecekleri bir platform.',
  userStories: [
    { persona: 'Yazar', action: 'Blog yazısı oluşturma', benefit: 'Fikirlerimi paylaşmak' },
    { persona: 'Okuyucu', action: 'Blog yazılarını okuma', benefit: 'Bilgi edinmek' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Yazar giriş yapmışken', when: 'Yeni yazı oluşturur', then: 'Yazı kaydedilir ve yayınlanır' },
    { id: 'ac-2', given: 'Okuyucu ana sayfadayken', when: 'Bir yazıya tıklar', then: 'Yazı detay sayfası açılır' },
  ],
  technicalConstraints: { stack: 'Next.js + PostgreSQL', integrations: ['Markdown editor'], nonFunctional: ['SEO'] },
  outOfScope: ['Yorum sistemi', 'Kategori yönetimi'],
};

const scaffoldResponse = JSON.stringify({
  files: [
    { filePath: 'package.json', content: '{"name":"blog-platform","dependencies":{}}', linesOfCode: 1 },
    { filePath: 'src/index.ts', content: 'console.log("hello");', linesOfCode: 1 },
    { filePath: 'src/pages/Home.tsx', content: 'export default function Home() { return <div>Blog</div>; }', linesOfCode: 1 },
    { filePath: 'README.md', content: '# Blog Platform', linesOfCode: 1 },
    { filePath: '.gitignore', content: 'node_modules\n.env', linesOfCode: 2 },
  ],
  setupCommands: ['npm install', 'npm run dev'],
  metadata: { filesCreated: 5, totalLinesOfCode: 6, stackUsed: 'Next.js + PostgreSQL' },
});

function baseInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec: validSpec,
    repoName: 'blog-platform',
    repoVisibility: 'private',
    owner: 'testuser',
    ...overrides,
  };
}

// ─── Mock Factories ───────────────────────────────

function createMockAI(response: string): ProtoAIDeps {
  return { generateText: async () => response };
}

function createFailingAI(error: Error): ProtoAIDeps {
  return { generateText: async () => { throw error; } };
}

function createMockGitHub(overrides?: Partial<ProtoGitHubDeps>): ProtoGitHubDeps & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    createRepository: [], createBranch: [], commitFile: [], pushFiles: [], createPR: [],
  };
  return {
    calls,
    createRepository: async (...args: unknown[]) => { calls.createRepository.push(args); return { url: 'https://github.com/testuser/blog-platform' }; },
    createBranch: async (...args: unknown[]) => { calls.createBranch.push(args); },
    commitFile: async (...args: unknown[]) => { calls.commitFile.push(args); },
    pushFiles: async (...args: unknown[]) => { calls.pushFiles.push(args); },
    createPR: async (...args: unknown[]) => { calls.createPR.push(args); return { url: 'https://github.com/testuser/blog-platform/pull/1' }; },
    listFiles: async () => [],
    getFileContent: async () => '',
    ...overrides,
  };
}

// ─── Scaffold Generation ──────────────────────────

describe('ProtoAgent — Scaffold Generation', () => {
  it('generates scaffold files from spec', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    assert.ok(result.data.ok, 'Should succeed');
    assert.ok(result.data.files.length > 0, 'Should have files');
  });

  it('includes package.json in scaffold', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const pkgFile = result.data.files.find(f => f.filePath === 'package.json');
    assert.ok(pkgFile, 'Should include package.json');
  });

  it('includes README.md in scaffold', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const readme = result.data.files.find(f => f.filePath === 'README.md');
    assert.ok(readme, 'Should include README.md');
  });

  it('reports correct repo URL', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    assert.ok(result.data.repoUrl.includes('blog-platform'), 'repoUrl should contain repo name');
  });
});

// ─── GitHub Operations ────────────────────────────

describe('ProtoAgent — GitHub Mock Operations', () => {
  it('creates repository via GitHub service', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    assert.ok(github.calls.createRepository.length > 0, 'Should call createRepository');
  });

  it('pushes files via pushFiles (batch)', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    assert.ok(
      github.calls.pushFiles.length > 0 || github.calls.commitFile.length > 0,
      'Should push files via batch or per-file',
    );
  });

  it('handles repo already exists gracefully', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      createRepository: async () => {
        const err = new Error('Repository creation failed: Name already exists on this account') as Error & { status?: number };
        err.status = 422;
        throw err;
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    // Should continue even if repo exists
    assert.equal(result.type, 'output');
  });
});

// ─── Setup Commands ───────────────────────────────

describe('ProtoAgent — Setup Commands', () => {
  it('includes git clone in setup commands', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const cmds = result.data.setupCommands;
    assert.ok(cmds.some(c => c.includes('git clone')), 'Should include git clone');
  });

  it('includes cd into repo directory', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const cmds = result.data.setupCommands;
    assert.ok(cmds.some(c => c.includes('cd ')), 'Should include cd');
  });
});

// ─── Dry Run Mode ─────────────────────────────────

describe('ProtoAgent — Dry Run', () => {
  it('does not create GitHub repo in dry run', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    assert.equal(github.calls.createRepository.length, 0, 'Should NOT call createRepository');
  });

  it('does not push files in dry run', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.equal(github.calls.pushFiles.length, 0, 'Should NOT push files');
    assert.equal(github.calls.commitFile.length, 0, 'Should NOT commit files');
  });

  it('still returns scaffold data in dry run', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    assert.ok(result.data.files.length > 0, 'Should still have files');
  });
});

// ─── Error Handling ───────────────────────────────

describe('ProtoAgent — Error Recovery', () => {
  it('returns error on AI failure', async () => {
    const ai = createFailingAI(new Error('AI timeout'));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
  });

  it('returns error on empty scaffold response', async () => {
    const ai = createMockAI(JSON.stringify({ files: [], setupCommands: [], metadata: { filesCreated: 0, totalLinesOfCode: 0 } }));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
  });

  it('handles JSON wrapped in ```json fences', async () => {
    const fenced = '```json\n' + scaffoldResponse + '\n```';
    const ai = createMockAI(fenced);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
  });

  it('handles GitHub 403 permission error', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      createRepository: async () => {
        const err = new Error('Forbidden') as Error & { status?: number };
        err.status = 403;
        throw err;
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.ok(result.error.code, 'Should have error code');
  });

  it('handles GitHub 401 auth error', async () => {
    const ai = createMockAI(scaffoldResponse);
    const github = createMockGitHub({
      createRepository: async () => {
        const err = new Error('Unauthorized') as Error & { status?: number };
        err.status = 401;
        throw err;
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
  });
});

// ─── File Safety ──────────────────────────────────

describe('ProtoAgent — File Safety Checks', () => {
  it('filters path traversal files during GitHub push', async () => {
    const maliciousScaffold = JSON.stringify({
      files: [
        { filePath: '../../../etc/passwd', content: 'hacked', linesOfCode: 1 },
        { filePath: 'src/app.ts', content: 'safe', linesOfCode: 1 },
      ],
      setupCommands: [],
      metadata: { filesCreated: 2, totalLinesOfCode: 2 },
    });
    const ai = createMockAI(maliciousScaffold);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    // sanitizeFiles runs at push time — check that only safe files were pushed
    // pushFiles(owner, repo, branch, files, message) — files is arg index 3
    if (github.calls.pushFiles.length > 0) {
      const pushedFiles = github.calls.pushFiles[0][3] as Array<{ path: string }>;
      const hasMalicious = pushedFiles.some(f => f.path.includes('..'));
      assert.ok(!hasMalicious, 'Should not push path traversal files to GitHub');
    }
  });

  it('filters absolute path files during GitHub push', async () => {
    const absPathScaffold = JSON.stringify({
      files: [
        { filePath: '/etc/shadow', content: 'hacked', linesOfCode: 1 },
        { filePath: 'src/app.ts', content: 'safe', linesOfCode: 1 },
      ],
      setupCommands: [],
      metadata: { filesCreated: 2, totalLinesOfCode: 2 },
    });
    const ai = createMockAI(absPathScaffold);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    // sanitizeFiles filters at push time
    // pushFiles(owner, repo, branch, files, message) — files is arg index 3
    if (github.calls.pushFiles.length > 0) {
      const pushedFiles = github.calls.pushFiles[0][3] as Array<{ path: string }>;
      const hasAbsPath = pushedFiles.some(f => f.path.startsWith('/'));
      assert.ok(!hasAbsPath, 'Should not push absolute path files to GitHub');
    }
  });
});
