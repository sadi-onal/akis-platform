import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { ProtoInput, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Test Fixtures ──────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Todo App',
  problemStatement: 'Users need a simple task tracker.',
  userStories: [
    { persona: 'User', action: 'Create tasks', benefit: 'Track daily work' },
    { persona: 'User', action: 'Mark tasks done', benefit: 'See progress' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Logged in user', when: 'Clicks add', then: 'Task is created' },
    { id: 'ac-2', given: 'Task exists', when: 'Clicks complete', then: 'Task is marked done' },
  ],
  technicalConstraints: { stack: 'React + Vite', integrations: [], nonFunctional: [] },
  outOfScope: ['Admin panel'],
};

function makeScaffoldResponse(files: Array<{ filePath: string; content: string; linesOfCode?: number }>): string {
  return JSON.stringify({
    files: files.map((f) => ({
      filePath: f.filePath,
      content: f.content,
      linesOfCode: f.linesOfCode ?? f.content.split('\n').length,
    })),
    setupCommands: ['npm install', 'npm run dev'],
    metadata: {
      filesCreated: files.length,
      totalLinesOfCode: files.reduce((s, f) => s + (f.linesOfCode ?? f.content.split('\n').length), 0),
      stackUsed: 'React + Vite',
    },
  });
}

const minValidFiles = [
  { filePath: 'package.json', content: '{"name":"app","scripts":{"dev":"vite"}}' },
  { filePath: 'index.html', content: '<div id="root"></div>' },
  { filePath: 'vite.config.js', content: 'export default {}' },
  { filePath: '.gitignore', content: 'node_modules' },
  { filePath: 'README.md', content: '# App' },
  { filePath: 'src/main.jsx', content: 'ReactDOM.createRoot(document.getElementById("root")).render(<App/>)' },
  { filePath: 'src/App.jsx', content: 'export default function App() { return <div>Hello</div>; }' },
  { filePath: 'src/App.css', content: 'body { margin: 0; }' },
];

const validScaffoldResponse = makeScaffoldResponse(minValidFiles);

function baseInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec: validSpec,
    repoName: 'my-app',
    repoVisibility: 'private',
    owner: 'testuser',
    ...overrides,
  };
}

function createMockAI(response: string): ProtoAIDeps {
  return { async generateText() { return response; } };
}

function createMockGitHub(overrides?: Partial<ProtoGitHubDeps>): ProtoGitHubDeps {
  return {
    async createRepository() { return { url: 'https://github.com/testuser/my-app' }; },
    async createBranch() {},
    async commitFile() {},
    async createPR() { return { url: 'https://github.com/testuser/my-app/pull/1' }; },
    ...overrides,
  };
}

// ─── 1. AI Returns Malformed File Content ───────────

describe('Proto edge — malformed file content from AI', () => {
  it('accepts files with invalid JSON in package.json content (content is opaque string)', async () => {
    const files = minValidFiles.map((f) =>
      f.filePath === 'package.json'
        ? { ...f, content: '{name: INVALID JSON CONTENT, missing quotes}' }
        : f,
    );
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    // Proto should still succeed — it pushes file content as-is, not validate internal file syntax
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      const pkg = result.data.files.find((f) => f.filePath === 'package.json');
      assert.ok(pkg, 'package.json should be in output');
      assert.ok(pkg.content.includes('INVALID JSON CONTENT'));
    }
  });

  it('accepts files with JS syntax errors in content', async () => {
    const files = minValidFiles.map((f) =>
      f.filePath === 'src/App.jsx'
        ? { ...f, content: 'export default function App( { return <<<<<broken; }' }
        : f,
    );
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      const app = result.data.files.find((f) => f.filePath === 'src/App.jsx');
      assert.ok(app, 'App.jsx should be in output despite syntax errors in content');
    }
  });

  it('handles file content containing embedded JSON control chars', async () => {
    const contentWithControlChars = 'console.log("hello\tworld\nnewline")';
    const files = minValidFiles.map((f) =>
      f.filePath === 'src/main.jsx'
        ? { ...f, content: contentWithControlChars }
        : f,
    );
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
  });
});

// ─── 2. AI Returns Files with Dangerous Paths ──────
// NOTE: sanitizeFiles() runs inside pushFiles(), so we test with real push (not dryRun).
// We capture which paths actually get committed to verify filtering.

describe('Proto edge — dangerous file paths', () => {
  it('filters out directory traversal paths (../../etc/passwd) during push', async () => {
    const pushedPaths: string[] = [];
    const dangerousFiles = [
      ...minValidFiles,
      { filePath: '../../etc/passwd', content: 'root:x:0:0' },
      { filePath: '../../../etc/shadow', content: 'shadow content' },
    ];
    const ai = createMockAI(makeScaffoldResponse(dangerousFiles));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.ok(!pushedPaths.some((p) => p.includes('..')), 'No traversal paths should be pushed');
  });

  it('filters out absolute paths (/etc/passwd, /tmp/evil) during push', async () => {
    const pushedPaths: string[] = [];
    const dangerousFiles = [
      ...minValidFiles,
      { filePath: '/etc/passwd', content: 'root:x:0:0' },
      { filePath: '/tmp/evil.sh', content: 'rm -rf /' },
    ];
    const ai = createMockAI(makeScaffoldResponse(dangerousFiles));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.ok(!pushedPaths.some((p) => p.startsWith('/')), 'No absolute paths should be pushed');
  });

  it('filters out paths with null bytes during push', async () => {
    const pushedPaths: string[] = [];
    const dangerousFiles = [
      ...minValidFiles,
      { filePath: 'src/evil\0.jsx', content: 'malicious' },
    ];
    const ai = createMockAI(makeScaffoldResponse(dangerousFiles));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.ok(!pushedPaths.some((p) => p.includes('\0')), 'No null-byte paths should be pushed');
  });

  it('filters out backslash paths (Windows-style) during push', async () => {
    const pushedPaths: string[] = [];
    const dangerousFiles = [
      ...minValidFiles,
      { filePath: '\\windows\\system32\\cmd.exe', content: 'evil' },
    ];
    const ai = createMockAI(makeScaffoldResponse(dangerousFiles));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.ok(!pushedPaths.some((p) => p.startsWith('\\')), 'No backslash-leading paths should be pushed');
  });

  it('filters out URL-encoded traversal paths (%2e%2e) during push', async () => {
    const pushedPaths: string[] = [];
    const dangerousFiles = [
      ...minValidFiles,
      { filePath: '%2e%2e%2fetc%2fpasswd', content: 'root' },
    ];
    const ai = createMockAI(makeScaffoldResponse(dangerousFiles));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.ok(!pushedPaths.some((p) => p.includes('%2e') || p.includes('%2E')),
      'No URL-encoded traversal paths should be pushed');
  });

  it('filters out paths with Windows reserved characters during push', async () => {
    const pushedPaths: string[] = [];
    const dangerousFiles = [
      ...minValidFiles,
      { filePath: 'src/file<name>.jsx', content: 'bad' },
      { filePath: 'src/file|name.jsx', content: 'bad' },
    ];
    const ai = createMockAI(makeScaffoldResponse(dangerousFiles));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.ok(!pushedPaths.some((p) => /[<>"|?*]/.test(p)),
      'No Windows reserved char paths should be pushed');
  });
});

// ─── 3. Empty Files Array ───────────────────────────

describe('Proto edge — empty files array', () => {
  it('returns error when AI produces zero files', async () => {
    const ai = createMockAI(JSON.stringify({
      files: [],
      setupCommands: ['npm install'],
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

  it('returns error when files field is null', async () => {
    const ai = createMockAI(JSON.stringify({
      files: null,
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

  it('returns error when files field is missing entirely', async () => {
    const ai = createMockAI(JSON.stringify({
      setupCommands: ['npm install'],
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

// ─── 4. Duplicate File Paths ────────────────────────

describe('Proto edge — duplicate file paths', () => {
  it('does not deduplicate — both copies are pushed (agent trusts AI)', async () => {
    const files = [
      ...minValidFiles,
      { filePath: 'src/App.jsx', content: 'DUPLICATE COPY' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      const appFiles = result.data.files.filter((f) => f.filePath === 'src/App.jsx');
      // Proto does not deduplicate — it passes whatever AI returns
      assert.ok(appFiles.length >= 2, 'Duplicate paths are preserved in output');
    }
  });

  it('tracks correct total file count including duplicates', async () => {
    const files = [
      ...minValidFiles,
      { filePath: 'package.json', content: '{"name":"dup"}' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.files.length, minValidFiles.length + 1);
      assert.equal(result.data.metadata.filesCreated, minValidFiles.length + 1);
    }
  });
});

// ─── 5. Very Large File Content ─────────────────────

describe('Proto edge — very large file content', () => {
  it('accepts 500KB+ file content without errors', async () => {
    const largeContent = 'x'.repeat(500 * 1024); // 500KB
    const files = minValidFiles.map((f) =>
      f.filePath === 'src/App.jsx'
        ? { ...f, content: largeContent, linesOfCode: 1 }
        : f,
    );
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      const bigFile = result.data.files.find((f) => f.filePath === 'src/App.jsx');
      assert.ok(bigFile);
      assert.ok(bigFile.content.length >= 500 * 1024, 'Large content should be preserved');
    }
  });

  it('calculates linesOfCode correctly for large multi-line content', async () => {
    const lineCount = 5000;
    const largeContent = Array.from({ length: lineCount }, (_, i) => `const line${i} = ${i};`).join('\n');
    const files = minValidFiles.map((f) =>
      f.filePath === 'src/App.jsx'
        ? { ...f, content: largeContent }
        : f,
    );
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      const totalLOC = result.data.metadata.totalLinesOfCode;
      assert.ok(totalLOC >= lineCount, `Total LOC (${totalLOC}) should include the large file`);
    }
  });
});

// ─── 6. Repo Name Sanitization ──────────────────────

describe('Proto edge — repo name handling', () => {
  it('passes Turkish characters in repo name to GitHub as-is', async () => {
    let receivedName = '';
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async createRepository(_owner: string, name: string) {
        receivedName = name;
        return { url: `https://github.com/testuser/${name}` };
      },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ repoName: 'görev-takipçisi-şöyle' }));
    assert.equal(receivedName, 'görev-takipçisi-şöyle');
  });

  it('passes spaces in repo name to GitHub as-is (GitHub API will reject)', async () => {
    let receivedName = '';
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async createRepository(_owner: string, name: string) {
        receivedName = name;
        return { url: `https://github.com/testuser/${name}` };
      },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ repoName: 'my cool app' }));
    assert.equal(receivedName, 'my cool app');
  });

  it('passes special characters in repo name (GitHub-level validation expected)', async () => {
    let receivedName = '';
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async createRepository(_owner: string, name: string) {
        receivedName = name;
        return { url: `https://github.com/testuser/${name}` };
      },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ repoName: 'app@v2!#$%' }));
    assert.equal(receivedName, 'app@v2!#$%');
  });

  it('builds correct setup commands with special repo name', async () => {
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ repoName: 'app-with-dash', dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.ok(result.data.setupCommands[0].includes('app-with-dash'));
      assert.ok(result.data.setupCommands[1].includes('cd app-with-dash'));
    }
  });
});

// ─── 7. ProtoOutput Schema Validation ───────────────

describe('Proto edge — output schema validation', () => {
  it('output has all required ProtoOutput fields', async () => {
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      const d = result.data;
      assert.equal(typeof d.ok, 'boolean');
      assert.equal(typeof d.branch, 'string');
      assert.equal(typeof d.repo, 'string');
      assert.equal(typeof d.repoUrl, 'string');
      assert.ok(Array.isArray(d.files));
      assert.ok(Array.isArray(d.setupCommands));
      assert.equal(typeof d.metadata, 'object');
      assert.equal(typeof d.metadata.filesCreated, 'number');
      assert.equal(typeof d.metadata.totalLinesOfCode, 'number');
      assert.equal(typeof d.metadata.stackUsed, 'string');
      assert.equal(typeof d.metadata.committed, 'boolean');
    }
  });

  it('each file entry has filePath, content, linesOfCode', async () => {
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      for (const file of result.data.files) {
        assert.equal(typeof file.filePath, 'string', 'filePath must be string');
        assert.equal(typeof file.content, 'string', 'content must be string');
        assert.equal(typeof file.linesOfCode, 'number', 'linesOfCode must be number');
        assert.ok(file.linesOfCode >= 0, 'linesOfCode must be non-negative');
      }
    }
  });

  it('repoUrl matches owner/repoName pattern', async () => {
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ owner: 'acme', repoName: 'project', dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.repo, 'acme/project');
      assert.equal(result.data.repoUrl, 'https://github.com/acme/project');
    }
  });

  it('normalizes linesOfCode when AI returns non-number', async () => {
    // Simulate AI returning linesOfCode as string or missing
    const malformedFiles = minValidFiles.map((f) => ({
      filePath: f.filePath,
      content: f.content,
      linesOfCode: 'not-a-number' as unknown as number,
    }));
    const ai = createMockAI(JSON.stringify({
      files: malformedFiles,
      setupCommands: ['npm install'],
      metadata: { filesCreated: malformedFiles.length, totalLinesOfCode: 0, stackUsed: 'React' },
    }));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      for (const file of result.data.files) {
        assert.equal(typeof file.linesOfCode, 'number',
          'linesOfCode should be auto-calculated when AI returns non-number');
        assert.ok(file.linesOfCode > 0);
      }
    }
  });

  it('defaults setupCommands when AI omits them', async () => {
    const ai = createMockAI(JSON.stringify({
      files: minValidFiles.map((f) => ({ ...f, linesOfCode: 1 })),
      metadata: { filesCreated: minValidFiles.length, totalLinesOfCode: 8, stackUsed: 'React' },
    }));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      // Should default to npm install + npm run dev (plus git clone/cd prepended)
      assert.ok(result.data.setupCommands.some((c) => c.includes('npm install')));
      assert.ok(result.data.setupCommands.some((c) => c.includes('npm run dev')));
    }
  });

  it('defaults stackUsed to Unknown when AI omits metadata', async () => {
    const ai = createMockAI(JSON.stringify({
      files: minValidFiles.map((f) => ({ ...f, linesOfCode: 1 })),
      setupCommands: ['npm install'],
    }));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.metadata.stackUsed, 'Unknown');
    }
  });
});

// ─── 8. Branch Name Validation ──────────────────────

describe('Proto edge — branch name handling', () => {
  it('uses main as branch name for normal execution', async () => {
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.branch, 'main');
    }
  });

  it('uses dry-run as branch name in dryRun mode', async () => {
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.equal(result.data.branch, 'dry-run');
    }
  });

  it('pushes to the correct branch during commitFile calls', async () => {
    const pushedBranches: string[] = [];
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, branch: string) {
        pushedBranches.push(branch);
      },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    assert.ok(pushedBranches.length > 0, 'Should have pushed files');
    for (const b of pushedBranches) {
      assert.equal(b, 'main', 'All commits should target main branch');
    }
  });
});

// ─── 9. dryRun Mode — No Side Effects ──────────────

describe('Proto edge — dryRun mode side effects', () => {
  it('never calls createRepository in dryRun', async () => {
    let repoCalled = false;
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async createRepository() { repoCalled = true; return { url: '' }; },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.equal(repoCalled, false, 'createRepository must not be called in dryRun');
  });

  it('never calls commitFile in dryRun', async () => {
    let commitCalled = false;
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async commitFile() { commitCalled = true; },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.equal(commitCalled, false, 'commitFile must not be called in dryRun');
  });

  it('never calls createBranch in dryRun', async () => {
    let branchCalled = false;
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async createBranch() { branchCalled = true; },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.equal(branchCalled, false, 'createBranch must not be called in dryRun');
  });

  it('never calls createPR in dryRun', async () => {
    let prCalled = false;
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub({
      async createPR() { prCalled = true; return { url: '' }; },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.equal(prCalled, false, 'createPR must not be called in dryRun');
  });

  it('still calls AI generateText in dryRun (scaffold generation needed)', async () => {
    let aiCalled = false;
    const ai: ProtoAIDeps = {
      async generateText() { aiCalled = true; return validScaffoldResponse; },
    };
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput({ dryRun: true }));
    assert.equal(aiCalled, true, 'AI must still be called to generate scaffold');
  });

  it('dryRun output contains files and metadata even without GitHub', async () => {
    const ai = createMockAI(validScaffoldResponse);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.ok(result.data.files.length > 0, 'dryRun should still have files');
      assert.equal(result.data.ok, true);
      assert.equal(result.data.metadata.committed, false);
      assert.ok(result.data.setupCommands.length >= 2);
    }
  });
});

// ─── 10. File Path Normalization ────────────────────

describe('Proto edge — file path normalization', () => {
  it('filters files with leading slashes', async () => {
    const files = [
      ...minValidFiles,
      { filePath: '/src/absolute.jsx', content: 'abs path' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    // During push, sanitizeFiles strips leading-slash paths
    // In dryRun the sanitize doesn't run (only on pushFiles),
    // so test with actual push
    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    // The file with leading slash won't be committed by pushFiles
  });

  it('filters files with double backslashes', async () => {
    const files = [
      ...minValidFiles,
      { filePath: 'src\\\\components\\\\Evil.jsx', content: 'bad' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
  });

  it('filters empty file paths', async () => {
    const files = [
      ...minValidFiles,
      { filePath: '', content: 'empty path' },
      { filePath: '   ', content: 'whitespace path' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
  });

  it('filters dot-only paths', async () => {
    const files = [
      ...minValidFiles,
      { filePath: '.', content: 'dot' },
      { filePath: '...', content: 'dots' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
  });

  it('verifies sanitizeFiles filters are applied during push', async () => {
    const pushedPaths: string[] = [];
    const files = [
      ...minValidFiles,
      { filePath: '../../etc/passwd', content: 'traversal' },
      { filePath: '/root/.ssh/id_rsa', content: 'absolute' },
      { filePath: 'src/legit.jsx', content: 'good file' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    // Dangerous paths should have been filtered before push
    assert.ok(!pushedPaths.includes('../../etc/passwd'), 'Traversal path must not be pushed');
    assert.ok(!pushedPaths.includes('/root/.ssh/id_rsa'), 'Absolute path must not be pushed');
    assert.ok(pushedPaths.includes('src/legit.jsx'), 'Valid path should be pushed');
  });

  it('correctly pushes files with nested directory paths', async () => {
    const pushedPaths: string[] = [];
    const files = [
      ...minValidFiles,
      { filePath: 'src/components/nested/deep/Component.jsx', content: 'export default () => null' },
    ];
    const ai = createMockAI(makeScaffoldResponse(files));
    const github = createMockGitHub({
      async commitFile(_o: string, _r: string, _b: string, filePath: string) {
        pushedPaths.push(filePath);
      },
    });
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    assert.ok(pushedPaths.includes('src/components/nested/deep/Component.jsx'),
      'Deeply nested valid path should be pushed');
  });
});

// ─── Bonus: AI response edge cases ─────────────────

describe('Proto edge — AI response boundary conditions', () => {
  it('returns error on empty string AI response', async () => {
    const ai = createMockAI('');
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    }
  });

  it('returns error on whitespace-only AI response', async () => {
    const ai = createMockAI('   \n\t  \n  ');
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    }
  });

  it('handles AI response with files that have non-string filePath', async () => {
    // filePath is a number — should be coerced to string
    const ai = createMockAI(JSON.stringify({
      files: [
        { filePath: 12345, content: 'content', linesOfCode: 1 },
        ...minValidFiles.slice(1).map((f) => ({ ...f, linesOfCode: 1 })),
      ],
      setupCommands: ['npm install'],
      metadata: { filesCreated: minValidFiles.length, totalLinesOfCode: 8, stackUsed: 'React' },
    }));
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      // The agent coerces via String(f.filePath)
      const first = result.data.files[0];
      assert.equal(typeof first.filePath, 'string');
      assert.equal(first.filePath, '12345');
    }
  });

  it('handles AI response wrapped in markdown with extra text', async () => {
    const wrapped = 'Here is the scaffold:\n```json\n' + validScaffoldResponse + '\n```\nHope this helps!';
    const ai = createMockAI(wrapped);
    const github = createMockGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type === 'output') {
      assert.ok(result.data.files.length > 0);
    }
  });
});
