/**
 * PR-V-duplicate-repo (2026-05-20)
 *
 * Coverage for ProtoAgent's repo-name uniqueness guard. The bug being closed:
 * starting two chats with the same idea text used to produce the same Scribe
 * spec title → same kebab-case repo name → GitHub conflict on the second run
 * (or, worse, silent overwrite of the previous repo).
 *
 * The fix probes GitHub via `repoExists` BEFORE calling `createRepository`,
 * appending `-2`, `-3`, ... until a free slot is found. A legacy
 * attempt-create + catch-422 fallback covers adapters without the probe.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
const minValidFiles = [
  { filePath: 'package.json', content: '{"name":"app","scripts":{"dev":"vite"}}' },
  { filePath: 'index.html', content: '<div id="root"></div>' },
  { filePath: 'vite.config.js', content: 'export default {}' },
  { filePath: '.gitignore', content: 'node_modules' },
  { filePath: 'README.md', content: '# App' },
  {
    filePath: 'src/main.jsx',
    content: 'ReactDOM.createRoot(document.getElementById("root")).render(<App/>)',
  },
  {
    filePath: 'src/App.jsx',
    content: 'export default function App() { return <div>Hello</div>; }',
  },
  { filePath: 'src/App.css', content: 'body { margin: 0; }' },
];

function makeScaffoldResponse(
  files: Array<{ filePath: string; content: string; linesOfCode?: number }>
): string {
  return JSON.stringify({
    files: files.map((f) => ({
      filePath: f.filePath,
      content: f.content,
      linesOfCode: f.linesOfCode ?? f.content.split('\n').length,
    })),
    setupCommands: ['npm install', 'npm run dev'],
    metadata: {
      filesCreated: files.length,
      totalLinesOfCode: files.reduce(
        (s, f) => s + (f.linesOfCode ?? f.content.split('\n').length),
        0
      ),
      stackUsed: 'React + Vite',
    },
  });
}

function createMockAI(response: string): ProtoAIDeps {
  return {
    async generateText() {
      return response;
    },
  };
}

function noopGitHubDefaults(): Partial<ProtoGitHubDeps> {
  return {
    async createBranch() {},
    async commitFile() {},
    async createPR() {
      return { url: '' };
    },
  };
}

// ─── ensureUniqueRepoName helper (direct unit coverage) ──────────────────

describe('ProtoAgent.ensureUniqueRepoName — direct helper coverage', () => {
  it('returns the base name when GitHub reports it as free on the first probe', async () => {
    const probedNames: string[] = [];
    const github: ProtoGitHubDeps = {
      ...(noopGitHubDefaults() as ProtoGitHubDeps),
      async createRepository() {
        return { url: '' };
      },
      async repoExists(_owner: string, name: string) {
        probedNames.push(name);
        return false; // free
      },
    };
    const ai = createMockAI(makeScaffoldResponse(minValidFiles));
    const agent = new ProtoAgent(ai, github);

    const resolved = await agent.ensureUniqueRepoName('testuser', 'qr-kod-uretici');
    assert.equal(resolved, 'qr-kod-uretici');
    assert.deepEqual(probedNames, ['qr-kod-uretici']);
  });

  it('appends -2 / -3 suffixes until a free name is found', async () => {
    // First two probes report "exists"; third probe returns free.
    const probedNames: string[] = [];
    const responses = [true, true, false];
    const github: ProtoGitHubDeps = {
      ...(noopGitHubDefaults() as ProtoGitHubDeps),
      async createRepository() {
        return { url: '' };
      },
      async repoExists(_owner: string, name: string) {
        probedNames.push(name);
        return responses[probedNames.length - 1] ?? false;
      },
    };
    const ai = createMockAI(makeScaffoldResponse(minValidFiles));
    const agent = new ProtoAgent(ai, github);

    const resolved = await agent.ensureUniqueRepoName('testuser', 'qr-kod-uretici');
    assert.equal(resolved, 'qr-kod-uretici-3');
    assert.deepEqual(probedNames, ['qr-kod-uretici', 'qr-kod-uretici-2', 'qr-kod-uretici-3']);
  });

  it('returns the base name unchanged when the adapter has no repoExists capability', async () => {
    // No repoExists field — caller will fall back to attempt-create behavior.
    const github: ProtoGitHubDeps = {
      ...(noopGitHubDefaults() as ProtoGitHubDeps),
      async createRepository() {
        return { url: '' };
      },
    };
    const ai = createMockAI(makeScaffoldResponse(minValidFiles));
    const agent = new ProtoAgent(ai, github);

    const resolved = await agent.ensureUniqueRepoName('testuser', 'qr-kod-uretici');
    assert.equal(resolved, 'qr-kod-uretici');
  });

  it('treats repoExists errors as "occupied" and tries the next suffix', async () => {
    const probedNames: string[] = [];
    const github: ProtoGitHubDeps = {
      ...(noopGitHubDefaults() as ProtoGitHubDeps),
      async createRepository() {
        return { url: '' };
      },
      async repoExists(_owner: string, name: string) {
        probedNames.push(name);
        // First probe throws (treat as occupied), second probe returns free
        if (probedNames.length === 1) throw new Error('5xx transient');
        return false;
      },
    };
    const ai = createMockAI(makeScaffoldResponse(minValidFiles));
    const agent = new ProtoAgent(ai, github);

    const resolved = await agent.ensureUniqueRepoName('testuser', 'qr-kod-uretici');
    assert.equal(resolved, 'qr-kod-uretici-2');
    assert.deepEqual(probedNames, ['qr-kod-uretici', 'qr-kod-uretici-2']);
  });
});

// ─── End-to-end: createRepo + pushScaffoldFiles uses the resolved name ───

describe('ProtoAgent.pushScaffoldFiles — conflict resolution via repoExists', () => {
  it('creates "qr-kod-uretici-2" when "qr-kod-uretici" already exists on GitHub', async () => {
    const createdRepos: string[] = [];
    const probedNames: string[] = [];
    const pushedRepos: string[] = [];

    const github: ProtoGitHubDeps & { listFiles?: ProtoGitHubDeps['listFiles'] } = {
      ...(noopGitHubDefaults() as ProtoGitHubDeps),
      async repoExists(_owner: string, name: string) {
        probedNames.push(name);
        // First name is occupied, suffixed name is free.
        return name === 'qr-kod-uretici';
      },
      async createRepository(_owner: string, name: string) {
        createdRepos.push(name);
        return { url: `https://github.com/testuser/${name}` };
      },
      async pushFiles(_owner: string, repo: string) {
        pushedRepos.push(repo);
      },
      async listFiles(_owner: string, repo: string) {
        // verifyRepoPushed reads listFiles — return the pushed paths.
        if (pushedRepos.includes(repo)) {
          return minValidFiles.map((f) => f.filePath);
        }
        return [];
      },
    };

    const ai = createMockAI(makeScaffoldResponse(minValidFiles));
    const agent = new ProtoAgent(ai, github);

    const result = await agent.pushScaffoldFiles(
      'testuser',
      'qr-kod-uretici',
      'private',
      minValidFiles.map((f) => ({ ...f, linesOfCode: f.content.split('\n').length }))
    );

    assert.equal(result.type, 'output', `Expected success, got ${JSON.stringify(result)}`);
    if (result.type === 'output') {
      // Repo created under the suffixed name
      assert.deepEqual(createdRepos, ['qr-kod-uretici-2']);
      // Files were pushed to the suffixed repo, not the original
      assert.deepEqual(pushedRepos, ['qr-kod-uretici-2']);
      // ProtoOutput surfaces the resolved name in repo + URL
      assert.equal(result.data.repo, 'testuser/qr-kod-uretici-2');
      assert.equal(result.data.repoUrl, 'https://github.com/testuser/qr-kod-uretici-2');
    }
  });

  it('uses the base name when no conflict exists (first-attempt success)', async () => {
    const createdRepos: string[] = [];
    const pushedRepos: string[] = [];

    const github: ProtoGitHubDeps & { listFiles?: ProtoGitHubDeps['listFiles'] } = {
      ...(noopGitHubDefaults() as ProtoGitHubDeps),
      async repoExists() {
        return false; // always free
      },
      async createRepository(_owner: string, name: string) {
        createdRepos.push(name);
        return { url: `https://github.com/testuser/${name}` };
      },
      async pushFiles(_owner: string, repo: string) {
        pushedRepos.push(repo);
      },
      async listFiles() {
        return minValidFiles.map((f) => f.filePath);
      },
    };

    const ai = createMockAI(makeScaffoldResponse(minValidFiles));
    const agent = new ProtoAgent(ai, github);

    const result = await agent.pushScaffoldFiles(
      'testuser',
      'qr-kod-uretici',
      'private',
      minValidFiles.map((f) => ({ ...f, linesOfCode: f.content.split('\n').length }))
    );

    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.deepEqual(createdRepos, ['qr-kod-uretici']);
      assert.deepEqual(pushedRepos, ['qr-kod-uretici']);
      assert.equal(result.data.repo, 'testuser/qr-kod-uretici');
    }
  });

  it('legacy fallback: when repoExists is missing, retries createRepository with suffix on 422', async () => {
    const createdAttempts: string[] = [];
    const pushedRepos: string[] = [];

    const github: ProtoGitHubDeps & { listFiles?: ProtoGitHubDeps['listFiles'] } = {
      ...(noopGitHubDefaults() as ProtoGitHubDeps),
      // No repoExists → forces the catch-422 fallback.
      async createRepository(_owner: string, name: string) {
        createdAttempts.push(name);
        if (name === 'qr-kod-uretici') {
          throw new Error('Repository creation failed: name already exists on this account (422)');
        }
        return { url: `https://github.com/testuser/${name}` };
      },
      async pushFiles(_owner: string, repo: string) {
        pushedRepos.push(repo);
      },
      async listFiles() {
        return minValidFiles.map((f) => f.filePath);
      },
    };

    const ai = createMockAI(makeScaffoldResponse(minValidFiles));
    const agent = new ProtoAgent(ai, github);

    const result = await agent.pushScaffoldFiles(
      'testuser',
      'qr-kod-uretici',
      'private',
      minValidFiles.map((f) => ({ ...f, linesOfCode: f.content.split('\n').length }))
    );

    assert.equal(result.type, 'output', `Expected success, got ${JSON.stringify(result)}`);
    if (result.type === 'output') {
      assert.deepEqual(
        createdAttempts,
        ['qr-kod-uretici', 'qr-kod-uretici-2'],
        'should retry once with the suffixed name'
      );
      assert.deepEqual(pushedRepos, ['qr-kod-uretici-2']);
      assert.equal(result.data.repo, 'testuser/qr-kod-uretici-2');
    }
  });
});
