/**
 * Proto enriched-output integration test (iteration path) — F-08 review fix #2.
 *
 * The original `proto-enriched.test.ts` only covered `agent.execute()`'s legacy
 * text-generation path. ProtoAgent has *three* push paths and the PR claims
 * the enricher runs in all three; the iteration path
 * (`executeIteration` — ProtoAgent.ts:409..522) was untested.
 *
 * What this drives end-to-end:
 *   1. `ProtoInput.iterationRequest` + `existingFiles` triggers the iteration
 *      branch in `execute()` (ProtoAgent.ts:292-294).
 *   2. The mocked AI returns a JSON `files` array (no install.sh, no README,
 *      no Dockerfile, no .env.example).
 *   3. ProtoAgent runs `applyEnrichment` on the iteration output.
 *   4. The capturing GitHub adapter records what `pushFiles` actually receives.
 *   5. We assert install.sh + README + .env.example + Dockerfile +
 *      docker-compose.yml all show up in the bytes pushed to GitHub.
 *
 * If the enricher were wired only into the legacy path (the F-08 regression
 * this test guards against), the captured push would NOT contain install.sh,
 * the assertion fails, and the iteration regression is caught.
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
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Bakkal panelde', when: 'Yeni borç ekler', then: 'Borç kaydedilir ve listede görünür' },
  ],
  technicalConstraints: { stack: 'React + Vite', integrations: [], nonFunctional: [] },
  outOfScope: [],
};

// AI iteration response — modifies a couple of files and returns the full
// (modified + unchanged) set, but no portability files.
const iterationAiResponse = JSON.stringify({
  files: [
    {
      filePath: 'package.json',
      content: '{"name":"veresiye","scripts":{"dev":"vite","build":"vite build","preview":"vite preview"}}',
      linesOfCode: 1,
    },
    { filePath: 'index.html', content: '<!doctype html><html><body><div id="root"></div></body></html>', linesOfCode: 1 },
    { filePath: 'src/main.jsx', content: 'console.log("hi");', linesOfCode: 1 },
    { filePath: 'src/App.jsx', content: 'export default function App(){return <div>Borç Listesi</div>;}', linesOfCode: 1 },
    { filePath: 'src/App.css', content: 'body{font-family:sans-serif}', linesOfCode: 1 },
  ],
  setupCommands: ['npm install', 'npm run dev'],
  metadata: { filesCreated: 5, totalLinesOfCode: 5, stackUsed: 'React + Vite' },
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
      'package.json', 'index.html', 'src/main.jsx', 'src/App.jsx', 'src/App.css',
      'install.sh', 'README.md', '.env.example', 'Dockerfile', 'docker-compose.yml',
    ],
  };
  return out;
}

function iterationInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec,
    repoName: 'veresiye',
    repoVisibility: 'private',
    owner: 'testuser',
    iterationRequest: 'Borç ekleme formuna tutar alanı ekle',
    existingFiles: [
      { path: 'package.json', content: '{"name":"veresiye","scripts":{"dev":"vite"}}' },
      { path: 'src/App.jsx', content: 'export default function App(){return <div>Hi</div>;}' },
    ],
    ...overrides,
  };
}

describe('ProtoAgent + ScaffoldEnricher integration — iteration path (F-08)', () => {
  it('executeIteration() pushes enriched files including install.sh', async () => {
    const ai = createMockAI(iterationAiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(iterationInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    const pushed = github.capturedPush;
    assert.ok(pushed, 'pushFiles should have been called by the iteration path');
    const pathSet = new Set(pushed.files.map((f) => f.path));

    assert.ok(pathSet.has('install.sh'), 'install.sh must be in iteration push payload');
    assert.ok(pathSet.has('README.md'), 'README.md must be in iteration push payload');
    assert.ok(pathSet.has('.env.example'), '.env.example must be in iteration push payload');
    assert.ok(pathSet.has('Dockerfile'), 'Dockerfile must be in iteration push payload');
    assert.ok(pathSet.has('docker-compose.yml'), 'compose must be in iteration push payload');
  });

  it('executeIteration() README.md contains all three Turkish bakkal sections', async () => {
    const ai = createMockAI(iterationAiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(iterationInput());
    const readme = github.capturedPush?.files.find((f) => f.path === 'README.md');
    assert.ok(readme, 'README.md should be present in iteration push');
    assert.match(readme.content, /## Bu projeyi kendi bilgisayarında çalıştır/);
    assert.match(readme.content, /## Sunucuya kur/);
    assert.match(readme.content, /## GitHub'da gör/);
  });

  it('executeIteration() install.sh contains AKIS header + npm dev command', async () => {
    const ai = createMockAI(iterationAiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    await agent.execute(iterationInput());
    const sh = github.capturedPush?.files.find((f) => f.path === 'install.sh');
    assert.ok(sh, 'install.sh should be present in iteration push');
    assert.match(sh.content, /Bu komut dosyası AKIS tarafından üretildi/);
    assert.match(sh.content, /npm install/);
    assert.match(sh.content, /npm run dev/);
  });

  it('executeIteration() result.data.files reports the enriched count', async () => {
    const ai = createMockAI(iterationAiResponse);
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github);

    const result = await agent.execute(iterationInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    // AI returned 5 files; enrichment adds install.sh + README.md +
    // .env.example + Dockerfile + docker-compose.yml = 5 more.
    assert.ok(
      result.data.files.length >= 5,
      'enriched count should not drop AI files',
    );
    const enrichedPaths = new Set(result.data.files.map((f) => f.filePath));
    assert.ok(enrichedPaths.has('install.sh'));
    assert.ok(enrichedPaths.has('README.md'));
    assert.ok(enrichedPaths.has('.env.example'));
    assert.equal(
      result.data.metadata.filesCreated,
      result.data.files.length,
      'metadata.filesCreated must match the post-enrichment files length',
    );
  });
});
