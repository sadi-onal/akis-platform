/**
 * Proto enriched-output integration test — F-08 / FR-6.5..6.8.
 *
 * Runs ProtoAgent's legacy text-generation path with a mock AI + mock GitHub
 * adapter and asserts the files that would be pushed include the bakkal
 * portability layer:
 *
 *   - install.sh with the AKIS header comment
 *   - README.md with all three Turkish bakkal sections
 *   - .env.example with Turkish per-line comments
 *   - Dockerfile + docker-compose.yml (default-on for node stack)
 *
 * Doesn't require Postgres — uses the dryRun=false path with the mock GitHub
 * adapter capturing the pushFiles call. Lives under integration/ because it
 * stitches Proto + Enricher + GitHub adapter together (cross-module flow),
 * not because it touches a DB.
 *
 * Run: pnpm -C backend test:integration
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { ProtoInput, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';

const spec: StructuredSpec = {
  title: 'Veresiye Defteri',
  problemStatement: 'Bakkal sahibinin müşteri borç takibini dijitalleştirmek.',
  userStories: [
    { persona: 'Bakkal sahibi', action: 'Müşteri borcu eklemek', benefit: 'Defter tutmaktan kurtulmak' },
    { persona: 'Bakkal sahibi', action: 'Borç ödendi olarak işaretlemek', benefit: 'Geçmişi görebilmek' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Bakkal panelde', when: 'Yeni borç ekler', then: 'Borç kaydedilir ve listede görünür' },
  ],
  technicalConstraints: { stack: 'React + Vite', integrations: [], nonFunctional: [] },
  outOfScope: [],
};

// AI returns a minimal-but-valid React + Vite scaffold.
const aiResponse = JSON.stringify({
  files: [
    { filePath: 'package.json', content: '{"name":"veresiye","scripts":{"dev":"vite"}}', linesOfCode: 1 },
    { filePath: 'index.html', content: '<!doctype html><html><body><div id="root"></div></body></html>', linesOfCode: 1 },
    { filePath: 'src/main.jsx', content: 'console.log("hi");', linesOfCode: 1 },
    { filePath: 'src/App.jsx', content: 'export default function App(){return <div>Hi</div>;}', linesOfCode: 1 },
    { filePath: 'src/App.css', content: 'body{}', linesOfCode: 1 },
    { filePath: '.gitignore', content: 'node_modules\n.env\n', linesOfCode: 2 },
  ],
  setupCommands: ['npm install', 'npm run dev'],
  metadata: { filesCreated: 6, totalLinesOfCode: 7, stackUsed: 'React + Vite' },
});

function createMockAI(response: string): ProtoAIDeps {
  return { generateText: async () => response };
}

function createCapturingGitHub(): ProtoGitHubDeps & {
  capturedPush?: { owner: string; repo: string; branch: string; files: Array<{ path: string; content: string }> };
} {
  const out: ProtoGitHubDeps & {
    capturedPush?: { owner: string; repo: string; branch: string; files: Array<{ path: string; content: string }> };
  } = {
    createRepository: async () => ({ url: 'https://github.com/testuser/veresiye' }),
    createBranch: async () => {},
    commitFile: async () => {},
    pushFiles: async (owner, repo, branch, files) => {
      out.capturedPush = { owner, repo, branch, files: [...files] };
    },
    createPR: async () => ({ url: 'https://github.com/testuser/veresiye/pull/1' }),
    listFiles: async () => [
      'package.json', 'index.html', 'src/main.jsx', 'src/App.jsx', 'src/App.css', '.gitignore',
      'install.sh', 'README.md', '.env.example', 'Dockerfile', 'docker-compose.yml',
    ],
  };
  return out;
}

function baseInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec,
    repoName: 'veresiye',
    repoVisibility: 'private',
    owner: 'testuser',
    ...overrides,
  };
}

describe('ProtoAgent + ScaffoldEnricher integration (F-08)', () => {
  it('legacy execute() pushes enriched files including install.sh', async () => {
    const ai = createMockAI(aiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const pushed = github.capturedPush;
    assert.ok(pushed, 'pushFiles should have been called');
    const pathSet = new Set(pushed.files.map((f) => f.path));

    assert.ok(pathSet.has('install.sh'), 'install.sh should be in the push payload');
    assert.ok(pathSet.has('README.md'), 'README.md should be in the push payload');
    assert.ok(pathSet.has('.env.example'), '.env.example should be in the push payload');
    assert.ok(pathSet.has('Dockerfile'), 'Dockerfile should be in the push payload (node stack default)');
    assert.ok(pathSet.has('docker-compose.yml'), 'compose should be in the push payload');
  });

  it('install.sh contains AKIS header and npm dev command', async () => {
    const ai = createMockAI(aiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    const sh = github.capturedPush?.files.find((f) => f.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /Bu komut dosyası AKIS tarafından üretildi/);
    assert.match(sh.content, /npm install/);
    assert.match(sh.content, /npm run dev/);
  });

  it('README.md contains all three Turkish bakkal sections', async () => {
    const ai = createMockAI(aiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    const readme = github.capturedPush?.files.find((f) => f.path === 'README.md');
    assert.ok(readme);
    assert.match(readme.content, /## Bu projeyi kendi bilgisayarında çalıştır/);
    assert.match(readme.content, /## Sunucuya kur/);
    assert.match(readme.content, /## GitHub'da gör/);
  });

  it('.env.example contains Turkish per-line comments', async () => {
    const ai = createMockAI(aiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(baseInput());
    const envExample = github.capturedPush?.files.find((f) => f.path === '.env.example');
    assert.ok(envExample);
    assert.match(envExample.content, /# bu değer:/);
    assert.match(envExample.content, /PORT=/);
  });

  it('output.files reports the enriched count (>= AI-generated count)', async () => {
    const ai = createMockAI(aiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    // AI returned 6 files; enrichment adds install.sh + README + Dockerfile +
    // docker-compose.yml + .env.example = 5 more (README replaces nothing
    // because AI didn't include one in this fixture).
    assert.ok(result.data.files.length >= 6, 'enriched count should not drop AI files');
    const enrichedPaths = new Set(result.data.files.map((f) => f.filePath));
    assert.ok(enrichedPaths.has('install.sh'));
    assert.ok(enrichedPaths.has('README.md'));
    assert.ok(enrichedPaths.has('.env.example'));
  });

  it('dryRun mode also returns enriched files (no push happens)', async () => {
    const ai = createMockAI(aiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(baseInput({ dryRun: true }));
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;
    assert.equal(github.capturedPush, undefined, 'no push in dryRun');

    const paths = new Set(result.data.files.map((f) => f.filePath));
    assert.ok(paths.has('install.sh'));
    assert.ok(paths.has('README.md'));
    assert.ok(paths.has('.env.example'));
  });
});
